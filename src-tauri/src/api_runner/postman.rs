//! Read-only Postman Collection v2.1 parsing and coordinated import.
//!
//! Preview types intentionally contain keys and counts only. Credential values
//! stay inside the normalized import and are written only to the environment
//! store during commit.

use crate::api_runner::env_store::{self, EnvVar};
use crate::api_runner::history::{self, SavedRequestRow};
use crate::api_runner::types::ApiAuth;
use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use uuid::Uuid;

const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;
const MAX_REQUESTS: usize = 2_000;
const MAX_FOLDER_DEPTH: usize = 20;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PostmanVariableSummary {
    pub key: String,
    pub is_secret: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PostmanSkippedItem {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PostmanImportPreview {
    pub fingerprint: String,
    pub collection_name: String,
    pub request_count: usize,
    pub folder_count: usize,
    pub variable_keys: Vec<PostmanVariableSummary>,
    pub skipped_items: Vec<PostmanSkippedItem>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PostmanImportResult {
    pub collection_id: String,
    pub collection_name: String,
    pub environment: String,
    pub imported_count: usize,
    pub skipped_count: usize,
    pub warnings: Vec<String>,
}

/// Value-free metadata used to merge imported collections into the Target
/// picker. Environment variable values never cross this interface.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PostmanCollectionSummary {
    pub id: String,
    pub name: String,
    pub environment: String,
    pub request_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct PostmanCollectionDetail {
    pub collection: PostmanCollectionSummary,
    pub requests: Vec<SavedRequestRow>,
}

#[derive(Debug, Clone)]
struct NormalizedRequest {
    display_name: String,
    folder_path: String,
    method: String,
    url: String,
    headers_json: String,
    query_json: String,
    body_kind: String,
    body_text: Option<String>,
    auth_json: String,
    ordinal: usize,
}

#[derive(Debug)]
struct NormalizedImport {
    fingerprint: String,
    collection_name: String,
    source_file_name: String,
    folder_count: usize,
    variables: BTreeMap<String, EnvVar>,
    requests: Vec<NormalizedRequest>,
    skipped_items: Vec<PostmanSkippedItem>,
    warnings: BTreeSet<String>,
}

#[derive(Default, Clone)]
struct VariableContext {
    postman_to_env: BTreeMap<String, String>,
}

struct Parser {
    variables: BTreeMap<String, EnvVar>,
    requests: Vec<NormalizedRequest>,
    skipped_items: Vec<PostmanSkippedItem>,
    warnings: BTreeSet<String>,
    folder_count: usize,
    seen_requests: usize,
}

impl Parser {
    fn new() -> Self {
        Self {
            variables: BTreeMap::new(),
            requests: Vec::new(),
            skipped_items: Vec::new(),
            warnings: BTreeSet::new(),
            folder_count: 0,
            seen_requests: 0,
        }
    }

    fn add_variable(&mut self, candidate: &str, value: String, is_secret: bool) -> Result<String> {
        env_store::validate_value(&value)?;
        let base = normalize_env_key(candidate);
        let mut key = base.clone();
        let mut suffix = 2usize;
        loop {
            match self.variables.get_mut(&key) {
                Some(existing) if existing.value == value => {
                    existing.is_secret |= is_secret;
                    return Ok(key);
                }
                Some(_) => {
                    key = suffixed_env_key(&base, suffix);
                    suffix += 1;
                }
                None => {
                    self.variables.insert(
                        key.clone(),
                        EnvVar {
                            key: key.clone(),
                            value,
                            is_secret,
                        },
                    );
                    return Ok(key);
                }
            }
        }
    }

    fn mark_secret(&mut self, key: &str) {
        if let Some(variable) = self.variables.get_mut(key) {
            variable.is_secret = true;
        }
    }

    fn apply_variables(
        &mut self,
        raw: Option<&Value>,
        scope: &str,
        context: &mut VariableContext,
    ) -> Result<()> {
        let Some(entries) = raw.and_then(Value::as_array) else {
            return Ok(());
        };
        for entry in entries {
            if entry
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                continue;
            }
            let Some(raw_key) = entry.get("key").and_then(Value::as_str) else {
                self.warnings
                    .insert("A variable without a key was ignored.".into());
                continue;
            };
            let value = scalar_to_string(entry.get("value")).unwrap_or_default();
            let secret = entry.get("type").and_then(Value::as_str) == Some("secret")
                || is_credential_key(raw_key);
            let candidate = if scope.is_empty() {
                raw_key.to_string()
            } else {
                format!("{scope}_{raw_key}")
            };
            let env_key = self.add_variable(&candidate, value, secret)?;
            context.postman_to_env.insert(raw_key.to_string(), env_key);
        }
        Ok(())
    }

    fn rewrite(&mut self, text: &str, context: &VariableContext, path: &str) -> Result<String> {
        let mut output = String::with_capacity(text.len());
        let mut remaining = text;
        while let Some(start) = remaining.find("{{") {
            output.push_str(&remaining[..start]);
            let after_open = &remaining[start + 2..];
            let Some(end) = after_open.find("}}") else {
                output.push_str(&remaining[start..]);
                return Ok(output);
            };
            let raw_key = after_open[..end].trim();
            let env_key = if let Some(key) = context.postman_to_env.get(raw_key) {
                key.clone()
            } else {
                let key = self.add_variable(raw_key, String::new(), is_credential_key(raw_key))?;
                self.warnings.insert(format!(
                    "{path}: variable key '{}' had no value; an empty environment entry was created.",
                    safe_label(raw_key)
                ));
                key
            };
            output.push_str("${env:");
            output.push_str(&env_key);
            output.push('}');
            remaining = &after_open[end + 2..];
        }
        output.push_str(remaining);
        Ok(output)
    }

    fn credential_reference(
        &mut self,
        value: &str,
        context: &VariableContext,
        scope: &str,
        label: &str,
        path: &str,
    ) -> Result<String> {
        let rewritten = self.rewrite(value, context, path)?;
        let referenced = extract_env_keys(&rewritten);
        if !referenced.is_empty() {
            for key in referenced {
                self.mark_secret(&key);
            }
            return Ok(rewritten);
        }
        let key = self.add_variable(&format!("{scope}_{label}"), value.to_string(), true)?;
        Ok(format!("${{env:{key}}}"))
    }

    fn note_executable_features(&mut self, node: &Value, path: &str) {
        if let Some(events) = node.get("event").and_then(Value::as_array) {
            for _ in events {
                self.skipped_items.push(PostmanSkippedItem {
                    path: path.to_string(),
                    reason: "Postman script ignored; executable code is never imported.".into(),
                });
            }
        }
        if !node
            .get("response")
            .and_then(Value::as_array)
            .unwrap_or(&Vec::new())
            .is_empty()
        {
            self.skipped_items.push(PostmanSkippedItem {
                path: path.to_string(),
                reason: "Saved examples ignored.".into(),
            });
        }
    }

    fn walk_items(
        &mut self,
        items: &[Value],
        folders: &[String],
        depth: usize,
        inherited_auth: Option<Value>,
        inherited_context: &VariableContext,
    ) -> Result<()> {
        if depth > MAX_FOLDER_DEPTH {
            return Err(anyhow!(
                "Postman folders exceed the {MAX_FOLDER_DEPTH}-level limit"
            ));
        }
        for item in items {
            let name = safe_label(
                item.get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Unnamed item"),
            );
            let mut path_parts = folders.to_vec();
            path_parts.push(name.clone());
            let item_path = path_parts.join(" / ");
            self.note_executable_features(item, &item_path);

            if let Some(children) = item.get("item").and_then(Value::as_array) {
                self.folder_count += 1;
                let mut context = inherited_context.clone();
                self.apply_variables(item.get("variable"), &scope_key(&path_parts), &mut context)?;
                let auth = effective_auth(item.get("auth"), inherited_auth.clone());
                self.walk_items(children, &path_parts, depth + 1, auth, &context)?;
                continue;
            }

            let Some(request) = item.get("request") else {
                self.skipped_items.push(PostmanSkippedItem {
                    path: item_path,
                    reason: "Item has no request.".into(),
                });
                continue;
            };
            self.seen_requests += 1;
            if self.seen_requests > MAX_REQUESTS {
                return Err(anyhow!(
                    "Postman collection exceeds the {MAX_REQUESTS}-request limit"
                ));
            }
            let mut context = inherited_context.clone();
            self.apply_variables(item.get("variable"), &scope_key(&path_parts), &mut context)?;
            let auth = effective_auth(request.get("auth"), inherited_auth.clone());
            match self.normalize_request(request, &name, folders, &item_path, auth, &mut context) {
                Ok(normalized) => self.requests.push(normalized),
                Err(reason) => self.skipped_items.push(PostmanSkippedItem {
                    path: item_path,
                    reason: reason.to_string(),
                }),
            }
        }
        Ok(())
    }

    fn normalize_request(
        &mut self,
        request: &Value,
        display_name: &str,
        folders: &[String],
        path: &str,
        auth: Option<Value>,
        context: &mut VariableContext,
    ) -> Result<NormalizedRequest> {
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("GET")
            .to_uppercase();
        if !matches!(
            method.as_str(),
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"
        ) {
            return Err(anyhow!("Unsupported HTTP method: {}", safe_label(&method)));
        }
        let scope = scope_key(
            &folders
                .iter()
                .cloned()
                .chain([display_name.to_string()])
                .collect::<Vec<_>>(),
        );
        let (url, mut query) = self.normalize_url(request.get("url"), context, &scope, path)?;
        let mut headers = self.normalize_headers(request.get("header"), context, path)?;
        let (mut body_kind, mut body_text) =
            self.normalize_body(request.get("body"), context, &scope, path)?;

        let auth_value = self.normalize_auth(auth.as_ref(), context, &scope, path, &mut query)?;
        self.extract_header_credentials(&mut headers, context, &scope, path)?;
        self.extract_query_credentials(&mut query, context, &scope, path)?;

        if body_kind == "json" {
            if let Some(text) = body_text.as_deref() {
                if let Ok(mut value) = serde_json::from_str::<Value>(text) {
                    self.extract_json_credentials(&mut value, context, &scope, path)?;
                    body_text = Some(serde_json::to_string(&value)?);
                }
            }
        }
        if body_kind == "none" {
            body_text = None;
        }
        Ok(NormalizedRequest {
            display_name: display_name.to_string(),
            folder_path: folders.join(" / "),
            method,
            url,
            headers_json: serde_json::to_string(&headers)?,
            query_json: serde_json::to_string(&query)?,
            body_kind: std::mem::take(&mut body_kind),
            body_text,
            auth_json: serde_json::to_string(&auth_value)?,
            ordinal: self.seen_requests,
        })
    }

    fn normalize_url(
        &mut self,
        raw_url: Option<&Value>,
        context: &mut VariableContext,
        scope: &str,
        path: &str,
    ) -> Result<(String, BTreeMap<String, String>)> {
        let value = raw_url.ok_or_else(|| anyhow!("Request URL is missing."))?;
        let mut raw = if let Some(text) = value.as_str() {
            text.to_string()
        } else {
            self.apply_variables(value.get("variable"), scope, context)?;
            if let Some(text) = value.get("raw").and_then(Value::as_str) {
                text.to_string()
            } else {
                structured_url(value)
            }
        };
        if let Some(variables) = value.get("variable").and_then(Value::as_array) {
            for variable in variables {
                if let Some(key) = variable.get("key").and_then(Value::as_str) {
                    if let Some(env_key) = context.postman_to_env.get(key) {
                        raw = raw.replace(&format!(":{key}"), &format!("${{env:{env_key}}}"));
                    }
                }
            }
        }
        raw = self.rewrite(&raw, context, path)?;
        let (base, raw_query) = raw.split_once('?').unwrap_or((&raw, ""));
        let url = base.split('#').next().unwrap_or(base).to_string();
        if url.trim().is_empty() {
            return Err(anyhow!("Request URL is empty."));
        }
        let mut query = BTreeMap::new();
        for (key, value) in url::form_urlencoded::parse(raw_query.as_bytes()) {
            query.insert(key.into_owned(), self.rewrite(&value, context, path)?);
        }
        if let Some(entries) = value.get("query").and_then(Value::as_array) {
            for entry in entries {
                if entry
                    .get("disabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    continue;
                }
                let Some(key) = entry.get("key").and_then(Value::as_str) else {
                    continue;
                };
                let value = scalar_to_string(entry.get("value")).unwrap_or_default();
                query.insert(
                    self.rewrite(key, context, path)?,
                    self.rewrite(&value, context, path)?,
                );
            }
        }
        Ok((url, query))
    }

    fn normalize_headers(
        &mut self,
        raw: Option<&Value>,
        context: &VariableContext,
        path: &str,
    ) -> Result<BTreeMap<String, String>> {
        let mut headers = BTreeMap::new();
        for entry in raw.and_then(Value::as_array).unwrap_or(&Vec::new()) {
            if entry
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                continue;
            }
            let Some(key) = entry.get("key").and_then(Value::as_str) else {
                continue;
            };
            let value = scalar_to_string(entry.get("value")).unwrap_or_default();
            headers.insert(
                self.rewrite(key, context, path)?,
                self.rewrite(&value, context, path)?,
            );
        }
        Ok(headers)
    }

    fn normalize_body(
        &mut self,
        raw: Option<&Value>,
        context: &VariableContext,
        scope: &str,
        path: &str,
    ) -> Result<(String, Option<String>)> {
        let Some(body) = raw else {
            return Ok(("none".into(), None));
        };
        let mode = body.get("mode").and_then(Value::as_str).unwrap_or("none");
        match mode {
            "none" => Ok(("none".into(), None)),
            "graphql" => Err(anyhow!("GraphQL body mode is not supported.")),
            "file" | "binary" | "formdata" => Err(anyhow!(
                "Multipart, file, and binary bodies are not supported."
            )),
            "raw" => {
                let language = body
                    .pointer("/options/raw/language")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if language.eq_ignore_ascii_case("graphql") {
                    return Err(anyhow!("GraphQL body mode is not supported."));
                }
                let text = body.get("raw").and_then(Value::as_str).unwrap_or("");
                let kind = if language.eq_ignore_ascii_case("json") {
                    "json"
                } else {
                    "text"
                };
                Ok((kind.into(), Some(self.rewrite(text, context, path)?)))
            }
            "urlencoded" => {
                let mut pairs = Vec::new();
                for entry in body
                    .get("urlencoded")
                    .and_then(Value::as_array)
                    .unwrap_or(&Vec::new())
                {
                    if entry
                        .get("disabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        continue;
                    }
                    let key = self.rewrite(
                        entry.get("key").and_then(Value::as_str).unwrap_or(""),
                        context,
                        path,
                    )?;
                    let raw_value = scalar_to_string(entry.get("value")).unwrap_or_default();
                    let value = if is_credential_key(&key) {
                        self.credential_reference(&raw_value, context, scope, &key, path)?
                    } else {
                        self.rewrite(&raw_value, context, path)?
                    };
                    pairs.push(format!(
                        "{}={}",
                        form_encode_preserving_placeholders(&key),
                        form_encode_preserving_placeholders(&value),
                    ));
                }
                Ok(("form".into(), Some(pairs.join("&"))))
            }
            _ => Err(anyhow!("Unsupported body mode: {}", safe_label(mode))),
        }
    }

    fn normalize_auth(
        &mut self,
        auth: Option<&Value>,
        context: &VariableContext,
        scope: &str,
        path: &str,
        query: &mut BTreeMap<String, String>,
    ) -> Result<ApiAuth> {
        let Some(auth) = auth else {
            return Ok(ApiAuth::None);
        };
        let kind = auth.get("type").and_then(Value::as_str).unwrap_or("noauth");
        match kind {
            "noauth" | "inherit" => Ok(ApiAuth::None),
            "bearer" => {
                let token = auth_attribute(auth, "bearer", "token").unwrap_or_default();
                Ok(ApiAuth::Bearer {
                    token: self.credential_reference(
                        &token,
                        context,
                        scope,
                        "BEARER_TOKEN",
                        path,
                    )?,
                })
            }
            "basic" => {
                let username = auth_attribute(auth, "basic", "username").unwrap_or_default();
                let password = auth_attribute(auth, "basic", "password").unwrap_or_default();
                Ok(ApiAuth::Basic {
                    username: self.credential_reference(
                        &username,
                        context,
                        scope,
                        "BASIC_USERNAME",
                        path,
                    )?,
                    password: self.credential_reference(
                        &password,
                        context,
                        scope,
                        "BASIC_PASSWORD",
                        path,
                    )?,
                })
            }
            "apikey" => {
                let name = self.rewrite(
                    &auth_attribute(auth, "apikey", "key").unwrap_or_else(|| "X-API-Key".into()),
                    context,
                    path,
                )?;
                let value = auth_attribute(auth, "apikey", "value").unwrap_or_default();
                let location =
                    auth_attribute(auth, "apikey", "in").unwrap_or_else(|| "header".into());
                let reference =
                    self.credential_reference(&value, context, scope, "API_KEY", path)?;
                if location.eq_ignore_ascii_case("query") {
                    query.insert(name, reference);
                    Ok(ApiAuth::None)
                } else if location.eq_ignore_ascii_case("header") {
                    Ok(ApiAuth::Header {
                        name,
                        value: reference,
                    })
                } else {
                    Err(anyhow!(
                        "Unsupported API-key location: {}",
                        safe_label(&location)
                    ))
                }
            }
            unsupported => Err(anyhow!(
                "Unsupported Postman auth strategy: {}",
                safe_label(unsupported)
            )),
        }
    }

    fn extract_header_credentials(
        &mut self,
        headers: &mut BTreeMap<String, String>,
        context: &VariableContext,
        scope: &str,
        path: &str,
    ) -> Result<()> {
        for (key, value) in headers.iter_mut() {
            if !is_credential_key(key) && !key.eq_ignore_ascii_case("authorization") {
                continue;
            }
            let reference = self.credential_reference(value, context, scope, key, path)?;
            *value = reference;
        }
        Ok(())
    }

    fn extract_query_credentials(
        &mut self,
        query: &mut BTreeMap<String, String>,
        context: &VariableContext,
        scope: &str,
        path: &str,
    ) -> Result<()> {
        for (key, value) in query.iter_mut() {
            if is_credential_key(key) {
                *value = self.credential_reference(value, context, scope, key, path)?;
            }
        }
        Ok(())
    }

    fn extract_json_credentials(
        &mut self,
        value: &mut Value,
        context: &VariableContext,
        scope: &str,
        path: &str,
    ) -> Result<()> {
        match value {
            Value::Object(map) => {
                for (key, child) in map.iter_mut() {
                    if is_credential_key(key) {
                        if let Some(text) = scalar_to_string(Some(child)) {
                            *child = Value::String(
                                self.credential_reference(&text, context, scope, key, path)?,
                            );
                            continue;
                        }
                    }
                    self.extract_json_credentials(child, context, scope, path)?;
                }
            }
            Value::Array(values) => {
                for child in values {
                    self.extract_json_credentials(child, context, scope, path)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}

pub fn preview_file(path: &Path) -> Result<PostmanImportPreview> {
    let import = read_and_normalize(path)?;
    Ok(PostmanImportPreview {
        fingerprint: import.fingerprint,
        collection_name: import.collection_name,
        request_count: import.requests.len(),
        folder_count: import.folder_count,
        variable_keys: import
            .variables
            .values()
            .map(|variable| PostmanVariableSummary {
                key: variable.key.clone(),
                is_secret: variable.is_secret,
            })
            .collect(),
        skipped_items: import.skipped_items,
        warnings: import.warnings.into_iter().collect(),
    })
}

pub fn commit_file(
    conn: &mut Connection,
    environments_dir: &Path,
    path: &Path,
    expected_fingerprint: &str,
) -> Result<PostmanImportResult> {
    let import = read_and_normalize(path)?;
    if import.fingerprint != expected_fingerprint {
        return Err(anyhow!(
            "Postman source changed after preview; preview it again"
        ));
    }
    if import.requests.is_empty() {
        return Err(anyhow!(
            "Postman collection has no supported requests to import"
        ));
    }
    let collection_name = collision_free_collection_name(conn, &import.collection_name)?;
    let environment = collision_free_environment(environments_dir, &import.collection_name)?;
    let collection_id = Uuid::new_v4().to_string();
    let transaction = conn.transaction()?;
    transaction.execute(
        "INSERT INTO api_request_collections
           (id, name, source_kind, source_file_name, environment)
         VALUES (?1, ?2, 'postman_v2_1', ?3, ?4)",
        params![
            collection_id,
            collection_name,
            import.source_file_name,
            environment
        ],
    )?;
    for request in &import.requests {
        let id = Uuid::new_v4().to_string();
        let qualified_name = qualified_request_name(
            &collection_name,
            &request.folder_path,
            &request.display_name,
            request.ordinal,
        );
        transaction.execute(
            "INSERT INTO api_saved_requests
               (id, name, target_id, environment, method, url, headers_json,
                query_json, body_kind, body_text, collection_id, folder_path,
                display_name, auth_json)
             VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                id,
                qualified_name,
                environment,
                request.method,
                request.url,
                request.headers_json,
                request.query_json,
                request.body_kind,
                request.body_text,
                collection_id,
                request.folder_path,
                request.display_name,
                request.auth_json,
            ],
        )?;
    }

    let variables: Vec<EnvVar> = import.variables.values().cloned().collect();
    if let Err(error) = env_store::write_environment(environments_dir, &environment, &variables) {
        return Err(error.context("write imported environment"));
    }
    if let Err(error) = transaction.commit() {
        let _ = env_store::delete_environment(environments_dir, &environment);
        return Err(error.into());
    }
    Ok(PostmanImportResult {
        collection_id,
        collection_name,
        environment,
        imported_count: import.requests.len(),
        skipped_count: import.skipped_items.len(),
        warnings: import.warnings.into_iter().collect(),
    })
}

/// List all persisted Postman imports, including collections created by older
/// app sessions. Only names/counts cross the command boundary; environment
/// values remain in the backend environment store.
pub fn list_collections(conn: &Connection) -> Result<Vec<PostmanCollectionSummary>> {
    let mut statement = conn.prepare(
        "SELECT collection.id, collection.name, collection.environment, COUNT(request.id) \
           FROM api_request_collections collection \
           LEFT JOIN api_saved_requests request ON request.collection_id = collection.id \
          GROUP BY collection.id, collection.name, collection.environment \
          ORDER BY collection.name COLLATE NOCASE, collection.id",
    )?;
    let collections = statement
        .query_map([], collection_summary_from_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(collections)
}

pub fn get_collection(conn: &Connection, id: &str) -> Result<Option<PostmanCollectionDetail>> {
    let collection = get_collection_summary(conn, id)?;
    let Some(collection) = collection else {
        return Ok(None);
    };
    let requests = history::list_saved_requests_for_collection(conn, id)?;
    Ok(Some(PostmanCollectionDetail {
        collection,
        requests,
    }))
}

/// Delete one imported collection and its generated environment as one
/// coordinated operation. SQLite owns request-row cascading; an exact byte
/// snapshot restores the environment if deletion or commit fails.
pub fn delete_collection(
    conn: &mut Connection,
    environments_dir: &Path,
    id: &str,
) -> Result<PostmanCollectionSummary> {
    let collection = get_collection_summary(conn, id)?
        .ok_or_else(|| anyhow!("Postman collection not found: {id}"))?;

    let external_references: i64 = conn.query_row(
        "SELECT COUNT(*) FROM api_saved_requests \
          WHERE environment = ?1 \
            AND (collection_id IS NULL OR collection_id <> ?2)",
        params![collection.environment, id],
        |row| row.get(0),
    )?;
    if external_references > 0 {
        return Err(anyhow!(
            "cannot delete Postman collection {:?}: environment {:?} is referenced by {external_references} saved request(s) outside the collection",
            collection.name,
            collection.environment,
        ));
    }

    let snapshot = env_store::snapshot_environment(environments_dir, &collection.environment)
        .context("snapshot imported environment before deletion")?;
    let transaction = conn.transaction()?;
    if let Err(error) = env_store::delete_environment(environments_dir, &collection.environment) {
        return Err(restore_after_delete_failure(
            environments_dir,
            &collection.environment,
            &snapshot,
            error.context("delete imported environment"),
        ));
    }

    let database_result = (|| -> Result<()> {
        let deleted = transaction.execute(
            "DELETE FROM api_request_collections WHERE id = ?1",
            params![id],
        )?;
        if deleted != 1 {
            return Err(anyhow!(
                "Postman collection disappeared during deletion: {id}"
            ));
        }
        transaction.commit()?;
        Ok(())
    })();
    if let Err(error) = database_result {
        return Err(restore_after_delete_failure(
            environments_dir,
            &collection.environment,
            &snapshot,
            error.context("delete imported collection rows"),
        ));
    }

    Ok(collection)
}

fn get_collection_summary(conn: &Connection, id: &str) -> Result<Option<PostmanCollectionSummary>> {
    conn.query_row(
        "SELECT collection.id, collection.name, collection.environment, COUNT(request.id) \
           FROM api_request_collections collection \
           LEFT JOIN api_saved_requests request ON request.collection_id = collection.id \
          WHERE collection.id = ?1 \
          GROUP BY collection.id, collection.name, collection.environment",
        params![id],
        collection_summary_from_row,
    )
    .optional()
    .context("get Postman collection summary")
}

fn collection_summary_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<PostmanCollectionSummary> {
    let request_count: i64 = row.get(3)?;
    Ok(PostmanCollectionSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        environment: row.get(2)?,
        request_count: request_count as usize,
    })
}

fn restore_after_delete_failure(
    environments_dir: &Path,
    environment: &str,
    snapshot: &env_store::EnvironmentSnapshot,
    error: anyhow::Error,
) -> anyhow::Error {
    match env_store::restore_environment(environments_dir, environment, snapshot) {
        Ok(()) => error,
        Err(restore_error) => anyhow!(
            "{error}; additionally failed to restore environment {environment:?}: {restore_error}"
        ),
    }
}

fn read_and_normalize(path: &Path) -> Result<NormalizedImport> {
    let metadata = std::fs::metadata(path).context("read Postman source metadata")?;
    if !metadata.is_file() {
        return Err(anyhow!("Postman source must be a JSON file"));
    }
    if metadata.len() > MAX_FILE_SIZE {
        return Err(anyhow!("Postman source exceeds the 10 MiB limit"));
    }
    let bytes = std::fs::read(path).context("read Postman source")?;
    if bytes.len() as u64 > MAX_FILE_SIZE {
        return Err(anyhow!("Postman source exceeds the 10 MiB limit"));
    }
    let fingerprint = hex_digest(&bytes);
    let root: Value = serde_json::from_slice(&bytes).context("parse Postman JSON")?;
    let schema = root
        .pointer("/info/schema")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !schema.contains("/collection/v2.1.0/") {
        return Err(anyhow!("Only Postman Collection v2.1 is supported"));
    }
    let collection_name = safe_label(
        root.pointer("/info/name")
            .and_then(Value::as_str)
            .unwrap_or("Imported Postman Collection"),
    );
    let items = root
        .get("item")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("Postman collection has no item array"))?;
    let mut parser = Parser::new();
    let mut context = VariableContext::default();
    parser.apply_variables(root.get("variable"), "", &mut context)?;
    parser.note_executable_features(&root, &collection_name);
    let root_auth = effective_auth(root.get("auth"), None);
    parser.walk_items(items, &[], 0, root_auth, &context)?;
    Ok(NormalizedImport {
        fingerprint,
        collection_name,
        source_file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .map(safe_label)
            .unwrap_or_else(|| "collection.json".into()),
        folder_count: parser.folder_count,
        variables: parser.variables,
        requests: parser.requests,
        skipped_items: parser.skipped_items,
        warnings: parser.warnings,
    })
}

fn effective_auth(raw: Option<&Value>, inherited: Option<Value>) -> Option<Value> {
    match raw {
        Some(Value::Null) | None => inherited,
        Some(value) if value.get("type").and_then(Value::as_str) == Some("inherit") => inherited,
        Some(value) => Some(value.clone()),
    }
}

fn auth_attribute(auth: &Value, section: &str, key: &str) -> Option<String> {
    auth.get(section)?
        .as_array()?
        .iter()
        .find(|entry| entry.get("key").and_then(Value::as_str) == Some(key))
        .and_then(|entry| scalar_to_string(entry.get("value")))
}

fn scalar_to_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Null => Some(String::new()),
        _ => None,
    }
}

fn structured_url(value: &Value) -> String {
    let protocol = value
        .get("protocol")
        .and_then(Value::as_str)
        .unwrap_or("https");
    let host = match value.get("host") {
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("."),
        Some(Value::String(host)) => host.clone(),
        _ => String::new(),
    };
    let path = match value.get("path") {
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("/"),
        Some(Value::String(path)) => path.trim_start_matches('/').to_string(),
        _ => String::new(),
    };
    if path.is_empty() {
        format!("{protocol}://{host}")
    } else {
        format!("{protocol}://{host}/{path}")
    }
}

fn is_credential_key(key: &str) -> bool {
    let folded = key.to_ascii_lowercase().replace(['-', ' '], "_");
    [
        "password",
        "passwd",
        "secret",
        "token",
        "api_key",
        "apikey",
        "authorization",
        "credential",
        "client_secret",
    ]
    .iter()
    .any(|needle| folded.contains(needle))
}

fn normalize_env_key(raw: &str) -> String {
    let mut output = String::new();
    let mut previous_underscore = false;
    for character in raw.chars() {
        let normalized = if character.is_ascii_alphanumeric() {
            character.to_ascii_uppercase()
        } else {
            '_'
        };
        if normalized == '_' {
            if previous_underscore {
                continue;
            }
            previous_underscore = true;
        } else {
            previous_underscore = false;
        }
        output.push(normalized);
        if output.len() >= 120 {
            break;
        }
    }
    let trimmed = output.trim_matches('_');
    if trimmed.is_empty() {
        "VALUE".into()
    } else {
        trimmed.into()
    }
}

fn suffixed_env_key(base: &str, suffix: usize) -> String {
    let suffix = format!("_{suffix}");
    let keep = 120usize.saturating_sub(suffix.len());
    format!("{}{}", &base[..base.len().min(keep)], suffix)
}

fn scope_key(parts: &[String]) -> String {
    normalize_env_key(&parts.join("_"))
}

fn safe_label(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|character| !character.is_control())
        .take(128)
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "Unnamed".into()
    } else {
        trimmed.into()
    }
}

