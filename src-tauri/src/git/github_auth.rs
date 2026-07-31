use parking_lot::RwLock;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use uuid::Uuid;

const KEYRING_SERVICE: &str = "com.ccie.terminal.github";
const KEYRING_ACCOUNT: &str = "github.com-oauth-token";
const DEFAULT_WEB_BASE: &str = "https://github.com";
const DEFAULT_API_BASE: &str = "https://api.github.com";
const GITHUB_API_VERSION: &str = "2022-11-28";

pub trait GitHubCredentialStore: Send + Sync {
    fn save(&self, token: &str) -> Result<(), String>;
    fn load(&self) -> Result<Option<String>, String>;
    fn delete(&self) -> Result<(), String>;
}

#[derive(Default)]
pub struct OsGitHubCredentialStore;

impl GitHubCredentialStore for OsGitHubCredentialStore {
    fn save(&self, token: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(|error| format!("Platform credential service is unavailable: {error}"))?;
        entry
            .set_password(token)
            .map_err(|error| format!("Platform credential service rejected the token: {error}"))
    }

    fn load(&self) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(|error| format!("Platform credential service is unavailable: {error}"))?;
        match entry.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!(
                "Platform credential service could not read the GitHub connection: {error}"
            )),
        }
    }

    fn delete(&self) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(|error| format!("Platform credential service is unavailable: {error}"))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!(
                "Platform credential service could not remove the GitHub connection: {error}"
            )),
        }
    }
}

#[derive(Clone, Default)]
pub struct InMemoryGitHubCredentialStore {
    token: Arc<RwLock<Option<String>>>,
}

impl GitHubCredentialStore for InMemoryGitHubCredentialStore {
    fn save(&self, token: &str) -> Result<(), String> {
        *self.token.write() = Some(token.to_string());
        Ok(())
    }

    fn load(&self) -> Result<Option<String>, String> {
        Ok(self.token.read().clone())
    }

