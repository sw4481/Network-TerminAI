//! In-memory unlock state for vault envelopes.
//!
//! Holds derived AES keys behind a `Zeroizing` wrapper so the buffer is
//! wiped when an envelope locks, idle-times-out, or the process exits.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

pub struct VaultLock {
    inner: Mutex<Inner>,
    idle_timeout: Duration,
}

struct Inner {
    unlocked: HashMap<String, UnlockedEnvelope>,
}

struct UnlockedEnvelope {
    key: Zeroizing<[u8; 32]>,
    last_activity: Instant,
    session_id: String,
}

impl VaultLock {
    pub fn new(idle_timeout: Duration) -> Self {
        Self {
            inner: Mutex::new(Inner {
                unlocked: HashMap::new(),
            }),
            idle_timeout,
        }
    }

    pub fn idle_timeout(&self) -> Duration {
        self.idle_timeout
    }

    pub fn unlock(
        &self,
        envelope_id: &str,
        key: Zeroizing<[u8; 32]>,
        session_id: String,
    ) {
        let mut g = self.inner.lock();
        g.unlocked.insert(
            envelope_id.to_string(),
            UnlockedEnvelope {
                key,
                last_activity: Instant::now(),
                session_id,
            },
        );
    }

    pub fn is_unlocked(&self, envelope_id: &str) -> bool {
        let g = self.inner.lock();
        match g.unlocked.get(envelope_id) {
            Some(u) => u.last_activity.elapsed() <= self.idle_timeout,
            None => false,
        }
    }

    pub fn unlocked_ids(&self) -> Vec<String> {
        let g = self.inner.lock();
        g.unlocked
            .iter()
            .filter(|(_, u)| u.last_activity.elapsed() <= self.idle_timeout)
            .map(|(k, _)| k.clone())
            .collect()
    }

    /// Run `f` with the unlocked key for `envelope_id`. Returns `None` if
    /// the envelope is locked or has idle-timed-out. Refreshes the
    /// last-activity timestamp on success.
    pub fn with_key<R>(
        &self,
        envelope_id: &str,
        f: impl FnOnce(&Zeroizing<[u8; 32]>) -> R,
    ) -> Option<R> {
        let mut g = self.inner.lock();
        let entry = g.unlocked.get_mut(envelope_id)?;
        if entry.last_activity.elapsed() > self.idle_timeout {
            return None;
        }
        entry.last_activity = Instant::now();
        Some(f(&entry.key))
    }

    /// Lock a single envelope. Returns its session_id if it was unlocked.
    pub fn lock(&self, envelope_id: &str) -> Option<String> {
        let mut g = self.inner.lock();
        g.unlocked.remove(envelope_id).map(|u| u.session_id)
    }

    /// Sweep every envelope whose `last_activity` exceeds the idle timeout.
    /// Returns `(envelope_id, session_id)` pairs for the audit log.
    pub fn sweep_idle(&self) -> Vec<(String, String)> {
        let mut g = self.inner.lock();
        let to_drop: Vec<String> = g
            .unlocked
            .iter()
            .filter(|(_, u)| u.last_activity.elapsed() > self.idle_timeout)
            .map(|(k, _)| k.clone())
            .collect();
        to_drop
            .into_iter()
            .filter_map(|k| g.unlocked.remove(&k).map(|u| (k, u.session_id)))
            .collect()
    }
}
