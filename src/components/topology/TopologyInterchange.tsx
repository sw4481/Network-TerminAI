import { ReactFlow, useNodesInitialized, useReactFlow, type Node } from "@xyflow/react";
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, type RefObject } from "react";
import type { TopologyPngText, TopologyPngTheme } from "../../lib/topologyPng";
import { topologyApi, TopologyProjection, type GraphSnapshot, type TopologyEdge, type TopologyImportPreview, type TopologyNode } from "../../lib/topology";
import { TopologyExport, type TopologyNodeGeometry } from "../../lib/topologyExport";
import { useTopologyStore } from "../../state/topologyStore";
import { NeighborNode } from "./NeighborNode";

const NODE_TYPES = { neighbor: NeighborNode };
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

type MeasurementReady = (geometry: TopologyNodeGeometry[], theme: TopologyPngTheme) => void;
function MeasuredNodes({ container, png, onReady, onError }: { container: RefObject<HTMLDivElement | null>; png: boolean; onReady: MeasurementReady; onError: (failure: unknown) => void }) {
  const initialized = useNodesInitialized();
  const { getNodes, getInternalNode } = useReactFlow();
  const delivered = useRef(false);
  useEffect(() => {
    if (!initialized || delivered.current || !container.current) return;
    const nodes = getNodes().map((node) => getInternalNode(node.id));
    if (nodes.some((node) => !node?.measured?.width || !node.measured?.height)) return;
    delivered.current = true;
    try {
      const elements = new Map([...container.current.querySelectorAll<HTMLElement>(".neighbor-node")].map((element) => [element.dataset.deviceRef, element]));
      const geometry = nodes.map((node) => {
        const row: TopologyNodeGeometry = { device_ref: node!.id, ...node!.position, width: node!.measured.width!, height: node!.measured.height! };
        if (!png) return row;
        const element = elements.get(node!.id);
        const source = node!.internals.handleBounds?.source?.[0], target = node!.internals.handleBounds?.target?.[0];
        if (!element || !source || !target || source.position !== "bottom" || target.position !== "top") throw new Error("Wait for complete PNG node/handle measurement.");
        const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
        const textStyle = (selector: string): TopologyPngText => {
          const text = element.querySelector<HTMLElement>(selector)!;
          const rect = text.getBoundingClientRect(), css = getComputedStyle(text);
          return { x: rect.x - bounds.x, y: rect.y - bounds.y, fontFamily: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight, fill: css.color };
        };
        const marker = element.querySelector<HTMLElement>(".neighbor-node__circle")!, css = getComputedStyle(marker);
        // offset dimensions are unrotated, so the NETCONF marker is rotated exactly once in SVG.
        row.visual = { background: style.backgroundColor, border: style.borderTopColor, accent: style.borderLeftColor,
          marker: { x: marker.offsetLeft, y: marker.offsetTop, width: marker.offsetWidth, height: marker.offsetHeight, fill: css.backgroundColor, border: css.borderTopColor },
          label: textStyle(".neighbor-node__label"), kind: textStyle(".neighbor-node__kind"),
          source: { x: source.x + source.width / 2, y: source.y + source.height }, target: { x: target.x + target.width / 2, y: target.y } };
        return row;
      });
      const style = getComputedStyle(container.current);
      onReady(geometry, { background: style.getPropertyValue("--surface-1").trim(), surface: style.getPropertyValue("--surface-2").trim(),
        text: style.getPropertyValue("--text-primary").trim(), muted: style.getPropertyValue("--text-muted").trim(), fontFamily: style.fontFamily });
    } catch (failure) { onError(failure); }
  }, [initialized, getNodes, getInternalNode, container, png, onReady, onError]);
  return null;
}

/** Measure the same node renderer, including nodes outside the current view/filter. */
function ExportMeasurement({ snapshot, png, onReady, onError }: { snapshot: GraphSnapshot; png: boolean; onReady: MeasurementReady; onError: (failure: unknown) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.resolve(document.fonts?.ready).then(() => { if (active) setFontsReady(true); });
    return () => { active = false; };
  }, []);
  const positions = new Map(snapshot.positions?.map((position) => [position.device_ref, position]));
  const nodes: Node[] = TopologyProjection.project(snapshot.nodes, snapshot.graph.id).nodes.map((node) => ({
    id: node.device_ref, type: "neighbor", position: positions.get(node.device_ref) ?? { x: 0, y: 0 },
    data: { label: node.label, vendor: (node.vendor ?? "unknown").toLowerCase(), mgmtIp: node.mgmt_ip, deviceKind: node.device_kind, deviceRef: node.device_ref, isSource: false },
  }));
  return <div ref={container} className="topology-tab__canvas topology-interchange__measurement" aria-hidden="true" inert>
    {fontsReady && <ReactFlow defaultNodes={nodes} defaultEdges={[]} nodeTypes={NODE_TYPES} nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} onlyRenderVisibleElements={false} proOptions={{ hideAttribution: true }}>
      <MeasuredNodes container={container} png={png} onReady={onReady} onError={onError} />
    </ReactFlow>}
  </div>;
}

