import { invoke } from '@tauri-apps/api/core';

export interface BrowserWindowInfo {
  browserId: string;
  url: string;
}

export async function createBrowserWindow(url: string): Promise<string> {
  return invoke('create_browser_window', { url });
}

export async function closeBrowserWindow(browserId: string): Promise<void> {
  return invoke('close_browser_window', { browserId });
}

export async function listBrowserWindows(): Promise<BrowserWindowInfo[]> {
  return invoke('list_browser_windows');
}

export async function browserNavigate(browserId: string, url: string): Promise<void> {
  return invoke('browser_navigate', { browserId, url });
}

export async function browserBack(browserId: string): Promise<void> {
  return invoke('browser_back', { browserId });
}

export async function browserForward(browserId: string): Promise<void> {
  return invoke('browser_forward', { browserId });
}

export async function browserReload(browserId: string): Promise<void> {
  return invoke('browser_reload', { browserId });
}

export async function browserGetUrl(browserId: string): Promise<string> {
  return invoke('browser_get_url', { browserId });
}

// Fire-and-forget JS execution (click, type, scroll, set cookies). There is
// no result-returning variant: browser windows load external content that
// cannot call back into Tauri (no window.__TAURI__ on untrusted remote pages).
export async function browserEval(browserId: string, script: string): Promise<void> {
  return invoke('browser_eval', { browserId, script });
}

export async function browserImportCookies(browserId: string, source: 'chrome' | 'safari'): Promise<number> {
  return invoke('browser_import_cookies', { browserId, source });
}
