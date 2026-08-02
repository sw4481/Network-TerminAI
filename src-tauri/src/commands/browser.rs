use crate::browser::{BrowserManager, BrowserWindowInfo};
use crate::commands::AppState;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// Core window-creation logic shared by the Tauri command and the HTTP
/// control server. Returns the new browser_id.
pub fn do_create_browser_window(
    app: &AppHandle,
    mgr: &BrowserManager,
    url: &str,
) -> Result<String, String> {
    tracing::info!(url = %url, "do_create_browser_window");
    let parsed = url
        .parse()
        .map_err(|e| format!("Invalid URL '{}': {}", url, e))?;
    let browser_id = format!("browser-{}", uuid::Uuid::new_v4());

    // Navigate directly to the target URL. On macOS (WKWebView) the webview uses
    // the persistent default data store, so logging into a site once inside this
    // browser keeps you logged in across windows and app restarts — no cookie
    // copying required. (Copying cookies out of Chrome is unreliable for big
    // providers like Google, which reject `__Host-` cookies set with a domain
    // and bind sessions to the originating browser.)
    let win = WebviewWindowBuilder::new(app, &browser_id, WebviewUrl::External(parsed))
        .title("Browser")
        .inner_size(1024.0, 768.0)
        .build()
        .map_err(|e| format!("Failed to create browser window: {}", e))?;
    mgr.register(browser_id.clone(), url.to_string());

    // Register window close handler to clean up browser registry so closed
    // windows don't linger as phantom entries.
    let mgr_clone = mgr.clone();
    let browser_id_for_cleanup = browser_id.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            tracing::info!(browser_id = %browser_id_for_cleanup, "Browser window closing, unregistering");
            mgr_clone.unregister(&browser_id_for_cleanup);
        }
    });

    Ok(browser_id)
}

pub fn do_navigate(
    app: &AppHandle,
    mgr: &BrowserManager,
    browser_id: &str,
    url: &str,
) -> Result<(), String> {
    let parsed = url.parse().map_err(|e| format!("Invalid URL: {}", e))?;
    let win = get_browser(app, browser_id)?;
    win.navigate(parsed)
        .map_err(|e| format!("Navigate failed: {}", e))?;
    mgr.set_url(browser_id, url.to_string());
    Ok(())
}

pub fn do_simple_js(app: &AppHandle, browser_id: &str, js: &str) -> Result<(), String> {
    let win = get_browser(app, browser_id)?;
    win.eval(js).map_err(|e| format!("eval failed: {}", e))
}

pub fn do_eval(app: &AppHandle, browser_id: &str, script: &str) -> Result<(), String> {
    let win = get_browser(app, browser_id)?;
    win.eval(script).map_err(|e| format!("eval failed: {}", e))
}

pub fn do_get_url(app: &AppHandle, browser_id: &str) -> Result<String, String> {
    let win = get_browser(app, browser_id)?;
    win.url()
        .map(|u| u.to_string())
        .map_err(|e| format!("get_url failed: {}", e))
}

pub fn do_close(app: &AppHandle, mgr: &BrowserManager, browser_id: &str) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(browser_id) {
        win.close().map_err(|e| format!("Failed to close: {}", e))?;
    }
    mgr.unregister(browser_id);
    Ok(())
}

/// Open a new standalone popup browser window at `url`. Returns the browser_id.
#[tauri::command]
pub async fn create_browser_window(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<String, String> {
    do_create_browser_window(&app, &state.browser_manager, &url)
}

#[tauri::command]
pub async fn close_browser_window(
    app: AppHandle,
    state: State<'_, AppState>,
    browser_id: String,
) -> Result<(), String> {
    do_close(&app, &state.browser_manager, &browser_id)
}

#[tauri::command]
pub async fn list_browser_windows(
    state: State<'_, AppState>,
) -> Result<Vec<BrowserWindowInfo>, String> {
    Ok(state.browser_manager.list())
}

pub(crate) fn get_browser(
    app: &AppHandle,
    browser_id: &str,
) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window(browser_id)
        .ok_or_else(|| format!("Browser window '{}' not found", browser_id))
}

#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    state: State<'_, AppState>,
    browser_id: String,
    url: String,
) -> Result<(), String> {
    do_navigate(&app, &state.browser_manager, &browser_id, &url)
}

