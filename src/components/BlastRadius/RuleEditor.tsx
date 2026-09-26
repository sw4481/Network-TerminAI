import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  rulesList,
  ruleUpsert,
  ruleDelete,
  ruleSetEnabled,
  rulesetReload,
  testRegex,
  rulesExport,
  rulesImport,
  type GuardrailRule,
} from "../../lib/guardrails";
import "./RuleEditor.css";

const VENDORS = ["cisco", "juniper", "arista", "*"];
const PLATFORMS_BY_VENDOR: Record<string, string[]> = {
  cisco: ["iosxe", "ios", "nxos", "*"],
  juniper: ["junos", "*"],
  arista: ["eos", "*"],
  "*": ["*"],
};

const TIER_LABELS: Record<number, string> = {
  0: "T0 read-only",
  1: "T1 local-write",
  2: "T2 forwarding",
  3: "T3 service-affecting",
};

function blankRule(): GuardrailRule {
  return {
    id: "",
    name: "New rule",
    vendor: "cisco",
    platform: "iosxe",
    pattern_regex: "^\\s*command\\b",
    tier: 1,
    reason: "Why this rule fires.",
    enabled: true,
    builtin: false,
  };
}

export function RuleEditor() {
  const [rules, setRules] = useState<GuardrailRule[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<GuardrailRule | null>(null);
  const [search, setSearch] = useState("");
  const [regexError, setRegexError] = useState<string | null>(null);
  const [testInput, setTestInput] = useState("");
  const [testResult, setTestResult] = useState<{
    matched: boolean;
    error: string | null;
  } | null>(null);
  const [importExportOpen, setImportExportOpen] = useState(false);
  const optionRefs = useRef(new Map<string, HTMLLIElement>());

  const loadRules = useCallback(async () => {
    try {
      const list = await rulesList();
      setRules(list);
    } catch (e) {
      console.error("rulesList failed", e);
    }
  }, []);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rules;
    return rules.filter((r) =>
      `${r.name} ${r.vendor} ${r.platform} ${r.pattern_regex}`
        .toLowerCase()
        .includes(q),
    );
  }, [rules, search]);

  const select = useCallback((rule: GuardrailRule) => {
    setSelectedId(rule.id);
    setActiveId(rule.id);
    setDraft({ ...rule });
    setRegexError(null);
    setTestResult(null);
  }, []);

  const tabbableId =
    filtered.find((rule) => rule.id === activeId)?.id ??
    filtered.find((rule) => rule.id === selectedId)?.id ??
    filtered[0]?.id ??
    null;

  const handleRuleKeyDown = (
    event: React.KeyboardEvent<HTMLLIElement>,
    rule: GuardrailRule,
  ) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(rule);
      return;
    }

    const currentIndex = filtered.findIndex((item) => item.id === rule.id);
    let targetIndex = currentIndex;
    if (event.key === "ArrowDown") {
      targetIndex = Math.min(currentIndex + 1, filtered.length - 1);
    } else if (event.key === "ArrowUp") {
      targetIndex = Math.max(currentIndex - 1, 0);
    } else if (event.key === "Home") {
      targetIndex = 0;
    } else if (event.key === "End") {
      targetIndex = filtered.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const target = filtered[targetIndex];
    if (!target) return;
    setActiveId(target.id);
    optionRefs.current.get(target.id)?.focus();
  };

  const handleNew = useCallback(() => {
    const r = blankRule();
    setSelectedId(null);
    setDraft(r);
    setRegexError(null);
    setTestResult(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    if (draft.builtin) {
      alert("Builtin rules cannot be modified.");
      return;
    }
    try {
      const id = await ruleUpsert(draft);
      await loadRules();
      const fresh = (await rulesList()).find((r) => r.id === id) ?? null;
      if (fresh) select(fresh);
    } catch (e) {
      setRegexError(String(e));
    }
  }, [draft, loadRules, select]);

  const handleDelete = useCallback(async () => {
    if (!draft || !draft.id || draft.builtin) return;
    if (!confirm(`Delete rule "${draft.name}"?`)) return;
    try {
      await ruleDelete(draft.id);
      await loadRules();
      setDraft(null);
      setSelectedId(null);
    } catch (e) {
      alert(`Delete failed: ${e}`);
    }
  }, [draft, loadRules]);

  const handleToggle = useCallback(
    async (rule: GuardrailRule) => {
      try {
        await ruleSetEnabled(rule.id, !rule.enabled);
        await loadRules();
        if (draft?.id === rule.id) {
          setDraft({ ...rule, enabled: !rule.enabled });
        }
      } catch (e) {
        alert(`Toggle failed: ${e}`);
      }
    },
    [draft, loadRules],
  );

  const handleTest = useCallback(async () => {
    if (!draft) return;
    try {
      const r = await testRegex(draft.pattern_regex, testInput);
      setTestResult(r);
    } catch (e) {
      setTestResult({ matched: false, error: String(e) });
    }
  }, [draft, testInput]);

  const handleExport = useCallback(async () => {
    try {
      const json = await rulesExport();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `guardrail-rules-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Export failed: ${e}`);
    }
  }, []);

  const handleImport = useCallback(async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const report = await rulesImport(text);
        await rulesetReload();
        await loadRules();
        alert(
          `Imported ${report.imported} rule(s); skipped ${report.skipped_builtin} builtin(s).` +
            (report.errors.length ? `\nErrors:\n${report.errors.join("\n")}` : ""),
        );
      } catch (e) {
        alert(`Import failed: ${e}`);
      }
    };
    input.click();
  }, [loadRules]);

  // Keyboard shortcuts: Cmd+N new, Cmd+S save, Cmd+Enter test, Esc close-edit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "n") {
        e.preventDefault();
        handleNew();
      } else if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
      } else if (meta && e.key === "Enter") {
        e.preventDefault();
        void handleTest();
      } else if (e.key === "Escape" && draft) {
        // Cancel unsaved edits.
        setDraft(null);
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, handleNew, handleSave, handleTest]);

  return (
    <div className="rule-editor" data-testid="rule-editor">
      <div className="rule-list">
        <div className="rule-list-header">
          <h3>Guardrail rules ({filtered.length})</h3>
          <div className="actions">
            <button className="primary" onClick={handleNew} data-testid="re-new">
              New rule
            </button>
            <button onClick={() => setImportExportOpen((o) => !o)}>I/O</button>
          </div>
          {importExportOpen && (
            <div className="actions">
              <button onClick={handleExport} data-testid="re-export">
                Export
              </button>
              <button onClick={handleImport} data-testid="re-import">
                Import
              </button>
            </div>
          )}
        </div>
        <div className="rule-search">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by name/vendor/regex…"
            data-testid="re-search"
          />
        </div>
        <ul className="rule-list-items" role="listbox" aria-label="Blast Radius rules">
          {filtered.map((r) => (
            <li
              key={r.id}
              className={
                (selectedId === r.id ? "selected " : "") +
                (r.enabled ? "" : "disabled")
              }
              role="option"
              aria-selected={selectedId === r.id}
              tabIndex={tabbableId === r.id ? 0 : -1}
              ref={(element) => {
                if (element) optionRefs.current.set(r.id, element);
                else optionRefs.current.delete(r.id);
              }}
              onFocus={(event) => {
                if (event.target === event.currentTarget) setActiveId(r.id);
              }}
              onKeyDown={(event) => handleRuleKeyDown(event, r)}
              onClick={() => select(r)}
              data-testid={`re-rule-${r.id}`}
            >
              <span className={`badge ${r.builtin ? "builtin" : "user"}`}>
                {r.builtin ? "B" : "U"}
              </span>
              <span className={`badge tier-${r.tier}`}>T{r.tier}</span>
              <span className="name" title={r.name}>
                {r.name}
              </span>
              <input
                type="checkbox"
                checked={r.enabled}
                onClick={(e) => e.stopPropagation()}
                onChange={() => handleToggle(r)}
                aria-label={`Toggle ${r.name}`}
              />
            </li>
          ))}
        </ul>
      </div>

      <div className="rule-detail" data-testid="rule-detail">
        {!draft ? (
          <div className="empty-state">
            Select a rule from the list, or create a new one (⌘N).
          </div>
        ) : (
          <>
            <div className="rule-detail-header">
              <label>Name</label>
              <input
                type="text"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                data-testid="re-name"
                disabled={draft.builtin}
                style={{ flex: "1 1 200px" }}
              />
              <label>Vendor</label>
              <select
                value={draft.vendor}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    vendor: e.target.value,
                    platform: PLATFORMS_BY_VENDOR[e.target.value]?.[0] ?? "*",
                  })
                }
                disabled={draft.builtin}
                data-testid="re-vendor"
              >
                {VENDORS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
              <label>Platform</label>
              <select
                value={draft.platform}
                onChange={(e) => setDraft({ ...draft, platform: e.target.value })}
                disabled={draft.builtin}
                data-testid="re-platform"
              >
                {(PLATFORMS_BY_VENDOR[draft.vendor] ?? ["*"]).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <label>Tier</label>
              <select
                value={draft.tier}
                onChange={(e) =>
                  setDraft({ ...draft, tier: parseInt(e.target.value, 10) })
                }
                disabled={draft.builtin}
                data-testid="re-tier"
              >
                {[0, 1, 2, 3].map((t) => (
                  <option key={t} value={t}>
                    {TIER_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>

            <div className="rule-pattern">
              <label>Pattern (Rust regex)</label>
              <textarea
                value={draft.pattern_regex}
                className={regexError ? "invalid" : ""}
                onChange={(e) =>
                  setDraft({ ...draft, pattern_regex: e.target.value })
                }
                spellCheck={false}
                disabled={draft.builtin}
                data-testid="re-regex"
              />
              {regexError && <div className="err">{regexError}</div>}
              <label style={{ marginTop: 8 }}>Reason (shown to user)</label>
              <textarea
                value={draft.reason}
                onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                disabled={draft.builtin}
                style={{ minHeight: 50 }}
                data-testid="re-reason"
              />
            </div>

            <div className="rule-tester">
              <label>Test against sample (uses Rust regex engine)</label>
              <textarea
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                placeholder="Enter a sample command to test against this rule…"
                data-testid="re-test-input"
              />
              <div>
                <button onClick={handleTest} data-testid="re-test-btn">
                  Test (⌘↵)
                </button>
                {testResult && (
                  <span
                    className={
                      "result " +
                      (testResult.error
                        ? "error"
                        : testResult.matched
                        ? "match"
                        : "no-match")
                    }
                    style={{ marginLeft: 12 }}
                    data-testid="re-test-result"
                  >
                    {testResult.error
                      ? `Error: ${testResult.error}`
                      : testResult.matched
                      ? "✓ MATCH"
                      : "✗ no match"}
                  </span>
                )}
              </div>
            </div>

            <div className="rule-footer">
              {!draft.builtin && draft.id && (
                <button
                  className="danger"
                  onClick={handleDelete}
                  data-testid="re-delete"
                >
                  Delete
                </button>
              )}
              <button
                className="primary"
                onClick={handleSave}
                disabled={draft.builtin}
                data-testid="re-save"
              >
                Save (⌘S)
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
