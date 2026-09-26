import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  DiagramPanel,
  isSafeDiagramUrl,
  buildViewerSrcDoc,
  buildMarkmapSrcDoc,
  escapeHtmlAttr,
} from "./DiagramPanel";
import { useDiagramStore } from "../state/diagramStore";
import type { DiagramEvent } from "../lib/tauri";

const openUrlMock = vi.fn(async () => {});
const appearance = vi.hoisted(() => ({
  appTheme: "terminai-dark" as "terminai-dark" | "slate-grey" | "matrix",
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string) => openUrlMock(url),
}));

vi.mock("../theme/AppearanceProvider", () => ({
  useAppearance: () => ({ settings: { appTheme: appearance.appTheme } }),
}));

beforeEach(() => {
  useDiagramStore.setState({ diagrams: [], selectedId: null });
  openUrlMock.mockClear();
  appearance.appTheme = "terminai-dark";
});

function addXmlDiagram(): void {
  const ev: DiagramEvent = {
    type: "diagram",
    title: "Campus topology",
    format: "xml",
    xml: "<mxGraphModel><root/></mxGraphModel>",
    source: null,
    url: "https://app.diagrams.net/?edit=_blank#create=abc",
  };
  useDiagramStore.getState().addDiagram(ev);
}

describe("isSafeDiagramUrl", () => {
  it("accepts known https draw.io hosts", () => {
    expect(isSafeDiagramUrl("https://app.diagrams.net/#create=x")).toBe(true);
    expect(isSafeDiagramUrl("https://viewer.diagrams.net/#x")).toBe(true);
    expect(isSafeDiagramUrl("https://www.draw.io/#x")).toBe(true);
    expect(isSafeDiagramUrl("https://draw.io/#x")).toBe(true);
  });

  it("rejects non-https schemes", () => {
    expect(isSafeDiagramUrl("http://app.diagrams.net/#x")).toBe(false);
    expect(isSafeDiagramUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeDiagramUrl("data:text/html,<script>")).toBe(false);
    expect(isSafeDiagramUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects allowlist-bypass attempts", () => {
    // userinfo trick
    expect(isSafeDiagramUrl("https://app.diagrams.net@evil.com/#x")).toBe(false);
    // subdomain suffix
    expect(isSafeDiagramUrl("https://evil.draw.io/#x")).toBe(false);
    expect(isSafeDiagramUrl("https://app.diagrams.net.evil.com/#x")).toBe(false);
    // trailing-dot variant resolves to a different hostname
    expect(isSafeDiagramUrl("https://app.diagrams.net./#x")).toBe(false);
    // homograph / punycode
    expect(isSafeDiagramUrl("https://app.diagrams.nеt/#x")).toBe(false);
    // unrelated host
    expect(isSafeDiagramUrl("https://attacker.example/#x")).toBe(false);
  });

  it("rejects malformed input", () => {
    expect(isSafeDiagramUrl("not a url")).toBe(false);
    expect(isSafeDiagramUrl("")).toBe(false);
  });
});

describe("escapeHtmlAttr", () => {
  it("escapes all attribute-breaking characters", () => {
    expect(escapeHtmlAttr(`a&b"c<d>e'f`)).toBe(
      "a&amp;b&quot;c&lt;d&gt;e&#39;f",
    );
  });
});

describe("buildViewerSrcDoc", () => {
  it("embeds the xml in a data-mxgraph attribute with no raw quote breakout", () => {
    const malicious =
      '<mxCell value="\\"></div><script>alert(1)</script>" />';
    const doc = buildViewerSrcDoc(malicious);
    // The raw closing-tag/script sequence must not appear verbatim.
    expect(doc).not.toContain("</div><script>alert(1)");
    // A real quote must never survive inside the attribute payload — it is
    // entity-escaped. (The only literal quotes are the attribute delimiters.)
    const attrValue = doc.split('data-mxgraph="')[1].split('">')[0];
    expect(attrValue).not.toContain('"');
    expect(attrValue).toContain("&quot;");
  });

  it("includes a strict child CSP that fails closed on network egress", () => {
    const doc = buildViewerSrcDoc("<x/>");
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("connect-src &#39;none&#39;");
    expect(doc).toContain("img-src &#39;self&#39; data:");
    // loads the vendored viewer by external src (CSP-safe)
    expect(doc).toContain('src="/drawio/viewer-static.min.js"');
  });

  it("injects resolved Dark, Grey, and Matrix values for isolated documents", () => {
    expect(buildViewerSrcDoc("<x/>", "terminai-dark")).toContain("--app-canvas: #0f1114");
    expect(buildViewerSrcDoc("<x/>", "slate-grey")).toContain("--app-canvas: #17191c");
    expect(buildViewerSrcDoc("<x/>", "matrix")).toContain("--app-canvas: #030703");
    expect(buildMarkmapSrcDoc("# map", "matrix")).toContain("--status-danger:#ff6b6b");
  });
});

describe("DiagramPanel", () => {
  it("shows the empty state with no diagrams", () => {
    render(<DiagramPanel />);
    expect(screen.getByText(/No diagrams yet/i)).toBeInTheDocument();
  });

  it("renders an inline iframe for native xml diagrams", () => {
    addXmlDiagram();
    render(<DiagramPanel />);
    const frame = screen.getByTestId("diagram-iframe") as HTMLIFrameElement;
    expect(frame).toBeInTheDocument();
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin",
    );
    expect(frame.getAttribute("srcdoc")).toContain("data-mxgraph");
  });

  it("regenerates iframe srcDoc when the provider changes Dark to Grey to Matrix", () => {
    addXmlDiagram();
    const view = render(<DiagramPanel />);
    const srcDoc = () => (screen.getByTestId("diagram-iframe") as HTMLIFrameElement)
      .getAttribute("srcdoc") ?? "";

    expect(srcDoc()).toContain("--app-canvas: #0f1114");
    appearance.appTheme = "slate-grey";
    view.rerender(<DiagramPanel />);
    expect(srcDoc()).toContain("--app-canvas: #17191c");
    expect(srcDoc()).not.toContain("--app-canvas: #0f1114");

    appearance.appTheme = "matrix";
    view.rerender(<DiagramPanel />);
    expect(srcDoc()).toContain("--app-canvas: #030703");
    expect(srcDoc()).not.toContain("--app-canvas: #17191c");
  });

  it("shows the fallback (no iframe) for mermaid diagrams", () => {
    useDiagramStore.getState().addDiagram({
      type: "diagram",
      title: "Flow",
      format: "mermaid",
      xml: null,
      source: "graph TD; A-->B",
      url: "https://app.diagrams.net/#create=z",
    });
    render(<DiagramPanel />);
    expect(screen.getByTestId("diagram-fallback")).toBeInTheDocument();
    expect(screen.queryByTestId("diagram-iframe")).not.toBeInTheDocument();
  });

  it("renders an inline <img> for a Kroki image (data-URI) diagram", () => {
    useDiagramStore.getState().addDiagram({
      type: "diagram",
      title: "UML",
      format: "image",
      xml: null,
      source: "@startuml\nA->B\n@enduml",
      url: "",
      image_url: "data:image/svg+xml;base64,PHN2Zy8+",
    });
    render(<DiagramPanel />);
    const img = screen.getByTestId("diagram-image").querySelector("img");
    expect(img).toBeInTheDocument();
    expect(img?.getAttribute("src")).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    expect(screen.queryByTestId("diagram-iframe")).not.toBeInTheDocument();
  });

  it("renders an inline iframe for a markmap diagram", () => {
    useDiagramStore.getState().addDiagram({
      type: "diagram",
      title: "OSPF",
      format: "markmap",
      xml: null,
      source: "# OSPF\n## LSA Types",
      url: "",
    });
    render(<DiagramPanel />);
    const frame = screen.getByTestId("diagram-iframe") as HTMLIFrameElement;
    expect(frame).toBeInTheDocument();
    // markmap srcdoc loads the locally vendored bundle, not a CDN.
    expect(frame.getAttribute("srcdoc")).toContain("/markmap/markmap-init.js");
    expect(frame.getAttribute("srcdoc")).toContain("markmap-source");
  });

  it("opens a safe url via the opener plugin", async () => {
    addXmlDiagram();
    render(<DiagramPanel />);
    const btn = screen.getAllByRole("button", { name: /open in draw\.io/i })[0];
    btn.click();
    await Promise.resolve();
    expect(openUrlMock).toHaveBeenCalledWith(
      "https://app.diagrams.net/?edit=_blank#create=abc",
    );
  });

  it("disables open + never calls opener for an unsafe url", async () => {
    useDiagramStore.getState().addDiagram({
      type: "diagram",
      title: "Evil",
      format: "xml",
      xml: "<x/>",
      source: null,
      url: "https://attacker.example/#create=abc",
    });
    render(<DiagramPanel />);
    const btn = screen.getAllByRole("button", {
      name: /open in draw\.io/i,
    })[0] as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    btn.click();
    await Promise.resolve();
    expect(openUrlMock).not.toHaveBeenCalled();
  });
});
