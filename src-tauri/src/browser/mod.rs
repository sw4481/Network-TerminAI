//! Browser windows feature (Phase 3). Popup WebviewWindow instances —
//! NOT embedded child webviews (see docs/spikes/spike-webview-report.md).
pub mod manager;
pub mod control_server;
pub mod cookies;

pub use manager::{BrowserManager, BrowserWindowInfo};
pub use control_server::{start_control_server, write_control_discovery, BrowserControlInfo, discovery_path};
pub use cookies::{Cookie, read_chrome_cookies, read_safari_cookies};
