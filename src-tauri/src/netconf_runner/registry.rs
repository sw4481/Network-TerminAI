//! Global session registry. Sessions are keyed by an opaque UUID; the
//! frontend holds the id, the registry holds the `Arc<Session>`. Dropping
//! the Arc closes the SSH connection (via russh's Handle Drop).

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use uuid::Uuid;

use super::error::{NetconfError, Result};
use super::session::Session;

pub type SessionId = String;

#[derive(Default)]
pub struct SessionRegistry {
    inner: Mutex<HashMap<SessionId, Arc<Session>>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, session: Session) -> SessionId {
        let id = Uuid::new_v4().to_string();
        self.inner.lock().insert(id.clone(), Arc::new(session));
        id
    }

    pub fn get(&self, id: &str) -> Result<Arc<Session>> {
        self.inner
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| NetconfError::SessionNotFound(id.to_string()))
    }

    #[allow(dead_code)]
    pub fn remove(&self, id: &str) {
        self.inner.lock().remove(id);
    }
}
