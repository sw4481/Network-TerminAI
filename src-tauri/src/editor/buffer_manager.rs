use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditorBufferSeed {
    pub buffer_id: String,
    pub file_path: Option<String>,
    pub content: String,
    pub language: String,
    pub cisco_platform: Option<String>,
    pub dirty: bool,
    pub source_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditorBufferSnapshot {
    pub buffer_id: String,
    pub file_path: Option<String>,
    pub content: String,
    pub language: String,
    pub cisco_platform: Option<String>,
    pub dirty: bool,
    pub revision: u64,
    pub source_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum EditorBufferUpdateResult {
    Applied { snapshot: EditorBufferSnapshot },
    Conflict { snapshot: EditorBufferSnapshot },
}

#[derive(Default)]
pub struct EditorBufferManager {
    buffers: RwLock<HashMap<String, EditorBufferSnapshot>>,
}

impl EditorBufferManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, seed: EditorBufferSeed) -> EditorBufferSnapshot {
        let mut buffers = self.buffers.write();
        buffers
            .entry(seed.buffer_id.clone())
            .or_insert_with(|| EditorBufferSnapshot {
                buffer_id: seed.buffer_id,
                file_path: seed.file_path,
                content: seed.content,
                language: seed.language,
                cisco_platform: seed.cisco_platform,
                dirty: seed.dirty,
                revision: 0,
                source_id: seed.source_id,
            })
            .clone()
    }

    pub fn get(&self, buffer_id: &str) -> Option<EditorBufferSnapshot> {
        self.buffers.read().get(buffer_id).cloned()
    }

    /// True when an authoritative attached or detached editor buffer inside
    /// `repository_root` has unsaved content. Git pull/branch switching use
    /// this in addition to the on-disk worktree guard.
    pub fn has_dirty_within(&self, repository_root: &Path) -> bool {
        self.buffers.read().values().any(|buffer| {
            buffer.dirty
                && buffer
                    .file_path
                    .as_deref()
                    .map(Path::new)
                    .is_some_and(|path| path.starts_with(repository_root))
        })
    }

    pub fn update(
        &self,
        buffer_id: &str,
        base_revision: u64,
        content: String,
        language: String,
        cisco_platform: Option<String>,
        dirty: bool,
        source_id: String,
    ) -> Option<EditorBufferUpdateResult> {
        let mut buffers = self.buffers.write();
        let snapshot = buffers.get_mut(buffer_id)?;
        if snapshot.revision != base_revision {
            return Some(EditorBufferUpdateResult::Conflict {
                snapshot: snapshot.clone(),
            });
        }

        snapshot.content = content;
        snapshot.language = language;
        snapshot.cisco_platform = cisco_platform;
        snapshot.dirty = dirty;
        snapshot.source_id = source_id;
        snapshot.revision += 1;
        Some(EditorBufferUpdateResult::Applied {
            snapshot: snapshot.clone(),
        })
    }

    pub fn mark_saved(
        &self,
        buffer_id: &str,
        expected_revision: u64,
        source_id: String,
    ) -> Option<EditorBufferUpdateResult> {
        let mut buffers = self.buffers.write();
        let snapshot = buffers.get_mut(buffer_id)?;
        if snapshot.revision != expected_revision {
            return Some(EditorBufferUpdateResult::Conflict {
                snapshot: snapshot.clone(),
            });
        }

        snapshot.dirty = false;
        snapshot.source_id = source_id;
        snapshot.revision += 1;
        Some(EditorBufferUpdateResult::Applied {
            snapshot: snapshot.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(content: &str) -> EditorBufferSeed {
        EditorBufferSeed {
            buffer_id: "file:/repo/a.ts".to_string(),
            file_path: Some("/repo/a.ts".to_string()),
            content: content.to_string(),
            language: "typescript".to_string(),
            cisco_platform: None,
            dirty: false,
            source_id: "main".to_string(),
        }
    }

    #[test]
    fn editor_buffer_registers_at_revision_zero() {
        let manager = EditorBufferManager::new();

        let snapshot = manager.register(seed("first"));

        assert_eq!(snapshot.revision, 0);
        assert_eq!(snapshot.content, "first");
        assert!(!snapshot.dirty);
    }

    #[test]
    fn editor_buffer_register_returns_existing_authority() {
        let manager = EditorBufferManager::new();
        let first = manager.register(seed("first"));
        let second = manager.register(seed("should not replace"));

        assert_eq!(second, first);
        assert_eq!(manager.get(&first.buffer_id), Some(first));
    }

    #[test]
    fn editor_buffer_profile_survives_register_and_update() {
        let manager = EditorBufferManager::new();
        let mut seed = seed("interface Gi1");
        seed.cisco_platform = Some("iosxe".to_string());
        let registered = manager.register(seed);
        assert_eq!(registered.cisco_platform.as_deref(), Some("iosxe"));

        let result = manager
            .update(
                &registered.buffer_id,
                registered.revision,
                registered.content.clone(),
                registered.language.clone(),
                Some("nxos".to_string()),
                true,
                "detached".to_string(),
            )
            .expect("registered buffer");
        let EditorBufferUpdateResult::Applied { snapshot } = result else {
            panic!("expected applied update");
        };
        assert_eq!(snapshot.cisco_platform.as_deref(), Some("nxos"));
    }

    #[test]
    fn editor_buffer_update_accepts_current_revision_once() {
        let manager = EditorBufferManager::new();
        manager.register(seed("first"));

        let result = manager
            .update(
                "file:/repo/a.ts",
                0,
                "second".to_string(),
                "typescript".to_string(),
                None,
                true,
                "detached".to_string(),
            )
            .expect("registered buffer");

        let EditorBufferUpdateResult::Applied { snapshot } = result else {
            panic!("expected applied update");
        };
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.content, "second");
        assert!(snapshot.dirty);
        assert_eq!(snapshot.source_id, "detached");
    }

    #[test]
    fn editor_buffer_update_rejects_stale_revision_without_mutation() {
        let manager = EditorBufferManager::new();
        manager.register(seed("first"));
        manager.update(
            "file:/repo/a.ts",
            0,
            "second".to_string(),
            "typescript".to_string(),
            None,
            true,
            "main".to_string(),
        );

        let result = manager
            .update(
                "file:/repo/a.ts",
                0,
                "stale".to_string(),
                "typescript".to_string(),
                None,
                true,
                "detached".to_string(),
            )
            .expect("registered buffer");

        let EditorBufferUpdateResult::Conflict { snapshot } = result else {
            panic!("expected conflict");
        };
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.content, "second");
        assert_eq!(manager.get("file:/repo/a.ts"), Some(snapshot));
    }

    #[test]
    fn editor_buffer_mark_saved_only_clears_the_current_revision() {
        let manager = EditorBufferManager::new();
        manager.register(seed("first"));
        let updated = manager
            .update(
                "file:/repo/a.ts",
                0,
                "second".to_string(),
                "typescript".to_string(),
                None,
                true,
                "main".to_string(),
            )
            .expect("registered");
        let EditorBufferUpdateResult::Applied { snapshot: updated } = updated else {
            panic!("expected update");
        };

        let stale = manager
            .mark_saved("file:/repo/a.ts", 0, "main".to_string())
            .expect("registered");
        assert!(matches!(stale, EditorBufferUpdateResult::Conflict { .. }));
        assert!(manager.get("file:/repo/a.ts").expect("snapshot").dirty);

        let saved = manager
            .mark_saved("file:/repo/a.ts", updated.revision, "main".to_string())
            .expect("registered");
        let EditorBufferUpdateResult::Applied { snapshot: saved } = saved else {
            panic!("expected saved result");
        };
        assert!(!saved.dirty);
        assert_eq!(saved.revision, updated.revision + 1);
    }

    #[test]
    fn editor_buffer_unknown_updates_are_not_created_implicitly() {
        let manager = EditorBufferManager::new();

        assert!(manager
            .update(
                "missing",
                0,
                "content".to_string(),
                "plaintext".to_string(),
                None,
                true,
                "main".to_string(),
            )
            .is_none());
        assert!(manager.get("missing").is_none());
    }
}