fn extract_env_keys(text: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let mut remaining = text;
    while let Some(start) = remaining.find("${env:") {
        let after = &remaining[start + 6..];
        let Some(end) = after.find('}') else { break };
        keys.push(after[..end].to_string());
        remaining = &after[end + 1..];
    }
    keys
}

fn form_encode_preserving_placeholders(value: &str) -> String {
    let mut output = String::new();
    let mut remaining = value;
    while let Some(start) = remaining.find("${env:") {
        output.extend(url::form_urlencoded::byte_serialize(
            &remaining.as_bytes()[..start],
        ));
        let after = &remaining[start..];
        let Some(end) = after.find('}') else {
            output.extend(url::form_urlencoded::byte_serialize(after.as_bytes()));
            return output;
        };
        output.push_str(&after[..=end]);
        remaining = &after[end + 1..];
    }
    output.extend(url::form_urlencoded::byte_serialize(remaining.as_bytes()));
    output
}

fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn collection_environment_base(collection_name: &str) -> String {
    let normalized = normalize_env_key(collection_name).to_ascii_lowercase();
    let trimmed = normalized.trim_matches('_');
    let base = if trimmed.is_empty() {
        "postman"
    } else {
        trimmed
    };
    base.chars().take(52).collect()
}

fn collision_free_environment(dir: &Path, collection_name: &str) -> Result<String> {
    let existing: BTreeSet<String> = env_store::list_environments(dir)?.into_iter().collect();
    let base = collection_environment_base(collection_name);
    if !environment_artifacts_exist(dir, &base, &existing) {
        return Ok(base);
    }
    for suffix in 2..=10_000usize {
        let candidate = format!("{}-{suffix}", base.chars().take(58).collect::<String>());
        if !environment_artifacts_exist(dir, &candidate, &existing) {
            return Ok(candidate);
        }
    }
    Err(anyhow!(
        "could not allocate a collision-free environment name"
    ))
}

