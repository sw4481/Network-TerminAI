//! Set the macOS Dock icon at runtime.
//!
//! Tauri only applies `bundle.icon` when producing a real `.app` via
//! `tauri build`. In `tauri dev` the app runs as a bare binary with no
//! `Info.plist`, so macOS shows a generic Dock icon. To get the networking-
//! themed TerminAI icon in BOTH dev and prod, we set it explicitly at startup
//! via AppKit's `-[NSApplication setApplicationIconImage:]`.
//!
//! The PNG is embedded at compile time so there is no runtime file dependency.

/// The app icon, embedded from the generated icon set.
#[cfg(target_os = "macos")]
const ICON_PNG: &[u8] = include_bytes!("../icons/128x128@2x.png");

/// Set the Dock icon to the embedded TerminAI icon. No-op on non-macOS.
///
/// Safe to call from the Tauri `setup()` hook (main thread). Failures are
/// swallowed — a missing Dock icon is cosmetic and must never block startup.
#[cfg(target_os = "macos")]
pub fn set_dock_icon() {
    use objc2::AnyThread; // brings NSImage::alloc() into scope
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::{MainThreadMarker, NSData};

    // NSApplication APIs are main-thread-only.
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };

    // Build NSData from the embedded PNG bytes, then an NSImage from that.
    let data = NSData::with_bytes(ICON_PNG);
    let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
        return;
    };

    let app = NSApplication::sharedApplication(mtm);
    // SAFETY: main-thread-checked above (MainThreadMarker); passing a valid NSImage.
    unsafe { app.setApplicationIconImage(Some(&image)) };
}

/// No-op stub on non-macOS targets so callers don't need their own `cfg`.
#[cfg(not(target_os = "macos"))]
pub fn set_dock_icon() {}
