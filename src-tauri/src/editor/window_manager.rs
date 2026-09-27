use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetachedEditorWindowInfo {
    pub window_id: String,
    pub tab_id: String,
    pub pane_id: String,
    pub buffer_id: String,
    pub title: String,
    pub workspace_root: Option<String>,
}

#[derive(Clone, Default)]
pub struct EditorWindowManager {
    windows: Arc<RwLock<HashMap<String, DetachedEditorWindowInfo>>>,
}

impl EditorWindowManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, info: DetachedEditorWindowInfo) -> Result<(), String> {
        let mut windows = self.windows.write();
        if windows.contains_key(&info.window_id) {
            return Err(format!(
                "detached editor window already registered: {}",
                info.window_id
            ));
        }
        if windows
            .values()
            .any(|existing| existing.tab_id == info.tab_id && existing.pane_id == info.pane_id)
        {
            return Err(format!(
                "editor pane already detached: {}/{}",
                info.tab_id, info.pane_id
            ));
        }
        windows.insert(info.window_id.clone(), info);
        Ok(())
    }

    pub fn get(&self, window_id: &str) -> Option<DetachedEditorWindowInfo> {
        self.windows.read().get(window_id).cloned()
    }

    pub fn unregister(&self, window_id: &str) -> Option<DetachedEditorWindowInfo> {
        self.windows.write().remove(window_id)
    }

    pub fn list(&self) -> Vec<DetachedEditorWindowInfo> {
        let mut windows: Vec<_> = self.windows.read().values().cloned().collect();
        windows.sort_by(|left, right| left.window_id.cmp(&right.window_id));
        windows
    }

    pub fn by_tab(&self, tab_id: &str) -> Vec<DetachedEditorWindowInfo> {
        let mut windows: Vec<_> = self
            .windows
            .read()
            .values()
            .filter(|info| info.tab_id == tab_id)
            .cloned()
            .collect();
        windows.sort_by(|left, right| left.window_id.cmp(&right.window_id));
        windows
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(window_id: &str, tab_id: &str, pane_id: &str) -> DetachedEditorWindowInfo {
        DetachedEditorWindowInfo {
            window_id: window_id.to_string(),
            tab_id: tab_id.to_string(),
            pane_id: pane_id.to_string(),
            buffer_id: format!("buffer-{pane_id}"),
            title: format!("Pane {pane_id}"),
            workspace_root: Some("/repo".to_string()),
        }
    }

    #[test]
    fn editor_window_registers_lists_gets_and_unregisters() {
        let manager = EditorWindowManager::new();
        let first = info("editor-b", "tab-1", "pane-2");
        let second = info("editor-a", "tab-1", "pane-1");

        manager.register(first.clone()).expect("register first");
        manager.register(second.clone()).expect("register second");

        assert_eq!(manager.get("editor-b"), Some(first.clone()));
        assert_eq!(manager.list(), vec![second, first.clone()]);
        assert_eq!(manager.unregister("editor-b"), Some(first));
        assert!(manager.get("editor-b").is_none());
    }

    #[test]
    fn editor_window_rejects_duplicate_labels_and_panes() {
        let manager = EditorWindowManager::new();
        manager
            .register(info("editor-a", "tab-1", "pane-1"))
            .expect("register");

        assert!(manager
            .register(info("editor-a", "tab-2", "pane-2"))
            .is_err());
        assert!(manager
            .register(info("editor-b", "tab-1", "pane-1"))
            .is_err());
        assert_eq!(manager.list().len(), 1);
    }

    #[test]
    fn editor_window_filters_by_tab_without_touching_other_tabs() {
        let manager = EditorWindowManager::new();
        manager
            .register(info("editor-a", "tab-1", "pane-1"))
            .expect("register");
        manager
            .register(info("editor-b", "tab-2", "pane-2"))
            .expect("register");
        manager
            .register(info("editor-c", "tab-1", "pane-3"))
            .expect("register");

        assert_eq!(
            manager
                .by_tab("tab-1")
                .into_iter()
                .map(|value| value.window_id)
                .collect::<Vec<_>>(),
            vec!["editor-a", "editor-c"],
        );
        assert_eq!(manager.list().len(), 3);
    }
}
