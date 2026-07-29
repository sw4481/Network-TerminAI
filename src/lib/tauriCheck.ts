/**
 * Check if we're running inside a Tauri app or just a browser
 */
export function isTauri(): boolean {
  return typeof (window as any).__TAURI_INTERNALS__ !== 'undefined';
}