    fn delete(&self) -> Result<(), String> {
        *self.token.write() = None;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TokenStorage {
    Keyring,
    Session,
}

impl TokenStorage {
    fn label(self) -> &'static str {
        match self {
            Self::Keyring => "keyring",
            Self::Session => "session",
        }
    }
}

#[derive(Clone)]
struct ActiveToken {
    value: String,
    storage: TokenStorage,
}

#[derive(Clone)]
struct PendingDeviceAuthorization {
    id: String,
    device_code: String,
    expires_at: Instant,
    interval: Duration,
    next_poll_at: Instant,
    session_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubDeviceAuthorization {
    pub authorization_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAccount {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub storage: String,
    pub storage_warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAuthPollResult {
    pub status: String,
    pub account: Option<GitHubAccount>,
    pub retry_after: Option<u64>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepository {
    pub id: u64,
    pub name: String,
    pub full_name: String,
    pub description: Option<String>,
    pub private: bool,
    pub html_url: String,
    pub clone_url: String,
    pub ssh_url: String,
    pub default_branch: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepositoryPage {
    pub repositories: Vec<GitHubRepository>,
    pub page: u32,
    pub has_more: bool,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Deserialize)]
struct AccessTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
    interval: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct AccountResponse {
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RepositoryResponse {
    id: u64,
    name: String,
    full_name: String,
    description: Option<String>,
    private: bool,
    html_url: String,
    clone_url: String,
    ssh_url: String,
    default_branch: String,
    updated_at: Option<String>,
}

impl From<RepositoryResponse> for GitHubRepository {
    fn from(value: RepositoryResponse) -> Self {
        Self {
            id: value.id,
            name: value.name,
            full_name: value.full_name,
            description: value.description,
            private: value.private,
            html_url: value.html_url,
            clone_url: value.clone_url,
            ssh_url: value.ssh_url,
            default_branch: value.default_branch,
            updated_at: value.updated_at,
        }
    }
}

pub struct GitHubAuthManager {
    client: Client,
    client_id: Option<String>,
    web_base: String,
    api_base: String,
    credentials: Arc<dyn GitHubCredentialStore>,
    active_token: RwLock<Option<ActiveToken>>,
    pending: Mutex<Option<PendingDeviceAuthorization>>,
}

impl Default for GitHubAuthManager {
    fn default() -> Self {
        Self::production()
    }
}

impl GitHubAuthManager {
    pub fn production() -> Self {
        let client_id = std::env::var("TERMINAI_GITHUB_CLIENT_ID")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| option_env!("TERMINAI_GITHUB_CLIENT_ID").map(str::to_string));
        Self::new(
            client_id,
            DEFAULT_WEB_BASE.to_string(),
            DEFAULT_API_BASE.to_string(),
            Arc::new(OsGitHubCredentialStore),
        )
    }

    pub fn new(
        client_id: Option<String>,
        web_base: String,
        api_base: String,
        credentials: Arc<dyn GitHubCredentialStore>,
    ) -> Self {
        let client = Client::builder()
            .user_agent(format!("TerminAI/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("GitHub HTTP client");
        Self {
            client,
            client_id,
            web_base: web_base.trim_end_matches('/').to_string(),
            api_base: api_base.trim_end_matches('/').to_string(),
            credentials,
            active_token: RwLock::new(None),
            pending: Mutex::new(None),
        }
    }

    pub async fn start_device_flow(
        &self,
        session_only: bool,
    ) -> Result<GitHubDeviceAuthorization, String> {
        let client_id = self.client_id()?;
        let response = self
            .client
            .post(format!("{}/login/device/code", self.web_base))
            .header("Accept", "application/json")
            .form(&[("client_id", client_id), ("scope", "repo read:user")])
            .send()
            .await
            .map_err(|error| format!("Could not reach GitHub for device login: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "GitHub device login failed with HTTP {}",
                response.status()
            ));
        }
        let response = response
            .json::<DeviceCodeResponse>()
            .await
            .map_err(|error| {
                format!("GitHub returned an invalid device-login response: {error}")
            })?;
        let id = Uuid::new_v4().to_string();
        let interval = Duration::from_secs(response.interval.max(1));
        *self.pending.lock().await = Some(PendingDeviceAuthorization {
            id: id.clone(),
            device_code: response.device_code,
            expires_at: Instant::now() + Duration::from_secs(response.expires_in),
            interval,
            next_poll_at: Instant::now() + interval,
            session_only,
        });
        Ok(GitHubDeviceAuthorization {
            authorization_id: id,
            user_code: response.user_code,
            verification_uri: response.verification_uri,
            expires_in: response.expires_in,
            interval: response.interval.max(1),
        })
    }

    pub async fn poll_device_flow(
        &self,
        authorization_id: &str,
    ) -> Result<GitHubAuthPollResult, String> {
        let pending = {
            let mut guard = self.pending.lock().await;
            let Some(pending) = guard.as_mut() else {
                return Ok(auth_result(
                    "cancelled",
                    None,
                    None,
                    "Device login was cancelled",
                ));
            };
            if pending.id != authorization_id {
                return Err("Device login session no longer matches".to_string());
            }
            let now = Instant::now();
            if now >= pending.expires_at {
                *guard = None;
                return Ok(auth_result(
                    "expired",
                    None,
                    None,
                    "The GitHub code expired",
                ));
            }
            if now < pending.next_poll_at {
                let retry = pending.next_poll_at.duration_since(now).as_secs().max(1);
                return Ok(auth_result(
                    "pending",
                    Some(retry),
                    None,
                    "Waiting for GitHub authorization",
                ));
            }
            pending.next_poll_at = now + pending.interval;
            pending.clone()
        };

        let client_id = self.client_id()?;
        let response = self
            .client
            .post(format!("{}/login/oauth/access_token", self.web_base))
            .header("Accept", "application/json")
            .form(&[
                ("client_id", client_id),
                ("device_code", pending.device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await
            .map_err(|error| format!("Could not poll GitHub device login: {error}"))?;
        let response = response
            .json::<AccessTokenResponse>()
            .await
            .map_err(|error| format!("GitHub returned an invalid token response: {error}"))?;

        if let Some(token) = response.access_token {
            let (storage, storage_warning) = if pending.session_only {
                (TokenStorage::Session, None)
            } else {
                match self.credentials.save(&token) {
                    Ok(()) => (TokenStorage::Keyring, None),
                    Err(error) => (
                        TokenStorage::Session,
                        Some(format!(
                            "Secure storage was unavailable; this GitHub connection lasts only until TerminAI closes. {error}"
                        )),
                    ),
                }
            };
            *self.active_token.write() = Some(ActiveToken {
                value: token.clone(),
                storage,
            });
            *self.pending.lock().await = None;
            let account = self
                .account_for_token(&token, storage, storage_warning)
                .await?;
            return Ok(GitHubAuthPollResult {
                status: "connected".to_string(),
                account: Some(account),
                retry_after: None,
                message: None,
            });
        }

        let error = response.error.as_deref().unwrap_or("authorization_pending");
        match error {
            "authorization_pending" => Ok(auth_result(
                "pending",
                Some(pending.interval.as_secs()),
                None,
                "Waiting for GitHub authorization",
            )),
            "slow_down" => {
                let mut guard = self.pending.lock().await;
                if let Some(current) = guard.as_mut().filter(|current| current.id == pending.id) {
                    current.interval = Duration::from_secs(
                        response.interval.unwrap_or(current.interval.as_secs() + 5),
                    );
                    current.next_poll_at = Instant::now() + current.interval;
                }
                Ok(auth_result(
                    "slowDown",
                    Some(response.interval.unwrap_or(pending.interval.as_secs() + 5)),
                    None,
                    "GitHub asked TerminAI to poll more slowly",
                ))
            }
            "access_denied" => {
                *self.pending.lock().await = None;
                Ok(auth_result(
                    "denied",
                    None,
                    None,
                    response
                        .error_description
                        .as_deref()
                        .unwrap_or("GitHub authorization was denied"),
                ))
            }
            "expired_token" => {
                *self.pending.lock().await = None;
                Ok(auth_result(
                    "expired",
                    None,
                    None,
                    "The GitHub code expired",
                ))
            }
            other => {
                *self.pending.lock().await = None;
                Err(format!(
                    "GitHub device login failed: {}",
                    response
                        .error_description
                        .unwrap_or_else(|| other.to_string())
                ))
            }
        }
    }

    pub async fn cancel_device_flow(&self, authorization_id: &str) {
        let mut pending = self.pending.lock().await;
        if pending
            .as_ref()
            .is_some_and(|pending| pending.id == authorization_id)
        {
            *pending = None;
        }
    }

    pub async fn account_status(&self) -> Result<Option<GitHubAccount>, String> {
        let Some(active) = self.load_active_token()? else {
            return Ok(None);
        };
        self.account_for_token(&active.value, active.storage, None)
            .await
            .map(Some)
    }

    pub async fn list_repositories(
        &self,
        page: u32,
        query: Option<&str>,
    ) -> Result<GitHubRepositoryPage, String> {
        let active = self
            .load_active_token()?
            .ok_or_else(|| "Connect a GitHub account first".to_string())?;
        let page = page.max(1);
        let query = query.map(str::trim).filter(|query| !query.is_empty());

        if query.is_none() {
            let repositories = self.repository_page(&active.value, page).await?;
            let has_more = repositories.len() == 100;
            return Ok(GitHubRepositoryPage {
                repositories,
                page,
                has_more,
            });
        }

        let query = query.unwrap().to_lowercase();
        let mut matches = Vec::new();
        let mut source_page = 1;
        let wanted_start = (page as usize - 1) * 100;
        let wanted_end = wanted_start + 101;
        loop {
            let repositories = self.repository_page(&active.value, source_page).await?;
            let exhausted = repositories.len() < 100;
            matches.extend(repositories.into_iter().filter(|repository| {
                repository.full_name.to_lowercase().contains(&query)
                    || repository
                        .description
                        .as_deref()
                        .is_some_and(|description| description.to_lowercase().contains(&query))
            }));
            if exhausted || matches.len() >= wanted_end || source_page >= 10 {
                break;
            }
            source_page += 1;
        }
        let has_more = matches.len() > wanted_start + 100;
        let repositories = matches.into_iter().skip(wanted_start).take(100).collect();
        Ok(GitHubRepositoryPage {
            repositories,
            page,
            has_more,
        })
    }

    pub fn token_for_git(&self) -> Result<Option<String>, String> {
        Ok(self.load_active_token()?.map(|token| token.value))
    }

    pub fn migrate_legacy_token(&self, token: &str) -> Result<bool, String> {
        if token.trim().is_empty() {
            return Ok(true);
        }
        if self.credentials.load()?.is_some() {
            return Ok(true);
        }
        self.credentials.save(token)?;
        *self.active_token.write() = Some(ActiveToken {
            value: token.to_string(),
            storage: TokenStorage::Keyring,
        });
        Ok(true)
    }

    pub fn has_secure_token(&self) -> Result<bool, String> {
        Ok(self.credentials.load()?.is_some())
    }

    pub fn disconnect(&self) -> Result<(), String> {
        let active = self.active_token.write().take();
        if active.is_some_and(|token| token.storage == TokenStorage::Session) {
            return Ok(());
        }
        self.credentials.delete()
    }

    async fn repository_page(
        &self,
        token: &str,
        page: u32,
    ) -> Result<Vec<GitHubRepository>, String> {
        let response = self
            .api_request(token, format!("{}/user/repos", self.api_base))
            .query(&[
                ("per_page", "100".to_string()),
                ("page", page.to_string()),
                ("sort", "updated".to_string()),
                ("direction", "desc".to_string()),
                (
                    "affiliation",
                    "owner,collaborator,organization_member".to_string(),
                ),
            ])
            .send()
            .await
            .map_err(|error| format!("Could not list GitHub repositories: {error}"))?;
        github_status(&response, "list repositories").await?;
        response
            .json::<Vec<RepositoryResponse>>()
            .await
            .map(|repositories| repositories.into_iter().map(Into::into).collect())
            .map_err(|error| format!("GitHub returned an invalid repository list: {error}"))
    }

    async fn account_for_token(
        &self,
        token: &str,
        storage: TokenStorage,
        storage_warning: Option<String>,
    ) -> Result<GitHubAccount, String> {
        let response = self
            .api_request(token, format!("{}/user", self.api_base))
            .send()
            .await
            .map_err(|error| format!("Could not load the GitHub account: {error}"))?;
        github_status(&response, "load account").await?;
        let account = response
            .json::<AccountResponse>()
            .await
            .map_err(|error| format!("GitHub returned an invalid account response: {error}"))?;
        Ok(GitHubAccount {
            login: account.login,
            name: account.name,
            avatar_url: account.avatar_url,
            storage: storage.label().to_string(),
            storage_warning,
        })
    }

    fn api_request(&self, token: &str, url: String) -> reqwest::RequestBuilder {
        self.client
            .get(url)
            .bearer_auth(token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
    }

    fn client_id(&self) -> Result<&str, String> {
        self.client_id.as_deref().ok_or_else(|| {
            "GitHub login is not configured in this build. Set TERMINAI_GITHUB_CLIENT_ID to the public client ID of the TerminAI OAuth App (device flow enabled).".to_string()
        })
    }

    fn load_active_token(&self) -> Result<Option<ActiveToken>, String> {
        if let Some(token) = self.active_token.read().clone() {
            return Ok(Some(token));
        }
        let Some(token) = self.credentials.load()? else {
            return Ok(None);
        };
        let active = ActiveToken {
            value: token,
            storage: TokenStorage::Keyring,
        };
        *self.active_token.write() = Some(active.clone());
        Ok(Some(active))
    }
}

fn auth_result(
    status: &str,
    retry_after: Option<u64>,
    account: Option<GitHubAccount>,
    message: &str,
) -> GitHubAuthPollResult {
    GitHubAuthPollResult {
        status: status.to_string(),
        account,
        retry_after,
        message: Some(message.to_string()),
    }
}

async fn github_status(response: &reqwest::Response, action: &str) -> Result<(), String> {
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let message = match status {
        StatusCode::UNAUTHORIZED => "GitHub rejected the saved connection. Reconnect your account.",
        StatusCode::FORBIDDEN => "GitHub denied the request or its API rate limit was reached.",
        _ => "GitHub returned an error.",
    };
    Err(format!("Could not {action} (HTTP {status}): {message}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    struct FailingStore;

    impl GitHubCredentialStore for FailingStore {
        fn save(&self, _token: &str) -> Result<(), String> {
            Err("locked keyring".into())
        }
        fn load(&self) -> Result<Option<String>, String> {
            Ok(None)
        }
        fn delete(&self) -> Result<(), String> {
            Ok(())
        }
    }

    fn manager(server: &MockServer, store: Arc<dyn GitHubCredentialStore>) -> GitHubAuthManager {
        GitHubAuthManager::new(
            Some("public-client-id".into()),
            server.uri(),
            server.uri(),
            store,
        )
    }

    async fn seed_pending(manager: &GitHubAuthManager, session_only: bool) -> String {
        let id = Uuid::new_v4().to_string();
        *manager.pending.lock().await = Some(PendingDeviceAuthorization {
            id: id.clone(),
            device_code: "device-code".into(),
            expires_at: Instant::now() + Duration::from_secs(900),
            interval: Duration::from_secs(1),
            next_poll_at: Instant::now() - Duration::from_millis(1),
            session_only,
        });
        id
    }

    #[test]
    fn in_memory_store_round_trips_and_disconnects() {
        let store = Arc::new(InMemoryGitHubCredentialStore::default());
        let manager = GitHubAuthManager::new(
            Some("client".into()),
            DEFAULT_WEB_BASE.into(),
            DEFAULT_API_BASE.into(),
            store.clone(),
        );
        manager.migrate_legacy_token("secret").unwrap();
        assert_eq!(store.load().unwrap().as_deref(), Some("secret"));
        assert_eq!(manager.token_for_git().unwrap().as_deref(), Some("secret"));
        manager.disconnect().unwrap();
        assert!(store.load().unwrap().is_none());
    }

    #[test]
    fn legacy_token_is_not_accepted_when_secure_storage_fails() {
        let manager = GitHubAuthManager::new(
            Some("client".into()),
            DEFAULT_WEB_BASE.into(),
            DEFAULT_API_BASE.into(),
            Arc::new(FailingStore),
        );
        assert!(manager.migrate_legacy_token("legacy").is_err());
        assert!(manager.token_for_git().unwrap().is_none());
    }

    #[test]
    fn missing_public_client_id_has_an_actionable_error() {
        let manager = GitHubAuthManager::new(
            None,
            DEFAULT_WEB_BASE.into(),
            DEFAULT_API_BASE.into(),
            Arc::new(InMemoryGitHubCredentialStore::default()),
        );
        assert!(manager
            .client_id()
            .unwrap_err()
            .contains("TERMINAI_GITHUB_CLIENT_ID"));
    }

    #[tokio::test]
    async fn device_authorization_requests_scopes_and_can_be_cancelled() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login/device/code"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "device_code": "device-code",
                "user_code": "ABCD-EFGH",
                "verification_uri": "https://github.com/login/device",
                "expires_in": 900,
                "interval": 5
            })))
            .mount(&server)
            .await;
        let manager = manager(&server, Arc::new(InMemoryGitHubCredentialStore::default()));

        let authorization = manager.start_device_flow(false).await.unwrap();
        assert_eq!(authorization.user_code, "ABCD-EFGH");
        let requests = server.received_requests().await.unwrap();
        let body = String::from_utf8_lossy(&requests[0].body);
        assert!(body.contains("client_id=public-client-id"));
        assert!(body.contains("repo") && body.contains("read%3Auser"));

        manager
            .cancel_device_flow(&authorization.authorization_id)
            .await;
        let cancelled = manager
            .poll_device_flow(&authorization.authorization_id)
            .await
            .unwrap();
        assert_eq!(cancelled.status, "cancelled");
    }

    #[tokio::test]
    async fn successful_device_flow_uses_labeled_session_fallback_when_keyring_fails() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "access_token": "gho_secret" })),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/user"))
            .and(header("authorization", "Bearer gho_secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "login": "octocat",
                "name": "The Octocat",
                "avatar_url": "https://avatars.example/octocat"
            })))
            .mount(&server)
            .await;
        let manager = manager(&server, Arc::new(FailingStore));
        let authorization_id = seed_pending(&manager, false).await;

        let result = manager.poll_device_flow(&authorization_id).await.unwrap();

        assert_eq!(result.status, "connected");
        let account = result.account.unwrap();
        assert_eq!(account.login, "octocat");
        assert_eq!(account.storage, "session");
        assert!(account
            .storage_warning
            .as_deref()
            .is_some_and(|warning| warning.contains("lasts only until TerminAI closes")));
        assert_eq!(
            manager.token_for_git().unwrap().as_deref(),
            Some("gho_secret")
        );
        manager.disconnect().unwrap();
        assert!(manager.token_for_git().unwrap().is_none());
    }

