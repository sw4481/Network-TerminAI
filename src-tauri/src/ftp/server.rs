use super::types::*;
use anyhow::{Context, Result};
use async_trait::async_trait;
use libunftp::auth::{AuthenticationError, Authenticator, Credentials, UserDetail};
use libunftp::notification::{DataEvent, DataListener, EventMeta, PresenceEvent, PresenceListener};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;

/// Per-user info returned by the authenticator; libunftp carries it through the session.
#[derive(Debug, Clone)]
pub struct FtpSessionUser {
    pub username: String,
    pub home: PathBuf,
    pub read_only: bool,
}

impl fmt::Display for FtpSessionUser {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.username)
    }
}

impl UserDetail for FtpSessionUser {
    fn home(&self) -> Option<&std::path::Path> {
        Some(self.home.as_path())
    }
}

/// SQLite-backed authenticator. Looks up (username, password) in ftp_users.
/// Password stored plaintext for MVP.
#[derive(Clone)]
pub struct SqliteAuthenticator {
    db: Arc<Mutex<Connection>>,
    event_sink: EventSink,
}

impl fmt::Debug for SqliteAuthenticator {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SqliteAuthenticator").finish()
    }
}

#[async_trait]
impl Authenticator<FtpSessionUser> for SqliteAuthenticator {
    async fn authenticate(
        &self,
        username: &str,
        creds: &Credentials,
    ) -> Result<FtpSessionUser, AuthenticationError> {
        let password = creds.password.as_deref().unwrap_or("");
        tracing::info!(
            username = %username,
            has_password = !password.is_empty(),
            pw_len = password.len(),
            source_ip = %creds.source_ip,
            "FTP authenticate() called"
        );
        // Also log to the events table so the status popover shows it.
        self.event_sink.push(FtpEventIn {
            kind: "info",
            username: Some(username.to_string()),
            path: None,
            detail: Some(format!(
                "authenticate attempted (pw_len={})",
                password.len()
            )),
        });
        let uname = username.to_string();
        let pw = password.to_string();
        let db = self.db.clone();
        let user_result = tokio::task::spawn_blocking(move || {
            let conn = db.lock();
            conn.query_row(
                "SELECT username, password, home_dir, read_only, enabled
                   FROM ftp_users WHERE username = ?1",
                [uname.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i32>(3)? != 0,
                        row.get::<_, i32>(4)? != 0,
                    ))
                },
            )
            .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| AuthenticationError::ImplPropagated(e.to_string(), None))?;

        match user_result {
            Ok((uname_db, pw_db, home_dir, read_only, enabled)) => {
                if !enabled {
                    self.event_sink.push(FtpEventIn {
                        kind: "error",
                        username: Some(uname_db.clone()),
                        path: None,
                        detail: Some("user disabled".into()),
                    });
                    return Err(AuthenticationError::BadPassword);
                }
                if pw != pw_db {
                    self.event_sink.push(FtpEventIn {
                        kind: "error",
                        username: Some(uname_db.clone()),
                        path: None,
                        detail: Some("bad password".into()),
                    });
                    return Err(AuthenticationError::BadPassword);
                }
                let home = PathBuf::from(&home_dir);
                // Make sure the home dir exists so libunftp can chroot.
                if let Err(e) = std::fs::create_dir_all(&home) {
                    self.event_sink.push(FtpEventIn {
                        kind: "error",
                        username: Some(uname_db.clone()),
                        path: Some(home.display().to_string()),
                        detail: Some(format!("create home dir failed: {e}")),
                    });
                    return Err(AuthenticationError::ImplPropagated(e.to_string(), None));
                }
                Ok(FtpSessionUser {
                    username: uname_db,
                    home,
                    read_only,
                })
            }
            Err(_) => Err(AuthenticationError::BadUser),
        }
    }
}

/// Incoming event shape (before it's inserted + broadcast).
#[derive(Debug, Clone)]
pub struct FtpEventIn {
    pub kind: &'static str,
    pub username: Option<String>,
    pub path: Option<String>,
    pub detail: Option<String>,
}

/// EventSink persists events to SQLite and broadcasts the inserted FtpEvent
/// to any listeners (the Tauri Channel for the status pill's live feed).
#[derive(Clone)]
pub struct EventSink {
    db: Arc<Mutex<Connection>>,
    tx: broadcast::Sender<FtpEvent>,
}

