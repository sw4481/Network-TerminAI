import { useEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { chatKey, useChatStore } from "../../state/chatStore";
import { CanvasReferenceResolver, type EvidenceRef, type EvidenceSnapshot, type ResolvedCanvasCard } from "../../lib/copilotCanvas";
import { canvasListWorkspaces, canvasRenameWorkspace } from "../../lib/tauri";
import type { Tab } from "../../lib/types";
import { useCopilotCanvas } from "../../state/copilotCanvasStore";
import { useTabs } from "../../state/tabsStore";
import { CanvasCard } from "./CanvasCard";
import "./CanvasWorkspace.css";

type FindingCard = Extract<ResolvedCanvasCard, { type: "findings" }>;
type FindingRow = { key: string; identity: string; observedRefs: EvidenceRef[]; card: FindingCard; index: number; finding: FindingCard["metadata"]["findings"][number] };
const causeText = { evidence_supported: "Evidence-supported cause", likely: "Likely cause", undetermined: "Cause undetermined" };
const severityIcon = { critical: "▲", warning: "◆", info: "●" };
const refKey = (ref: EvidenceRef) => JSON.stringify([ref.evidence_id, ref.path]);
const answerMarkdownComponents: Components = {
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h4>{children}</h4>,
  h3: ({ children }) => <h5>{children}</h5>,
  h4: ({ children }) => <h6>{children}</h6>,
  h5: ({ children }) => <h6>{children}</h6>,
  h6: ({ children }) => <h6>{children}</h6>,
  img: ({ alt }) => <>{alt}</>,
};

function Sources({ refs, evidence, label = "Redacted source" }: { refs: EvidenceRef[]; evidence: EvidenceSnapshot[]; label?: string }) {
  const resolver = new CanvasReferenceResolver(evidence);
  return <details className="canvas-sources"><summary>{label}</summary>{refs.map((ref, index) => {
    const snapshot = evidence.find(item => item.evidence_id === ref.evidence_id);
    const result = resolver.resolve(ref);
    return <section key={`${refKey(ref)}:${index}`}>
      <p><code>{ref.evidence_id}{ref.path || " (root)"}</code></p>
      {snapshot ? <><p>{snapshot.origin === "derived" ? "Derived" : snapshot.origin === "observed" ? "Observed" : snapshot.origin === "agent_authored" ? "Agent-authored — not observed" : "Execution output"} · {snapshot.source.helper} · {snapshot.source.resource ?? "Resource not supplied"}</p><p>Collected: <time dateTime={snapshot.collected_at}>{snapshot.collected_at}</time> · Call: {snapshot.call_id}</p>{snapshot.calculation && <p>Calculation: {snapshot.calculation}</p>}{snapshot.limitation && <p role="note">{snapshot.limitation}</p>}</> : <p>Source snapshot missing</p>}
      {!result.ok && <p role="note">{result.limitation} — raw retained source follows, not a successful projection.</p>}
      <pre>{JSON.stringify(result.ok ? result.value : snapshot?.data ?? null, null, 2)}</pre>
    </section>;
  })}</details>;
}

export function CanvasWorkspace({ workspaceId }: { workspaceId: string }) {
  const workspace = useCopilotCanvas(state => state.workspaces[workspaceId]);
  const bucket = chatKey(workspaceId, "network-architect");
  const messages = useChatStore(state => state.messages[bucket]);
  const streaming = useChatStore(state => state.streaming[bucket]);
  const [saved, setSaved] = useState<Tab[]>([]);
  const [openError, setOpenError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [inspected, setInspected] = useState<{ cardId: string; index: number } | null>(null);
  const inspectButtons = useRef(new Map<string, HTMLButtonElement>());
  const heading = useRef<HTMLHeadingElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const navigationRequest = useRef(0);

  useEffect(() => {
    let disposed = false;
    const unsubscribe = useTabs.subscribe((state, previous) => {
      if (state.activeTabId !== previous.activeTabId || !state.tabs.some(tab => tab.id === workspaceId)) navigationRequest.current++;
    });
    if (!useCopilotCanvas.getState().workspaces[workspaceId]) {
      void useCopilotCanvas.getState().load(workspaceId).catch(error => { if (!disposed) setOpenError(String(error)); });
    }
    void canvasListWorkspaces().then(tabs => { if (!disposed) setSaved(tabs.filter(tab => tab.tab_type === "canvas")); }, error => { if (!disposed) setListError(String(error)); });
    return () => { disposed = true; navigationRequest.current++; unsubscribe(); };
  }, [workspaceId]);
  useEffect(() => { setTitle(workspace?.tab.title ?? ""); }, [workspace?.tab.title]);
  useEffect(() => { if (inspected) backButton.current?.focus(); }, [inspected]);

  const results = workspace?.cards.map(card => ({ original: card, result: new CanvasReferenceResolver(workspace.evidence.filter(item => item.run_id === card.run_id)).resolveCard(card) })) ?? [];
  const rows: FindingRow[] = results.flatMap(({ original, result }) => {
    if (!result.ok || result.card.type !== "findings" || original.type !== "findings") return [];
    const card = result.card;
    return card.metadata.findings.map((finding, index) => ({ key: `${card.card_id}:${index}`, identity: refKey(original.metadata.findings[index].device), observedRefs: [original.metadata.findings[index].device, original.metadata.findings[index].interface, ...original.source_refs], card, index, finding }));
  });
  const filter = workspace?.view.filter ?? "";
  const visible = rows.filter(row => `${row.finding.device} ${row.finding.interface} ${row.finding.symptom} ${row.finding.severity}`.toLowerCase().includes(filter.toLowerCase()));
  // Selection is card-level in the accepted context contract. Never attach hidden findings.
  const selectable = new Set(visible.filter(row => rows.filter(other => other.card.card_id === row.card.card_id).every(other => visible.includes(other))).map(row => row.card.card_id));
  const pending = workspace?.selection.pendingCardIds ?? [];
  const hiddenPending = pending.filter(id => !selectable.has(id));
  useEffect(() => {
    if (hiddenPending.length) useCopilotCanvas.getState().setSelection(workspaceId, { pendingCardIds: pending.filter(id => selectable.has(id)) });
  }, [workspaceId, filter, workspace?.cards, pending, hiddenPending.length]);

  const openSaved = async (id: string) => {
    if (!id || id === workspaceId) return;
    setOpenError(null);
    const request = ++navigationRequest.current;
    const ownsNavigation = () => request === navigationRequest.current && useTabs.getState().activeTabId === workspaceId && useTabs.getState().tabs.some(tab => tab.id === workspaceId);
    try {
      await useCopilotCanvas.getState().load(id);
      if (!ownsNavigation()) return;
      // addTab registers AND activates atomically; stale reads may do neither.
      useTabs.getState().addTab(useCopilotCanvas.getState().workspaces[id].tab);
    } catch (error) { if (ownsNavigation()) setOpenError(String(error)); }
  };
  const rename = async () => {
    setRenaming(true); setRenameError(null);
    try {
      await canvasRenameWorkspace(workspaceId, title);
      useTabs.setState(state => ({ tabs: state.tabs.map(tab => tab.id === workspaceId ? { ...tab, title: title.trim() } : tab) }));
      useCopilotCanvas.setState(state => ({ workspaces: { ...state.workspaces, [workspaceId]: { ...state.workspaces[workspaceId], tab: { ...state.workspaces[workspaceId].tab, title: title.trim() } } } }));
      setSaved(tabs => tabs.map(tab => tab.id === workspaceId ? { ...tab, title: title.trim() } : tab));
    } catch (error) { setRenameError(String(error)); }
    finally { setRenaming(false); }
  };
  const attach = (ids: string[]) => {
    if (!workspace) return;
    useCopilotCanvas.getState().setSelection(workspaceId, { pendingCardIds: [], attachedCardIds: [...new Set([...workspace.selection.attachedCardIds, ...ids])] });
  };
  const inspect = (row: FindingRow) => {
    setInspected({ cardId: row.card.card_id, index: row.index });
    useCopilotCanvas.getState().setView(workspaceId, { inspectedCardId: row.card.card_id });
  };
  const detail = inspected ? rows.find(row => row.card.card_id === inspected.cardId && row.index === inspected.index) : undefined;
  const latest = workspace?.runs[workspace.runs.length - 1];
  const collecting = latest?.status === "collecting" || latest?.status === "awaiting_approval";
  // Live shells are never inferred finals. Only hydration marks saved final-only rows.
  // Saved answer writes can land just after ended_at; the latest run's start is the boundary.
  const finalAnswer = latest?.status === "completed" && !streaming
    ? messages?.slice().reverse().find(message => message.role === "assistant" && message.canvasFinal &&
        (message.canvasFinal.runId === latest.run_id ||
          (message.canvasFinal.runId === null && message.timestamp >= Date.parse(latest.started_at))))?.canvasFinal?.response
    : undefined;
  const answerText = finalAnswer?.trim() ?? "";
  const completePreview = answerText.match(/^[\s\S]{1,480}(?=\r?\n[ \t]*\r?\n|$)/)?.[0];
  const answerPreview = completePreview ?? answerText.slice(0, 480).replace(/\s+\S*$/, "");
  const groupNumbers = new Map([...new Set(rows.map(row => row.identity))].map((identity, index) => [identity, index + 1]));
  const groups = new Map<string, FindingRow[]>();
  visible.forEach(row => groups.set(row.identity, [...(groups.get(row.identity) ?? []), row]));

  return <section className="canvas-board" aria-label="Investigation evidence board">
    <header className="canvas-board-header"><div><p className="canvas-eyebrow">Investigation workspace</p><h1>{workspace?.tab.title ?? "Opening investigation…"}</h1><p className="canvas-muted">Historical snapshots, not live telemetry. Tools run only through the Architect.</p></div><p role="status">{workspace?.save.status === "failed" ? `Save failed: ${workspace.save.error}` : workspace?.save.status === "saving" ? "Saving…" : workspace ? "Saved evidence" : "Opening…"}</p></header>
    {finalAnswer?.trim() && <section className="canvas-card canvas-answer" aria-label="Architect’s final answer">
      <h2>Architect’s final answer</h2>
      <p className="canvas-muted">Agent-authored interpretation — not independently verified. Recommendations are not executed.</p>
      <p className="canvas-muted">{completePreview ? "Opening excerpt — complete opening paragraphs" : "Bounded preview — read full answer for complete context and instructions"}</p>
      <div className="canvas-answer-excerpt canvas-overflow" role="region" aria-label="Final-answer preview; scroll horizontally for wide content" tabIndex={0}><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={answerMarkdownComponents}>{answerPreview}</ReactMarkdown></div>
      <details key={latest?.run_id} className="canvas-answer-full"><summary>Read full answer</summary>
        <div className="canvas-answer-body canvas-overflow" role="region" aria-label="Full final answer; scroll horizontally for wide content" tabIndex={0}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={answerMarkdownComponents}>{finalAnswer}</ReactMarkdown>
        </div>
      </details>
    </section>}
    <div className="canvas-toolbar"><label>Saved investigations<select value={workspaceId} onChange={event => void openSaved(event.target.value)}><option value={workspaceId}>{workspace?.tab.title ?? "Current investigation"}</option>{saved.filter(tab => tab.id !== workspaceId).map(tab => <option key={tab.id} value={tab.id}>{tab.title}</option>)}</select></label>{workspace && <form onSubmit={event => { event.preventDefault(); void rename(); }}><label>Investigation title<input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} disabled={renaming} /></label><button disabled={renaming || !title.trim()} type="submit">Rename</button></form>}</div>
    {[openError, listError, renameError].filter(Boolean).map((error, i) => <p role="alert" key={i}>{error}</p>)}
    {workspace && <>
      <section className="canvas-notice" aria-label="Investigation status"><p>{collecting ? "Findings so far. The Architect is still collecting evidence." : `Run status: ${latest?.status ?? "Not started"}.`}</p>{latest && <details className="canvas-run-details"><summary>Run details</summary><p>Collection started: {latest.started_at}{latest.ended_at && ` · Ended: ${latest.ended_at}`}</p>{latest.scope !== null && latest.scope !== undefined && <p>Reported scope: {typeof latest.scope === "string" ? latest.scope : JSON.stringify(latest.scope)}</p>}</details>}{latest && ["failed", "cancelled", "interrupted"].includes(latest.status) && <p>Previous evidence retained unchanged; not refreshed. No automatic retry.</p>}</section>
      <section className="canvas-coverage" aria-label="Assessment coverage"><strong>{rows.length} findings across {new Set(rows.map(row => row.identity)).size} source-reference groups (not unique devices)</strong><p>Coverage unknown — assessed devices and inventory denominator not supplied by the typed contract.</p><p>Unavailable: unknown · Unassessed: unknown. Authentication failure does not establish reachability.</p><p>Checks not supplied — assessed categories and material omissions are unknown. Findings are not a complete network health verdict.</p></section>
      {workspace.warnings.map((warning, i) => <p className="canvas-notice" role="note" key={`warning:${i}`}>{typeof warning.payload === "object" && warning.payload !== null && !Array.isArray(warning.payload) && typeof warning.payload.limitation === "string" ? warning.payload.limitation : "Source warning unavailable"}</p>)}
      {workspace.limitations.map((item, i) => <p className="canvas-notice" role="note" key={`limitation:${i}`}>{item.limitation}</p>)}
      {detail ? <>
        <button ref={backButton} className="canvas-back" onClick={() => { setInspected(null); useCopilotCanvas.getState().setView(workspaceId, { inspectedCardId: null }); requestAnimationFrame(() => (inspectButtons.current.get(detail.key) ?? heading.current)?.focus()); }}>← Back to findings</button>
        <h2>{detail.finding.symptom}</h2>
        <div className="canvas-detail-grid"><section className="canvas-card"><h2>{detail.card.agent_authored ? "Reported problem" : "Observed problem"}</h2>{detail.card.agent_authored && <p className="canvas-muted">Agent-authored summary — not independently verified</p>}<dl className="canvas-facts"><div><dt>Device / interface — source values</dt><dd>{detail.finding.device} / {detail.finding.interface}</dd></div><div><dt>Observation window</dt><dd>Observation window not supplied</dd></div></dl><p className="canvas-muted">Symptom description is agent interpretation. Exact source values and any source timestamps are in the cited evidence, not an inferred before/after window.</p><Sources label={detail.card.agent_authored ? "Agent-authored content" : "Redacted source"} refs={detail.observedRefs} evidence={workspace.evidence.filter(item => item.run_id === detail.card.run_id)} /><button onClick={() => attach([detail.card.card_id])}>Add to chat</button><p className="canvas-muted">Attaches this whole card ({detail.card.metadata.findings.length} findings); does not send or authorize.</p></section>
        <section className="canvas-card"><h2>Why it may be happening</h2><p className="canvas-muted">Agent interpretation — not a verified diagnosis</p><strong>{causeText[detail.finding.cause_assessment]}</strong><Sources label="Supporting evidence" refs={detail.finding.supporting_refs} evidence={workspace.evidence.filter(item => item.run_id === detail.card.run_id)} /><Sources label="Contradictory evidence" refs={detail.finding.contradictory_refs} evidence={workspace.evidence.filter(item => item.run_id === detail.card.run_id)} /><h3>Unknowns</h3>{detail.finding.unknowns.length ? <ul>{detail.finding.unknowns.map((text, i) => <li key={i}>{text}</li>)}</ul> : <p>Unknowns not supplied; this does not establish certainty.</p>}</section>
        <section className="canvas-card canvas-remediation"><h2>Recommended remediation</h2><strong>Recommendation — not executed</strong><ul>{detail.finding.remediation_considerations.map((text, i) => <li key={i}>{text}</li>)}</ul><p className="canvas-muted">Only supplied considerations are shown. Prerequisites, risks, verification and rollback are not independently established. Ask the existing Architect to review before taking action.</p></section></div>
      </> : <>
        <section className="canvas-card canvas-findings"><header><div><h2 ref={heading} tabIndex={-1}>{collecting ? "Findings so far" : "Findings by source reference"}</h2><p className="canvas-muted">Grouped by source reference, not per unique device. Stable device identity is not supplied; repeated snapshots and identical names at distinct source paths remain separate.</p></div><label>Find findings<input value={filter} onChange={event => useCopilotCanvas.getState().setView(workspaceId, { filter: event.target.value })} /></label></header>
          <div className="canvas-overflow" role="region" aria-label="Grouped findings; scroll horizontally for all columns" tabIndex={0}><table><thead><tr><th scope="col">Select card</th><th scope="col">Issue / interface</th><th scope="col">Severity — interpretation</th><th scope="col">Cause — interpretation</th><th scope="col">Details</th></tr></thead>{[...groups].map(([identity, grouped]) => <tbody key={identity}><tr className="canvas-group"><th scope="rowgroup" colSpan={5}><span>{grouped[0].finding.device} · Source group {groupNumbers.get(identity)}</span><details><summary>Full source reference — Source group {groupNumbers.get(identity)}</summary><code>{identity}</code></details></th></tr>{grouped.map(row => <tr key={row.key}><td><input type="checkbox" aria-label={`Select ${row.card.title} (whole card, ${row.card.metadata.findings.length} findings) — ${row.finding.device} / ${row.finding.interface} — source reference ${row.identity}, ${row.card.card_id} finding ${row.index + 1}`} disabled={!selectable.has(row.card.card_id)} checked={pending.includes(row.card.card_id)} onChange={event => useCopilotCanvas.getState().setSelection(workspaceId, { pendingCardIds: event.target.checked ? [...new Set([...pending, row.card.card_id])] : pending.filter(id => id !== row.card.card_id) })} /></td><th scope="row">{row.finding.symptom}<small>{row.finding.interface}</small>{row.card.agent_authored && <small>Agent-authored summary — not independently verified</small>}</th><td><span className={`canvas-severity canvas-severity-${row.finding.severity}`}>{severityIcon[row.finding.severity]} {row.finding.severity}</span></td><td>{causeText[row.finding.cause_assessment]}</td><td><button ref={node => { if (node) inspectButtons.current.set(row.key, node); else inspectButtons.current.delete(row.key); }} aria-label={`Inspect ${row.finding.symptom} — ${row.finding.device} / ${row.finding.interface} — source reference ${row.identity}, ${row.card.card_id} finding ${row.index + 1}`} onClick={() => inspect(row)}>Inspect →</button></td></tr>)}</tbody>)}</table></div>
          {!visible.length && <p className="canvas-empty">{rows.length ? "No findings match this filter." : "No findings supplied."} This is not a network health verdict.</p>}
          <footer><span>{visible.length} displayed findings · selection attaches whole cards</span><button disabled={!pending.some(id => selectable.has(id))} onClick={() => attach(pending.filter(id => selectable.has(id)))}>Add selected cards to chat</button></footer>
        </section>
        {results.filter(({ result }) => !result.ok || result.card.type !== "findings").map(({ original, result }) => <section className="canvas-card" key={original.card_id}><h2>{original.title}</h2>{result.ok ? <>{result.card.agent_authored && <p className="canvas-muted">Agent-authored summary — not independently verified</p>}<CanvasCard card={result.card} />{result.card.type === "topology" && result.card.metadata.links.length > 0 && <Sources label="Relationship sources" refs={result.card.metadata.links.map(link => link.relationship)} evidence={workspace.evidence.filter(item => item.run_id === original.run_id)} />}{result.card.type === "assessment" && <><Sources label="Supporting evidence" refs={result.card.metadata.supporting_refs} evidence={workspace.evidence.filter(item => item.run_id === original.run_id)} /><Sources label="Contradictory evidence" refs={result.card.metadata.contradictory_refs} evidence={workspace.evidence.filter(item => item.run_id === original.run_id)} /></>}</> : <p role="note">Unsupported projection: {result.limitation}</p>}<Sources label={result.ok && result.card.agent_authored ? "Agent-authored content" : "Redacted source"} refs={original.source_refs} evidence={workspace.evidence.filter(item => item.run_id === original.run_id)} />{result.ok && <button onClick={() => attach([original.card_id])}>Add {original.title} to chat</button>}</section>)}
      </>}
      {workspace.save.unsavedCardIds.length > 0 && <p className="canvas-notice">Unsaved local evidence: {workspace.save.unsavedCardIds.join(", ")}. It may not survive reopening.</p>}
      <p className="canvas-muted">View position, filters and draft selections are local presentation state. Reopening does not refresh evidence, resume an agent, or execute tools.</p>
    </>}
  </section>;
}
