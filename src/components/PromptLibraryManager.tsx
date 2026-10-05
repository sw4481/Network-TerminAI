import { FormEvent, useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  emptyPromptLibrary,
  promptLibraryGet,
  promptLibrarySet,
  type PromptLibrary,
  type PromptTemplate,
} from "../lib/tauri";

const CHANGE_EVENT = "ccie-prompt-library-changed";

type Props = {
  compact?: boolean;
  onUse?: (body: string) => void;
};

type Draft = {
  id: string | null;
  title: string;
  category: string;
  body: string;
};

const blankDraft = (): Draft => ({ id: null, title: "", category: "General", body: "" });
const newId = () => `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function PromptLibraryManager({ compact = false, onUse }: Props) {
  const idPrefix = useId();
  const [library, setLibrary] = useState<PromptLibrary>(emptyPromptLibrary);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setLibrary(await promptLibraryGet());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(CHANGE_EVENT, load);
    return () => window.removeEventListener(CHANGE_EVENT, load);
  }, [load]);

  const grouped = useMemo(() => {
    const groups = new Map<string, PromptTemplate[]>();
    for (const prompt of [...library.prompts].sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title))) {
      const key = prompt.category || "General";
      groups.set(key, [...(groups.get(key) ?? []), prompt]);
    }
    return groups;
  }, [library.prompts]);

  const save = async (next: PromptTemplate[]) => {
    const saved = await promptLibrarySet({ ...library, prompts: next });
    setLibrary(saved);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const now = Date.now();
    const title = draft.title.trim();
    const category = draft.category.trim() || "General";
    const body = draft.body.trim();
    if (!title || !body) return;

    try {
      setError(null);
      if (draft.id) {
        await save(library.prompts.map((prompt) =>
          prompt.id === draft.id ? { ...prompt, title, category, body, updatedAt: now } : prompt
        ));
      } else {
        await save([...library.prompts, { id: newId(), title, category, body, createdAt: now, updatedAt: now }]);
      }
      setDraft(blankDraft());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const edit = (prompt: PromptTemplate) => {
    setDraft({ id: prompt.id, title: prompt.title, category: prompt.category || "General", body: prompt.body });
  };

  const remove = async (prompt: PromptTemplate) => {
    if (!window.confirm(`Delete saved prompt "${prompt.title}"?`)) return;
    try {
      setError(null);
      await save(library.prompts.filter((item) => item.id !== prompt.id));
      if (draft.id === prompt.id) setDraft(blankDraft());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className={compact ? "prompt-library compact" : "prompt-library tab-content"}>
      <div className="tab-header">
        <h2>{compact ? "Saved Prompts" : "Prompts"}</h2>
        {draft.id && <button className="secondary" onClick={() => setDraft(blankDraft())}>New</button>}
      </div>
      {error && <div className="error-message"><strong>Error:</strong> {error}</div>}
      <form onSubmit={submit} className="prompt-library-form">
        <div className="form-group">
          <label htmlFor={`${idPrefix}-title`}>Title</label>
          <input id={`${idPrefix}-title`} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Explain BGP issue" />
        </div>
        <div className="form-group">
          <label htmlFor={`${idPrefix}-category`}>Category</label>
          <input id={`${idPrefix}-category`} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} placeholder="Troubleshooting" />
        </div>
        <div className="form-group">
          <label htmlFor={`${idPrefix}-body`}>Prompt</label>
          <textarea id={`${idPrefix}-body`} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={compact ? 3 : 5} placeholder="Paste the reusable prompt..." />
        </div>
        <button className="primary" type="submit" disabled={!draft.title.trim() || !draft.body.trim()}>
          {draft.id ? "Save Prompt" : "Create Prompt"}
        </button>
      </form>

      {loading ? <p className="muted">Loading prompts...</p> : library.prompts.length === 0 ? (
        <p className="muted">No saved prompts yet.</p>
      ) : (
        <div className="servers-list prompt-library-list">
          {[...grouped.entries()].map(([category, prompts]) => (
            <div key={category}>
              <h3 className="prompt-library-category">{category}</h3>
              {prompts.map((prompt) => (
                <div key={prompt.id} className="server-item">
                  <div className="server-header">
                    <div className="server-name"><strong>{prompt.title}</strong></div>
                    <div className="server-actions">
                      {onUse && <button className="primary" aria-label={`Use prompt ${prompt.title}`} onClick={() => onUse(prompt.body)}>Use</button>}
                      <button className="secondary" aria-label={`Edit prompt ${prompt.title}`} onClick={() => edit(prompt)}>Edit</button>
                      <button className="delete-btn" aria-label={`Delete prompt ${prompt.title}`} onClick={() => remove(prompt)}>Delete</button>
                    </div>
                  </div>
                  {!compact && <p className="muted prompt-library-preview">{prompt.body}</p>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
