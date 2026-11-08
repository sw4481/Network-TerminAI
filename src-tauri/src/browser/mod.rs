//! Browser windows feature (Phase 3). Popup WebviewWindow instances —
//! NOT embedded child webviews (see docs/spikes/spike-webview-report.md).
pub mod control_server;
pub mod cookies;
pub mod manager;

pub use control_server::{
    discovery_path, start_control_server, write_control_discovery, BrowserControlInfo,
};
pub use cookies::{read_chrome_cookies, read_safari_cookies, Cookie};
pub use manager::{BrowserManager, BrowserWindowInfo};