    #[tokio::test]
    async fn polling_handles_pending_slowdown_denied_and_expired_states() {
        async fn poll_error(error: &str, interval: Option<u64>) -> GitHubAuthPollResult {
            let server = MockServer::start().await;
            let mut body = json!({ "error": error });
            if let Some(interval) = interval {
                body["interval"] = json!(interval);
            }
            Mock::given(method("POST"))
                .and(path("/login/oauth/access_token"))
                .respond_with(ResponseTemplate::new(200).set_body_json(body))
                .mount(&server)
                .await;
            let manager = manager(&server, Arc::new(InMemoryGitHubCredentialStore::default()));
            let id = seed_pending(&manager, false).await;
            manager.poll_device_flow(&id).await.unwrap()
        }

        assert_eq!(
            poll_error("authorization_pending", None).await.status,
            "pending"
        );
        let slowdown = poll_error("slow_down", Some(7)).await;
        assert_eq!(slowdown.status, "slowDown");
        assert_eq!(slowdown.retry_after, Some(7));
        assert_eq!(poll_error("access_denied", None).await.status, "denied");

        let server = MockServer::start().await;
        let manager = manager(&server, Arc::new(InMemoryGitHubCredentialStore::default()));
        let id = seed_pending(&manager, false).await;
        manager.pending.lock().await.as_mut().unwrap().expires_at =
            Instant::now() - Duration::from_millis(1);
        assert_eq!(
            manager.poll_device_flow(&id).await.unwrap().status,
            "expired"
        );
    }