impl fmt::Debug for EventSink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EventSink").finish()
    }
}

impl EventSink {
    pub fn new(db: Arc<Mutex<Connection>>) -> Self {
        let (tx, _) = broadcast::channel::<FtpEvent>(256);
        Self { db, tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<FtpEvent> {
        self.tx.subscribe()
    }

    pub fn push(&self, ev: FtpEventIn) {
        let ts = now_unix();
        let kind = ev.kind.to_string();
        let username = ev.username.clone();
        let path = ev.path.clone();
        let detail = ev.detail.clone();

        // Insert synchronously (small writes, < 1 ms) on a blocking-friendly path.
        // We're already inside async contexts so use try_lock to avoid blocking the runtime.
        let inserted_id = {
            let conn = self.db.lock();
            conn.execute(
                "INSERT INTO ftp_events (ts, kind, username, client_ip, path, detail)
                   VALUES (?1, ?2, ?3, NULL, ?4, ?5)",
                rusqlite::params![ts, &kind, &username, &path, &detail],
            )
            .ok();
            conn.last_insert_rowid()
        };

        let _ = self.tx.send(FtpEvent {
            id: inserted_id,
            ts,
            kind,
            username,
            client_ip: None,
            path,
            detail,
        });
    }

    /// Trim the event log to the last N rows to keep size bounded.
    pub fn trim(&self, keep: usize) {
        let conn = self.db.lock();
        let _ = conn.execute(
            "DELETE FROM ftp_events WHERE id NOT IN (
               SELECT id FROM ftp_events ORDER BY id DESC LIMIT ?1
             )",
            rusqlite::params![keep as i64],
        );
    }
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Listener bridging libunftp presence events -> EventSink.
#[derive(Debug, Clone)]
pub struct PresenceToSink(pub EventSink);

#[async_trait]
impl PresenceListener for PresenceToSink {
    async fn receive_presence_event(&self, e: PresenceEvent, m: EventMeta) {
        let kind = match e {
            PresenceEvent::LoggedIn => "login",
            PresenceEvent::LoggedOut => "logout",
        };
        self.0.push(FtpEventIn {
            kind,
            username: Some(m.username),
            path: None,
            detail: None,
        });
    }
}

/// Listener bridging libunftp data events -> EventSink.
#[derive(Debug, Clone)]
pub struct DataToSink(pub EventSink);

#[async_trait]
impl DataListener for DataToSink {
    async fn receive_data_event(&self, e: DataEvent, m: EventMeta) {
        let (kind, path, detail) = match e {
            DataEvent::Got { path, bytes } => ("retr", Some(path), Some(format!("{bytes} bytes"))),
            DataEvent::Put { path, bytes } => ("stor", Some(path), Some(format!("{bytes} bytes"))),
            DataEvent::Deleted { path } => ("del", Some(path), None),
            DataEvent::MadeDir { path } => ("mkdir", Some(path), None),
            DataEvent::RemovedDir { path } => ("rmdir", Some(path), None),
            DataEvent::Renamed { from, to } => ("rename", Some(to), Some(format!("from {from}"))),
        };
        self.0.push(FtpEventIn {
            kind,
            username: Some(m.username),
            path,
            detail,
        });
    }
}

/// The FTP server process handle: holds the shutdown trigger + status.
pub struct FtpServerHandle {
    pub shutdown_tx: broadcast::Sender<()>,
    pub started_at: i64,
    pub bind_address: String,
}

/// State tracked in the AppState. Exposes lifecycle control + event subscription.
pub struct FtpService {
    pub db: Arc<Mutex<Connection>>,
    pub handle: Arc<Mutex<Option<FtpServerHandle>>>,
    pub events: EventSink,
    pub last_error: Arc<Mutex<Option<String>>>,
}

impl FtpService {
    pub fn new(db: Arc<Mutex<Connection>>) -> Self {
        let events = EventSink::new(db.clone());
        Self {
            db,
            handle: Arc::new(Mutex::new(None)),
            events,
            last_error: Arc::new(Mutex::new(None)),
        }
    }

    pub fn is_running(&self) -> bool {
        self.handle.lock().is_some()
    }

    pub fn status(&self) -> FtpStatus {
        let h = self.handle.lock();
        match h.as_ref() {
            Some(handle) => FtpStatus {
                running: true,
                bind_address: Some(handle.bind_address.clone()),
                started_at: Some(handle.started_at),
                last_error: self.last_error.lock().clone(),
            },
            None => FtpStatus {
                running: false,
                bind_address: None,
                started_at: None,
                last_error: self.last_error.lock().clone(),
            },
        }
    }

    pub async fn start(&self, config: FtpConfig) -> Result<()> {
        if self.is_running() {
            anyhow::bail!("FTP server is already running");
        }

        let bind_addr = format!("{}:{}", config.bind_host, config.bind_port);
        let authenticator = Arc::new(SqliteAuthenticator {
            db: self.db.clone(),
            event_sink: self.events.clone(),
        });
        let events = self.events.clone();

        // The FS backend's "root" is the broadest permitted path — each user's
        // home_dir must be a descendant of it (unftp-sbe-fs uses strip_prefix to
        // chroot into the user's home). Use `/` so any absolute home dir works.
        // Per-user home enforcement happens in `FtpSessionUser::home()`.
        let fs_root = std::path::PathBuf::from("/");
        // Also make sure the default FTP directory exists in case a user was
        // created with the auto-generated default home.
        if let Ok(defdir) = default_ftp_root() {
            let _ = std::fs::create_dir_all(&defdir);
        }

        let greeting = config.greeting.clone();
        let pmin = config.passive_min;
        let pmax = config.passive_max;

        let (shutdown_tx, mut shutdown_rx) = broadcast::channel::<()>(1);

        // Spawn the server as a tokio task.
        let events_presence = PresenceToSink(events.clone());
        let events_data = DataToSink(events.clone());
        let last_error = self.last_error.clone();
        let events_sink_for_task = events.clone();
        let bind_addr_for_task = bind_addr.clone();

        let join = tokio::spawn(async move {
            use libunftp::ServerBuilder;

            let root = fs_root.clone();
            let builder = ServerBuilder::with_authenticator(
                Box::new(move || unftp_sbe_fs::Filesystem::new(root.clone())),
                authenticator,
            )
            .greeting(greeting.leak() as &str)
            .passive_ports(pmin..pmax.saturating_add(1))
            .notify_presence(events_presence)
            .notify_data(events_data)
            .shutdown_indicator(async move {
                let _ = shutdown_rx.recv().await;
                libunftp::options::Shutdown::new().grace_period(std::time::Duration::from_secs(5))
            });

            let server = match builder.build() {
                Ok(s) => s,
                Err(e) => {
                    *last_error.lock() = Some(format!("build: {e}"));
                    events_sink_for_task.push(FtpEventIn {
                        kind: "error",
                        username: None,
                        path: None,
                        detail: Some(format!("build failed: {e}")),
                    });
                    return;
                }
            };

            events_sink_for_task.push(FtpEventIn {
                kind: "info",
                username: None,
                path: None,
                detail: Some(format!("listening on {bind_addr_for_task}")),
            });

            if let Err(e) = server.listen(bind_addr_for_task.clone()).await {
                *last_error.lock() = Some(e.to_string());
                events_sink_for_task.push(FtpEventIn {
                    kind: "error",
                    username: None,
                    path: None,
                    detail: Some(format!("listen error: {e}")),
                });
            } else {
                events_sink_for_task.push(FtpEventIn {
                    kind: "info",
                    username: None,
                    path: None,
                    detail: Some("shut down cleanly".into()),
                });
            }
        });
        // We don't join the task — the shutdown_tx is how we stop it. Dropping the
        // JoinHandle is fine.
        std::mem::drop(join);

        *self.handle.lock() = Some(FtpServerHandle {
            shutdown_tx,
            started_at: now_unix(),
            bind_address: bind_addr,
        });
        *self.last_error.lock() = None;
        Ok(())
    }

    pub fn stop(&self) -> Result<()> {
        let handle = self.handle.lock().take();
        match handle {
            Some(h) => {
                let _ = h.shutdown_tx.send(());
                Ok(())
            }
            None => Ok(()), // idempotent
        }
    }
}

pub fn default_ftp_root() -> Result<PathBuf> {
    let home = dirs::home_dir().context("home dir")?;
    Ok(home.join(".ccie-terminal").join("ftp"))
}

pub fn default_user_home(username: &str) -> Result<PathBuf> {
    Ok(default_ftp_root()?.join(username))
}
