/**
 * Render a unix timestamp (seconds) as a short relative string like
 * `30s ago` / `1m ago` / `2d ago`. Used by the palette meta column.
 *
 * Boundaries match the cheap-and-cheerful Twitter convention rather than
 * Intl.RelativeTimeFormat — we want compact, monospace-friendly output.
 *
 * - <60s → `Ns ago`
 * - <60m → `Nm ago`
 * - <24h → `Nh ago`
 * - <7d  → `Nd ago`
 * - <4w  → `Nw ago`
 * - <12mo → `Nmo ago`
 * - else → `Ny ago`
 *
 * @param tsSeconds unix timestamp in seconds
 * @param nowSeconds optional override of the current time (defaults to Date.now())
 */
export function formatTimeAgo(tsSeconds: number, nowSeconds?: number): string {
  const now = nowSeconds ?? Date.now() / 1000;
  const age = Math.max(0, Math.floor(now - tsSeconds));

  if (age < 60) return `${age}s ago`;
  const minutes = Math.floor(age / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(age / 3600);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(age / 86400);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(age / 604800);
  if (weeks < 4) return `${weeks}w ago`;
  const months = Math.floor(age / 2_592_000);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(age / 31_536_000);
  return `${years}y ago`;
}