export interface TopologyInterchangeActions { exportPng: () => void }
export const TopologyInterchange = forwardRef<TopologyInterchangeActions, {
  snapshot: GraphSnapshot | null;
  visibleNodes: TopologyNode[];
  visibleEdges: TopologyEdge[];
}>(function TopologyInterchange({ snapshot, visibleNodes, visibleEdges }, ref) {
  const [scope, setScope] = useState("filtered");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const [measurement, setMeasurement] = useState<{ snapshot: GraphSnapshot; format: "drawio" | "png"; run: AbortController } | null>(null);
  const exportRun = useRef<AbortController | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [preview, setPreview] = useState<TopologyImportPreview | null>(null);
  const [content, setContent] = useState("");
  const [name, setName] = useState("");
  const [reading, setReading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const committingRef = useRef(false);
  const request = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; exportRun.current?.abort(); }; }, []);
  useEffect(() => {
    setBusy(false); setMeasurement(null); setMessage(null);
    return () => { exportRun.current?.abort(); exportRun.current = null; busyRef.current = false; };
  }, [snapshot?.graph.id]);
  useEffect(() => {
    if (!showImport) return;
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
  }, [showImport]);

  const closeImport = () => {
    if (committingRef.current) return;
    request.current++;
    setShowImport(false); setPreview(null); setContent(""); setReading(false); setError(null);
  };
  const readFile = async (file: File | undefined) => {
    const id = ++request.current;
    setPreview(null); setContent(""); setError(null);
    if (!file) { setReading(false); return; }
    setReading(true);
    try {
      if (!file.name.toLowerCase().endsWith(".json")) throw new Error("Choose a JSON map, not an archive, directory or device inventory.");
      if (file.size > MAX_IMPORT_BYTES) throw new Error("Topology imports are limited to 10 MiB.");
      const text = await file.text();
      if (id !== request.current || !mounted.current) return;
      const result = await topologyApi.previewImport(text);
      if (id !== request.current || !mounted.current) return;
      setContent(text); setPreview(result); setName(file.name.slice(0, -5).slice(0, 200));
    } catch (failure) {
      if (id === request.current && mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally { if (id === request.current && mounted.current) setReading(false); }
  };
  const importGraph = async () => {
    if (!preview || !name.trim() || committingRef.current) return;
    committingRef.current = true; setCommitting(true); setError(null);
    const id = request.current;
    try {
      const result = await useTopologyStore.getState().importGraph(content, name.trim());
      if (id !== request.current || !mounted.current) return;
      setMessage(`Imported ${result.graph.name}. Choose it in Graph to view it; your selection was not changed.`);
      setShowImport(false); setPreview(null); setContent("");
    } catch (failure) {
      if (id === request.current && mounted.current) setError(`Import failed: ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally { committingRef.current = false; if (mounted.current) setCommitting(false); }
  };
  const exportSnapshot = (): GraphSnapshot => {
    if (!snapshot) throw new Error("Wait for the graph snapshot to finish loading.");
    const refs = new Set((scope === "all" ? snapshot.nodes : visibleNodes).map((node) => node.device_ref));
    const provenance = snapshot.import_provenance;
    const selectedEdges = scope === "all" ? snapshot.edges : visibleEdges;
    const portPair = (edge: Pick<TopologyEdge, "a_device_ref" | "a_port" | "b_device_ref" | "b_port">) =>
      JSON.stringify([JSON.stringify([edge.a_device_ref, edge.a_port]), JSON.stringify([edge.b_device_ref, edge.b_port])].sort());
    const unknownPairs = new Set(selectedEdges.filter((edge) => edge.protocol === "unknown").map(portPair));
    return structuredClone({ ...snapshot,
      nodes: snapshot.nodes.filter((node) => refs.has(node.device_ref)),
      edges: selectedEdges,
      positions: snapshot.positions?.filter((position) => refs.has(position.device_ref)),
      ...(provenance ? { import_provenance: { ...provenance,
        node_metadata: provenance.node_metadata.filter((node) => refs.has(node.device_ref)),
        unsupported_protocols: provenance.unsupported_protocols.filter((edge) => refs.has(edge.a_device_ref) && refs.has(edge.b_device_ref) && (scope === "all" || unknownPairs.has(portPair(edge)))),
      } } : {}),
    });
  };
  const finishExport = async (run: AbortController, operation: () => Promise<boolean>) => {
    const current = () => mounted.current && exportRun.current === run && !run.signal.aborted;
    try {
      run.signal.throwIfAborted();
      const saved = await operation();
      if (current()) setMessage(saved ? "Topology export saved." : "Topology export cancelled; no file saved.");
    } catch (failure) {
      if (current()) setError(`Export failed: ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally { if (current()) { exportRun.current = null; busyRef.current = false; setBusy(false); setMeasurement(null); } }
  };
  const beginExport = (format: "json" | "drawio" | "png") => {
    if (busyRef.current) return;
    setMessage(null); setError(null);
    try {
      const selected = exportSnapshot();
      // Validate bounded data before mounting potentially thousands of renderer nodes.
      TopologyExport.toJson(selected);
      const run = new AbortController(); exportRun.current = run;
      busyRef.current = true; setBusy(true); setSaving(format === "json");
      if (format === "json") void finishExport(run, () => TopologyExport.saveJson(selected, "topology.json"));
      else if (!selected.nodes.length && format === "drawio") void finishExport(run, () => TopologyExport.saveDrawio(selected, [], "topology.drawio"));
      else if (!selected.nodes.length) void finishExport(run, () => Promise.reject(new Error("Choose a graph with nodes to export PNG.")));
      else setMeasurement({ snapshot: selected, format, run });
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  useImperativeHandle(ref, () => ({ exportPng: () => beginExport("png") }));

  return <div className="topology-interchange">
    <details className="topology-interchange__options" onKeyDown={(event) => {
      if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
    }} onBlur={(event) => {
      if (!showImport && event.relatedTarget instanceof globalThis.Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
    }}>
      <summary className="topology-toolbar__button">Import &amp; export</summary>
      <div className="topology-toolbar__panel" role="group" aria-label="Offline topology interchange">
        <label className="topology-toolbar__interval">Export scope <select className="topology-toolbar__select" aria-label="Export scope" value={scope} onChange={(event) => setScope(event.target.value)} disabled={busy}>
          <option value="filtered">Complete filtered graph</option><option value="all">Full graph (ignore filters)</option>
        </select></label>
        <div className="topology-toolbar__group">
          <button type="button" className="topology-toolbar__button" disabled={!snapshot || busy} onClick={() => beginExport("json")}>Export JSON</button>
          <button type="button" className="topology-toolbar__button" disabled={!snapshot || busy} onClick={() => beginExport("drawio")}>Export Draw.io</button>
          <button type="button" className="topology-toolbar__button" disabled={!snapshot || busy} onClick={() => beginExport("png")}>Export PNG</button>
        </div>
        <p className="topology-interchange__hint">Collection source/freshness stays local; exports contain graph observations, not the local collection evidence. Native v1 JSON cannot restore that evidence on import.</p>
        <div className="topology-interchange__import">
          <button type="button" className="topology-toolbar__button" onClick={() => { setError(null); setMessage(null); setShowImport(true); }}>Import JSON</button>
          <span>Preview a map before creating a separate graph.</span>
        </div>
      </div>
    </details>
    {busy && <span role="status">{measurement ? "Measuring complete export graph…" : "Rendering / saving export…"}</span>}
    {busy && !saving && exportRun.current && <button type="button" className="topology-toolbar__button" onClick={() => { exportRun.current?.abort(); exportRun.current = null; busyRef.current = false; setBusy(false); setMeasurement(null); setMessage("Topology export cancelled."); }}>Cancel export</button>}
    {message && <p role="status">{message}</p>}
    {error && !showImport && <p role="alert">{error}</p>}
    {measurement && <ExportMeasurement snapshot={measurement.snapshot} png={measurement.format === "png"} onError={(failure) => {
      void finishExport(measurement.run, () => Promise.reject(failure));
    }} onReady={(geometry, theme) => {
      const selected = measurement; setMeasurement(null);
      if (selected.format === "drawio") setSaving(true);
      void finishExport(selected.run, () => selected.format === "png"
        ? TopologyExport.savePng(selected.snapshot, geometry, theme, "topology.png", selected.run.signal, () => {
          if (mounted.current && exportRun.current === selected.run && !selected.run.signal.aborted) setSaving(true);
        })
        : TopologyExport.saveDrawio(selected.snapshot, geometry, "topology.drawio"));
    }} />}
    {showImport && <dialog ref={dialog} className="topology-interchange__dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); closeImport(); }}>
      <h3 id={titleId}>Import topology JSON</h3>
      <p>Offline preview only. Import creates a separate named graph. No devices are contacted and no saved profiles are changed.</p>
      <label>Topology JSON file <input type="file" accept=".json,application/json" disabled={committing} onChange={(event) => { void readFile(event.target.files?.[0]); }} /></label>
      {reading && <p role="status">Validating map…</p>}
      {preview && <><p>{preview.node_count} devices · {preview.edge_count} links · {preview.placeholder_count} placeholders ({preview.format})</p>
        <p>File claims are unverified. Missing capture dates stay unknown; protocol labels do not verify physical cables.</p>
        {preview.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
        <label>Imported graph name <input value={name} maxLength={200} disabled={committing} onChange={(event) => setName(event.target.value)} /></label>
      </>}
      {error && <p role="alert">{error}</p>}
      {committing && <p role="status">Creating graph atomically. Wait for completion before closing.</p>}
      <div className="topology-toolbar__group">
        <button type="button" className="topology-toolbar__button" disabled={committing} onClick={closeImport}>Cancel import</button>
        <button type="button" className="topology-toolbar__button" disabled={!preview || reading || !name.trim() || committing} onClick={() => { void importGraph(); }}>Create imported graph</button>
      </div>
    </dialog>}
  </div>;
});