fn environment_artifacts_exist(dir: &Path, name: &str, listed: &BTreeSet<String>) -> bool {
    listed.contains(name)
        || dir.join(format!("{name}.env")).exists()
        || dir.join(format!("{name}.env.meta.json")).exists()
}

fn collision_free_collection_name(conn: &Connection, requested: &str) -> Result<String> {
    let base = safe_label(requested);
    for suffix in 1..=10_000usize {
        let candidate = if suffix == 1 {
            base.clone()
        } else {
            let marker = format!(" ({suffix})");
            let keep = 128usize.saturating_sub(marker.len());
            format!("{}{}", base.chars().take(keep).collect::<String>(), marker)
        };
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM api_request_collections WHERE name = ?1)",
            params![candidate],
            |row| row.get(0),
        )?;
        if !exists {
            return Ok(candidate);
        }
    }
    Err(anyhow!(
        "could not allocate a collision-free collection name"
    ))
}

fn qualified_request_name(collection: &str, folder: &str, display: &str, ordinal: usize) -> String {
    let seed = format!("{collection}\u{0}{folder}\u{0}{display}\u{0}{ordinal}");
    let digest = hex_digest(seed.as_bytes());
    let prefix =
        normalize_env_key(&format!("pm_{collection}_{folder}_{display}")).to_ascii_lowercase();
    let keep = 128usize.saturating_sub(13);
    format!(
        "{}_{}",
        prefix.chars().take(keep).collect::<String>(),
        &digest[..12]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn write_fixture(dir: &TempDir, value: Value) -> std::path::PathBuf {
        let path = dir.path().join("collection.json");
        std::fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        path
    }

    fn nested_fixture() -> Value {
        json!({
          "info": {"name": "Network API", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
          "variable": [
            {"key": "baseUrl", "value": "https://api.example.test"},
            {"key": "apiToken", "value": "token-value", "type": "secret"}
          ],
          "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "{{apiToken}}"}]},
          "item": [{
            "name": "Devices",
            "item": [{
              "name": "Get Device",
              "request": {
                "method": "GET",
                "url": {"raw": "{{baseUrl}}/devices/:id?verbose=true", "variable": [{"key": "id", "value": "42"}]},
                "header": [{"key": "X-Trace", "value": "yes"}]
              }
            }]
          }]
        })
    }

    #[test]
    fn preview_is_safe_and_maps_nested_inherited_auth() {
        let dir = TempDir::new().unwrap();
        let path = write_fixture(&dir, nested_fixture());
        let import = read_and_normalize(&path).unwrap();
        let preview = preview_file(&path).unwrap();
        assert_eq!(preview.request_count, 1);
        assert_eq!(preview.folder_count, 1);
        assert!(preview
            .variable_keys
            .iter()
            .any(|item| item.key == "APITOKEN" && item.is_secret));
        let serialized = serde_json::to_string(&preview).unwrap();
        assert!(!serialized.contains("token-value"));
        assert!(!serialized.contains("api.example.test"));
        assert_eq!(import.requests[0].folder_path, "Devices");
        assert!(import.requests[0].url.contains("${env:BASEURL}"));
        assert!(import.requests[0]
            .url
            .contains("${env:DEVICES_GET_DEVICE_ID}"));
        assert!(import.requests[0].auth_json.contains("${env:APITOKEN}"));
    }

    #[test]
    fn skips_unsupported_features_without_executing_scripts() {
        let dir = TempDir::new().unwrap();
        let path = write_fixture(
            &dir,
            json!({
              "info": {"name": "Skip", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
              "event": [{"listen": "prerequest", "script": {"exec": ["throw new Error('never')"]}}],
              "item": [
                {"name": "Graph", "request": {"method": "POST", "url": "https://x", "body": {"mode": "graphql"}}},
                {"name": "Digest", "request": {"method": "GET", "url": "https://x", "auth": {"type": "digest"}}},
                {"name": "Trace", "request": {"method": "TRACE", "url": "https://x"}}
              ]
            }),
        );
        let preview = preview_file(&path).unwrap();
        assert_eq!(preview.request_count, 0);
        assert!(preview
            .skipped_items
            .iter()
            .any(|item| item.reason.contains("script")));
        assert!(preview
            .skipped_items
            .iter()
            .any(|item| item.reason.contains("GraphQL")));
        assert!(preview
            .skipped_items
            .iter()
            .any(|item| item.reason.contains("auth")));
        assert!(preview
            .skipped_items
            .iter()
            .any(|item| item.reason.contains("HTTP method")));
    }

    #[test]
    fn extracts_literal_credentials_from_auth_headers_query_and_json_body() {
        let dir = TempDir::new().unwrap();
        let path = write_fixture(
            &dir,
            json!({
              "info": {"name": "Secrets", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
              "item": [{"name": "Login", "request": {
                "method": "POST",
                "url": {"raw": "https://x/login", "query": [{"key": "api_key", "value": "query-secret"}]},
                "header": [{"key": "Authorization", "value": "Bearer header-secret"}],
                "body": {"mode": "raw", "raw": "{\"password\":\"body-secret\",\"api_key\":123456}", "options": {"raw": {"language": "json"}}}
              }}]
            }),
        );
        let import = read_and_normalize(&path).unwrap();
        let row = &import.requests[0];
        let stored = format!(
            "{}{}{}{}",
            row.headers_json,
            row.query_json,
            row.body_text.as_deref().unwrap(),
            row.auth_json
        );
        assert!(!stored.contains("header-secret"));
        assert!(!stored.contains("query-secret"));
        assert!(!stored.contains("body-secret"));
        assert!(!stored.contains("123456"));
        assert!(
            import
                .variables
                .values()
                .filter(|value| value.is_secret)
                .count()
                >= 4
        );
    }

    #[test]
    fn keeps_mixed_authorization_headers_placeholder_backed() {
        let dir = TempDir::new().unwrap();
        let path = write_fixture(
            &dir,
            json!({
              "info": {"name": "Header Variables", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
              "variable": [{"key": "headerToken", "value": "header-token", "type": "secret"}],
              "item": [{"name": "Protected", "request": {
                "method": "GET",
                "url": "https://x/protected",
                "header": [{"key": "Authorization", "value": "Bearer {{headerToken}}"}]
              }}]
            }),
        );
        let import = read_and_normalize(&path).unwrap();
        let headers: BTreeMap<String, String> =
            serde_json::from_str(&import.requests[0].headers_json).unwrap();
        assert_eq!(
            headers.get("Authorization").map(String::as_str),
            Some("Bearer ${env:HEADERTOKEN}")
        );
        assert!(import
            .variables
            .get("HEADERTOKEN")
            .is_some_and(|variable| variable.is_secret));
        assert!(!import
            .variables
            .values()
            .any(|variable| variable.value.contains("{{")));
    }

    #[test]
    fn commit_checks_fingerprint_and_rolls_back_environment_on_db_failure() {
        let dir = TempDir::new().unwrap();
        let env_dir = dir.path().join("envs");
        let path = write_fixture(&dir, nested_fixture());
        let fingerprint = preview_file(&path).unwrap().fingerprint;
        std::fs::write(&path, b"{}").unwrap();
        let mut conn = Connection::open_in_memory().unwrap();
        assert!(commit_file(&mut conn, &env_dir, &path, &fingerprint).is_err());
        assert!(env_store::list_environments(&env_dir).unwrap().is_empty());
    }

    #[test]
    fn maps_raw_text_and_urlencoded_bodies_and_api_key_locations() {
        let dir = TempDir::new().unwrap();
        let path = write_fixture(
            &dir,
            json!({
              "info": {"name": "Bodies", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
              "item": [
                {"name": "Text", "request": {
                  "method": "POST", "url": "https://x/text",
                  "auth": {"type": "apikey", "apikey": [
                    {"key": "key", "value": "X-API-Key"}, {"key": "value", "value": "header-key"}, {"key": "in", "value": "header"}
                  ]},
                  "body": {"mode": "raw", "raw": "plain text"}
                }},
                {"name": "Form", "request": {
                  "method": "POST", "url": "https://x/form",
                  "auth": {"type": "apikey", "apikey": [
                    {"key": "key", "value": "api_key"}, {"key": "value", "value": "query-key"}, {"key": "in", "value": "query"}
                  ]},
                  "body": {"mode": "urlencoded", "urlencoded": [
                    {"key": "name", "value": "router one"},
                    {"key": "password", "value": "form-password"}
                  ]}
                }}
              ]
            }),
        );
        let import = read_and_normalize(&path).unwrap();
        assert_eq!(import.requests[0].body_kind, "text");
        assert_eq!(import.requests[0].body_text.as_deref(), Some("plain text"));
        assert!(import.requests[0].auth_json.contains("${env:TEXT_API_KEY}"));
        assert_eq!(import.requests[1].body_kind, "form");
        let form_body = import.requests[1].body_text.as_deref().unwrap();
        assert!(form_body.contains("name=router+one"));
        assert!(form_body.contains("password=${env:FORM_PASSWORD}"));
        assert!(!form_body.contains("form-password"));
        assert!(import
            .variables
            .get("FORM_PASSWORD")
            .is_some_and(|variable| variable.is_secret));
        assert!(import.requests[1]
            .query_json
            .contains("${env:FORM_API_KEY}"));
    }

    #[test]
    fn enforces_file_request_folder_and_value_limits_before_commit() {
        let dir = TempDir::new().unwrap();
        let oversized = dir.path().join("oversized.json");
        let file = std::fs::File::create(&oversized).unwrap();
        file.set_len(MAX_FILE_SIZE + 1).unwrap();
        assert!(preview_file(&oversized)
            .unwrap_err()
            .to_string()
            .contains("10 MiB"));

        let requests = (0..=MAX_REQUESTS)
            .map(|index| json!({"name": format!("Request {index}"), "request": {"method": "GET", "url": "https://x"}}))
            .collect::<Vec<_>>();
        let too_many = write_fixture(
            &dir,
            json!({
              "info": {"name": "Many", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
              "item": requests
            }),
        );
        assert!(preview_file(&too_many)
            .unwrap_err()
            .to_string()
            .contains("request limit"));

        let mut nested = json!({"name": "Leaf", "request": {"method": "GET", "url": "https://x"}});
        for index in 0..=MAX_FOLDER_DEPTH {
            nested = json!({"name": format!("Folder {index}"), "item": [nested]});
        }
        let too_deep = write_fixture(
            &dir,
            json!({
              "info": {"name": "Deep", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
              "item": [nested]
            }),
        );
        assert!(preview_file(&too_deep)
            .unwrap_err()
            .to_string()
            .contains("level limit"));

        let too_large_value = write_fixture(
            &dir,
            json!({
              "info": {"name": "Value", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
              "variable": [{"key": "huge", "value": "x".repeat(64 * 1024 + 1)}],
              "item": []
            }),
        );
        assert!(preview_file(&too_large_value)
            .unwrap_err()
            .to_string()
            .contains("value too long"));
    }
}
