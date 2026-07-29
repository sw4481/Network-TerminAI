/**
 * Plan 14 — clipboard auto-clear utility.
 *
 * Writes `text` to the clipboard via `navigator.clipboard.writeText` and
 * schedules an auto-clear after `ttlMs`. The clear only fires if the
 * clipboard still contains our bytes — if the user copied something else
 * after, we leave their content alone.
 *
 * Repeated calls cancel the previous timer so only the latest schedule
 * survives.
 */

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingValue: string | null = null;

const CLEAR_PLACEHOLDER = "​"; // zero-width space

export async function copyWithAutoClear(
  text: string,
  ttlMs = 30_000,
): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    return;
  }
  await navigator.clipboard.writeText(text);
  pendingValue = text;
  if (pendingTimer != null) {
    clearTimeout(pendingTimer);
  }
  pendingTimer = setTimeout(async () => {
    try {
      let current: string | null = null;
      try {
        current = await navigator.clipboard.readText();
      } catch {
        // readText permission may be denied; fall through and skip the
        // overwrite to avoid clobbering user content we can't verify.
        pendingTimer = null;
        pendingValue = null;
        return;
      }
      if (current === pendingValue) {
        await navigator.clipboard.writeText(CLEAR_PLACEHOLDER);
      }
    } finally {
      pendingTimer = null;
      pendingValue = null;
    }
  }, ttlMs);
}

export function _resetClipboardState() {
  if (pendingTimer != null) {
    clearTimeout(pendingTimer);
  }
  pendingTimer = null;
  pendingValue = null;
}
