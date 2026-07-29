import Papa from "papaparse";
import { isTauri } from "./tauriCheck";

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const data = rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const c of columns) out[c] = r[c];
    return out;
  });
  return Papa.unparse({ fields: columns, data: data as Record<string, unknown>[] });
}

export function toJson(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows, null, 2);
}

const MD_PIPE_RE = /\|/g;
function escapeMdCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(MD_PIPE_RE, "\\|").replace(/\n/g, " ");
}

export function toMarkdownTable(
  rows: Record<string, unknown>[],
  columns: string[],
): string {
  if (columns.length === 0) return "";
  const header = `| ${columns.join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((r) => `| ${columns.map((c) => escapeMdCell(r[c])).join(" | ")} |`)
    .join("\n");
  return [header, sep, body].filter(Boolean).join("\n");
}

/**
 * Save text content to a file. Inside the Tauri webview, a programmatic
 * `<a download>` click is a no-op (WKWebView ignores it), so we route through
 * the native save dialog + fs plugin — the same pattern used by App.tsx's
 * change-report export and FanoutPanel. In a plain browser (and jsdom tests)
 * we fall back to the blob-anchor download. Returns false if the user cancels
 * the native dialog.
 */
export async function downloadFile(
  filename: string,
  content: string,
  mime: string,
): Promise<boolean> {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1) : "";
    const path = await save({
      defaultPath: filename,
      filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined,
    });
    if (!path) return false;
    await writeTextFile(path as string, content);
    return true;
  }

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}

export async function copyToClipboard(text: string): Promise<void> {
  // Inside the Tauri webview, navigator.clipboard.writeText is unreliable
  // (WKWebView may expose it but silently no-op without a Secure Context),
  // so route through the native clipboard-manager plugin — same rationale as
  // downloadFile using the fs plugin. Fall back to the web API in a plain
  // browser (and jsdom tests).
  if (isTauri()) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return;
  }
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
  }
}
