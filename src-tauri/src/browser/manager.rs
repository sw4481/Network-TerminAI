use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWindowInfo {
    pub browser_id: String,
    pub url: String,
}

/// Tracks open popup browser windows by opaque browser_id (== Tauri window label).
#[derive(Clone)]
pub struct BrowserManager {
    windows: Arc<RwLock<HashMap<String, String>>>, // browser_id -> url
}

impl Default for BrowserManager {
    fn default() -> Self {
        Self::new()
    }
}

impl BrowserManager {
    pub fn new() -> Self {
        Self {
            windows: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn register(&self, browser_id: String, url: String) {
        self.windows.write().insert(browser_id, url);
    }

    pub fn unregister(&self, browser_id: &str) {
        self.windows.write().remove(browser_id);
    }

    pub fn list(&self) -> Vec<BrowserWindowInfo> {
        self.windows
            .read()
            .iter()
            .map(|(id, url)| BrowserWindowInfo {
                browser_id: id.clone(),
                url: url.clone(),
            })
            .collect()
    }

    pub fn get_url(&self, browser_id: &str) -> Option<String> {
        self.windows.read().get(browser_id).cloned()
    }

    pub fn set_url(&self, browser_id: &str, url: String) {
        if let Some(slot) = self.windows.write().get_mut(browser_id) {
            *slot = url;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_register_list_unregister() {
        let m = BrowserManager::new();
        assert!(m.list().is_empty());

        m.register("browser-1".to_string(), "https://example.com".to_string());
        let list = m.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].browser_id, "browser-1");
        assert_eq!(list[0].url, "https://example.com");

        m.unregister("browser-1");
        assert!(m.list().is_empty());
    }

    #[test]
    fn test_set_and_get_url() {
        let m = BrowserManager::new();
        m.register("b1".to_string(), "https://a.com".to_string());
        m.set_url("b1", "https://b.com".to_string());
        assert_eq!(m.get_url("b1"), Some("https://b.com".to_string()));
    }
}