    #[tokio::test]
    async fn account_repository_pagination_stays_backend_authenticated() {
        let server = MockServer::start().await;
        let store = Arc::new(InMemoryGitHubCredentialStore::default());
        store.save("gho_secret").unwrap();
        let repositories = (0..100)
            .map(|index| {
                json!({
                    "id": index + 1,
                    "name": format!("repo-{index}"),
                    "full_name": format!("octocat/repo-{index}"),
                    "description": null,
                    "private": index % 2 == 0,
                    "html_url": format!("https://github.com/octocat/repo-{index}"),
                    "clone_url": format!("https://github.com/octocat/repo-{index}.git"),
                    "ssh_url": format!("git@github.com:octocat/repo-{index}.git"),
                    "default_branch": "main",
                    "updated_at": "2026-07-31T00:00:00Z"
                })
            })
            .collect::<Vec<_>>();
        Mock::given(method("GET"))
            .and(path("/user/repos"))
            .and(header("authorization", "Bearer gho_secret"))
            .and(query_param("per_page", "100"))
            .and(query_param("page", "2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(repositories))
            .mount(&server)
            .await;
        let manager = manager(&server, store);

        let page = manager.list_repositories(2, None).await.unwrap();

        assert_eq!(page.page, 2);
        assert_eq!(page.repositories.len(), 100);
        assert!(page.has_more);
        assert_eq!(page.repositories[0].full_name, "octocat/repo-0");
    }
}
