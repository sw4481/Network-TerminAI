import { useEffect, useMemo, useState } from "react";
import { useKanbanStore, type KanbanTask } from "../state/kanbanStore";
import "./KanbanTab.css";

const columns: KanbanTask["status"][] = ["ready", "running", "blocked", "review", "done", "cancelled"];
const label = (status: KanbanTask["status"]) => status[0].toUpperCase() + status.slice(1);

export function KanbanTab() {
  const { tasks, selected, load, inspect, create, stop, retry, approve, subscribe } = useKanbanStore();
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [paneContext, setPaneContext] = useState("");
  const [completionMode, setCompletionMode] = useState<KanbanTask["completionMode"]>("autonomous");
  const [expanded, setExpanded] = useState<KanbanTask["status"]>("ready");
  const [filter, setFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [showGuidance, setShowGuidance] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void load();
    let unlisten: (() => void) | undefined;
    void subscribe().then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, [load, subscribe]);

  const visibleTasks = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return tasks.filter((task) => task.status === expanded && (!query ||
      `${task.title} ${task.details} ${task.assignedAgent ?? ""}`.toLowerCase().includes(query)));
  }, [tasks, expanded, filter]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await create(title, details, completionMode, paneContext);
      setTitle(""); setDetails(""); setPaneContext(""); setCompletionMode("autonomous");
      setExpanded("ready"); setFilter(""); setCreateOpen(false);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  return <div className="kanban-tab">
    <header className="kanban-toolbar">
      <div className="kanban-title"><h1>Kanban</h1><span>{tasks.length}</span></div>
      <label className="kanban-filter"><span className="kanban-search-icon" aria-hidden="true">⌕</span>
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter cards…" aria-label="Filter cards" />
      </label>
      <button className="kanban-new-task" onClick={() => { setError(""); setCreateOpen(true); }}>＋ New task</button>
    </header>

    {showGuidance && <aside className="kanban-guidance">
      <p>Add work to Ready. CCIE Terminal routes each task to a configured agent; results and activity appear on its card. Stop, retry, or approve reviewed work from the board.</p>
      <button onClick={() => setShowGuidance(false)} aria-label="Dismiss Kanban guidance">Got it</button>
    </aside>}

    {error && <p className="kanban-error" role="alert">{error}</p>}

    <div className="kanban-board" aria-label="Kanban board">
      {columns.map((status) => {
        const statusTasks = tasks.filter((task) => task.status === status);
        const isExpanded = expanded === status;
        return <section role="region" className={`kanban-column kanban-column-${status}${isExpanded ? " is-expanded" : ""}`} key={status} aria-label={`${label(status)} tasks`}>
          <button className="kanban-lane-toggle" aria-label={`${label(status)} ${statusTasks.length}`} aria-expanded={isExpanded} onClick={() => setExpanded(status)}>
            <span className="kanban-status-dot" aria-hidden="true" />
            <span className="kanban-lane-label">{label(status)}</span>
            <span className="kanban-lane-count">{statusTasks.length}</span>
          </button>
          {isExpanded && <div className="kanban-lane-content">
            {visibleTasks.map((task) => <button className={`kanban-card${selected?.task.id === task.id ? " selected" : ""}`} key={task.id} onClick={() => void inspect(task.id)}>
              <strong>{task.title}</strong>
              {task.result && <p>{task.result}</p>}
              <small>{task.assignedAgent || "Unassigned"}</small>
            </button>)}
            {visibleTasks.length === 0 && <p className="kanban-empty">{filter ? "No matching cards" : status === "ready" ? "Add a task to get started" : "No cards"}</p>}
          </div>}
        </section>;
      })}
    </div>

    {selected && <aside className="kanban-detail">
      <header><div><h2>{selected.task.title}</h2><span>{label(selected.task.status)} · {selected.task.assignedAgent || "Unassigned"}</span></div>
        {(["ready", "running"] as KanbanTask["status"][]).includes(selected.task.status) && <button disabled={busy} onClick={() => void act(() => stop(selected.task.id))}>Stop</button>}
        {(["blocked", "cancelled", "done", "review"] as KanbanTask["status"][]).includes(selected.task.status) && !selected.runs.some((run) => run.status === "running") && <button disabled={busy} onClick={() => void act(() => retry(selected.task.id))}>Retry</button>}
        {selected.task.status === "review" && <button disabled={busy} onClick={() => void act(() => approve(selected.task.id))}>Approve</button>}
      </header>
      {selected.task.details && <p>{selected.task.details}</p>}
      <h3>Activity</h3>
      <ol>{[...selected.activity].reverse().map((item) => <li key={item.id}><span>{item.message}</span><time>{new Date(item.createdAt * 1000).toLocaleString()}</time></li>)}</ol>
      {selected.runs.length > 0 && <details><summary>Run history ({selected.runs.length})</summary><ol>{selected.runs.map((run) => <li key={run.id}>Attempt {run.attempt}: {run.status}{run.error ? ` — ${run.error}` : ""}</li>)}</ol></details>}
    </aside>}

    {createOpen && <div className="kanban-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreateOpen(false); }}>
      <section className="kanban-create-dialog" role="dialog" aria-modal="true" aria-labelledby="kanban-create-heading">
        <header><div><h2 id="kanban-create-heading">New task</h2><p>Create a card for a configured agent to work on.</p></div>
          <button type="button" className="kanban-dialog-close" aria-label="Close new task" onClick={() => setCreateOpen(false)}>×</button>
        </header>
        <form className="kanban-create" onSubmit={submit}>
          <label>Task title<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Check branch connectivity" maxLength={240} required /></label>
          <label>What should the agent do?<textarea value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Describe the expected result and any constraints" /></label>
          <label>Optional terminal pane context<input value={paneContext} onChange={(e) => setPaneContext(e.target.value)} placeholder="Paste relevant terminal context" /></label>
          <label>Completion<select value={completionMode} onChange={(e) => setCompletionMode(e.target.value as KanbanTask["completionMode"])}>
            <option value="autonomous">Finish automatically</option><option value="human_review">Require human review</option>
          </select></label>
          {error && <p className="kanban-error" role="alert">{error}</p>}
          <footer><button type="button" className="kanban-cancel" onClick={() => setCreateOpen(false)}>Cancel</button><button type="submit" className="kanban-new-task" disabled={busy || !title.trim()}>Add task</button></footer>
        </form>
      </section>
    </div>}
  </div>;
}