#[tauri::command]
pub async fn browser_back(app: AppHandle, browser_id: String) -> Result<(), String> {
    do_simple_js(&app, &browser_id, "history.back()")
}

#[tauri::command]
pub async fn browser_forward(app: AppHandle, browser_id: String) -> Result<(), String> {
    do_simple_js(&app, &browser_id, "history.forward()")
}

#[tauri::command]
pub async fn browser_reload(app: AppHandle, browser_id: String) -> Result<(), String> {
    do_simple_js(&app, &browser_id, "location.reload()")
}

#[tauri::command]
pub async fn browser_get_url(app: AppHandle, browser_id: String) -> Result<String, String> {
    do_get_url(&app, &browser_id)
}

/// Run JavaScript in a browser window, fire-and-forget. Suitable for actions
/// like clicking, typing, scrolling, or setting cookies.
///
/// NOTE: There is intentionally no result-returning variant. Browser windows
/// load EXTERNAL content (device web UIs at arbitrary IPs), and Tauri does not
/// expose `window.__TAURI__` to untrusted remote pages — they cannot call back
/// into the app. `dangerousRemoteUrlIpcAccess` only works for specific
/// pre-declared trusted domains, not arbitrary device IPs, so reading values
/// back out of the page is not feasible. See docs/spikes/spike-webview-report.md
/// and the Phase 3 spec's "External content cannot call back" decision.
#[tauri::command]
pub async fn browser_eval(
    app: AppHandle,
    browser_id: String,
    script: String,
) -> Result<(), String> {
    do_eval(&app, &browser_id, &script)
}

/// Import cookies from a source browser into an open browser window for the
/// host of that window's current URL. Returns the number of cookies injected.
#[tauri::command]
pub async fn browser_import_cookies(
    app: AppHandle,
    state: State<'_, AppState>,
    browser_id: String,
    source: String,
) -> Result<usize, String> {
    tracing::info!(browser_id = %browser_id, source = %source, "browser_import_cookies called");

    // Determine host from the window's current URL.
    let url = state.browser_manager.get_url(&browser_id).ok_or_else(|| {
        tracing::warn!(browser_id = %browser_id, "Browser window not found in registry");
        format!("Browser window '{}' not found", browser_id)
    })?;

    tracing::info!(url = %url, "Window URL retrieved from registry");

    // Extract host from URL without using url crate (simpler approach)
    let host = url
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .split('/')
        .next()
        .and_then(|h| h.split(':').next()) // strip port if present
        .unwrap_or("")
        .to_string();

    tracing::info!(host = %host, "Extracted host from URL");

    let cookies = match source.as_str() {
        "chrome" => crate::browser::read_chrome_cookies(&host),
        "safari" => crate::browser::read_safari_cookies(&host),
        other => return Err(format!("Unknown cookie source: {}", other)),
    }
    .map_err(|e| {
        tracing::error!(source = %source, host = %host, error = %e, "Failed to read cookies from source");
        format!("Failed to read {} cookies: {}", source, e)
    })?;

    tracing::info!(
        count = cookies.len(),
        "Read {} cookies from {}",
        cookies.len(),
        source
    );

    let win = get_browser(&app, &browser_id)?;
    let mut injected = 0usize;
    let mut failed = 0usize;

    for c in &cookies {
        // Build a native Tauri cookie with httpOnly/secure support.
        // KEEP the leading dot for domain cookies (e.g., ".google.com") - it signals
        // "apply to all subdomains". Only strip if there's no dot initially.
        let path = if c.path.is_empty() { "/" } else { &c.path };

        let cookie = tauri::webview::cookie::Cookie::build((c.name.as_str(), c.value.as_str()))
            .domain(&c.host) // Use the host as-is (keep leading dot if present)
            .path(path)
            .secure(c.secure)
            .http_only(c.http_only)
            .build();

        match win.set_cookie(cookie) {
            Ok(_) => {
                tracing::debug!(name = %c.name, domain = %c.host, path = %path, "Cookie set successfully");
                injected += 1;
            }
            Err(e) => {
                tracing::warn!(name = %c.name, domain = %c.host, path = %path, error = %e, "Failed to set cookie");
                failed += 1;
            }
        }
    }

    tracing::info!(
        injected = injected,
        failed = failed,
        total = cookies.len(),
        "Manual cookie import complete"
    );
    Ok(injected)
}
