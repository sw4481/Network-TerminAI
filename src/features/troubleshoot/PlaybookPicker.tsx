/**
 * Plan 15 Phase 4 — PlaybookPicker (left rail).
 *
 * Phase 5 extends the picker with a ranked suggestions surface above
 * the manual playbook list:
 *
 *  1. The operator types a symptom into the textarea.
 *  2. After a 300ms debounce we call the sidecar matcher
 *     (`troubleshootApi.matchSymptom`).
 *  3. The top-5 results render as a ranked dropdown, with the score
 *     and human-readable `reasons` chips beside each entry. Clicking
 *     a suggestion auto-selects the playbook (still requires the
 *     operator to press "Start run" — we never auto-launch a run).
 *  4. If the top score is below `MATCH_THRESHOLD` (0.35), we surface
 *     a "no good match" panel with two options:
 *       - "Start a blank run" (just selects the manual list).
 *       - "Generate a playbook with AI" — disabled, Phase 6 surface.
 *
 * The free-form symptom and JSON vars are preserved; the manual
 * playbook list still works as a fallback. Phase 5 is purely
 * additive — every existing behaviour from Phase 4 still works.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { sshDecryptPassword, sshListConnections, type SshConnection } from "../../lib/sshConnections";
import { useTroubleshootStore } from "./store";
import {
  troubleshootApi,
  type MatchResult,
  type PlaybookMeta,
  MATCH_THRESHOLD,
} from "./api";
import { PasswordPromptModal } from "../../components/PasswordPromptModal";
import "./PlaybookPicker.css";

type TargetDevice = {
  type: "current-tab";
} | {
  type: "ssh";
  connectionId: string;
  name: string;
};

export interface PlaybookPickerProps {
  /** Tab id to associate the run with. Required. */
  tabId: string;
  /** Optional vendor override forwarded to the matcher. Defaults to
   * undefined (treated as wildcard by the sidecar). */
  vendor?: string | null;
  /** Optional platform override forwarded to the matcher. Defaults to
   * undefined (treated as wildcard by the sidecar). */
  platform?: string | null;
}

/** How long after the last keystroke we wait before firing the
 * matcher. 300ms is the typical UX sweet spot — long enough to skip
 * burst-typing, short enough that the suggestions feel reactive. */
const MATCH_DEBOUNCE_MS = 300;

/** Extract unique `{{var}}` placeholder names from a playbook YAML body,
 * in first-seen order. Mirrors the engine's minijinja-style `{{ name }}`
 * substitution: we only capture simple identifiers, ignoring filters or
 * dotted paths (the engine's vars are flat string keys). */
export function extractTemplateVars(yaml: string): string[] {
  const re = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(yaml)) !== null) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Friendly example value for a variable name, used as input placeholder. */
function varPlaceholder(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("intf") || n.includes("interface") || n.includes("port"))
    return "GigabitEthernet1/0/1";
  if (n.includes("neighbor") || n.includes("peer") || n.includes("ip") || n.includes("addr"))
    return "10.0.0.5";
  if (n.includes("vlan")) return "100";
  if (n.includes("vrf")) return "default";
  if (n.includes("asn") || n.includes("as")) return "65001";
  if (n.includes("host")) return "switch1";
  return "value";
}

export function PlaybookPicker({
  tabId,
  vendor,
  platform,
}: PlaybookPickerProps) {
  const playbooks = useTroubleshootStore((s) => s.playbooks);
  const refreshPlaybooks = useTroubleshootStore((s) => s.refreshPlaybooks);
  const startRun = useTroubleshootStore((s) => s.startRun);
  const playbooksError = useTroubleshootStore((s) => s.playbooksError);

  const [selected, setSelected] = useState<string | null>(null);
  const [symptom, setSymptom] = useState<string>("");
  const [varsText, setVarsText] = useState<string>("{}");
  const [varsValid, setVarsValid] = useState<boolean>(true);
  const [starting, setStarting] = useState<boolean>(false);

  // Phase 5 — matcher state.
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [matching, setMatching] = useState<boolean>(false);
  const [matchError, setMatchError] = useState<string | null>(null);

  // Device selector state
  const [targetDevice, setTargetDevice] = useState<TargetDevice>({ type: "current-tab" });
  const [sshConnections, setSshConnections] = useState<SshConnection[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(true);

  // Password prompt state
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);

  // Required-variable detection. When a playbook is selected we fetch its
  // YAML body, scan for `{{var}}` placeholders, and render one labeled
  // input per variable so the operator isn't left guessing what the
  // (otherwise blank) "Vars (JSON)" box wants. `varValues` holds the
  // per-field text; it's the source of truth that feeds the run.
  const [requiredVars, setRequiredVars] = useState<string[]>([]);
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const [showRawVars, setShowRawVars] = useState(false);

  useEffect(() => {
    void refreshPlaybooks();
  }, [refreshPlaybooks]);

  // Load available SSH connections
  useEffect(() => {
    (async () => {
      try {
        const ssh = await sshListConnections();
        setSshConnections(ssh);
      } catch (e) {
        console.error("Failed to load SSH connections:", e);
      } finally {
        setLoadingDevices(false);
      }
    })();
  }, []);

  // When the selected playbook changes, fetch its YAML and extract the
  // `{{var}}` placeholders so we can render labeled inputs for them.
  useEffect(() => {
    let cancelled = false;
    if (!selected) {
      setRequiredVars([]);
      setVarValues({});
      return;
    }
    (async () => {
      try {
        const yaml = await troubleshootApi.getPlaybook(selected);
        if (cancelled) return;
        const names = extractTemplateVars(yaml);
        setRequiredVars(names);
        // Preserve any values the operator already typed for vars that
        // still exist; default the rest to empty.
        setVarValues((prev) => {
          const next: Record<string, string> = {};
          for (const n of names) next[n] = prev[n] ?? "";
          return next;
        });
      } catch (e) {
        if (!cancelled) {
          console.warn("Could not load playbook vars:", e);
          setRequiredVars([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // Keep the raw JSON box in sync with the per-field values so the run
  // path (which reads varsText) always sees the entered values, and the
  // "advanced" JSON view shows them too.
  useEffect(() => {
    if (requiredVars.length === 0) return;
    const obj: Record<string, string> = {};
    for (const n of requiredVars) {
      if (varValues[n]?.trim()) obj[n] = varValues[n];
    }
    setVarsText(JSON.stringify(obj, null, 2));
    setVarsValid(true);
  }, [varValues, requiredVars]);

  // Debounced matcher call. We track the latest symptom in a ref so
  // a stale fetch can't clobber a fresher result if requests overlap.
  const symptomRef = useRef<string>("");
  useEffect(() => {
    symptomRef.current = symptom;
    const trimmed = symptom.trim();
    if (!trimmed) {
      setMatches([]);
      setMatchError(null);
      setMatching(false);
      return;
    }
    setMatching(true);
    const handle = window.setTimeout(async () => {
      try {
        const out = await troubleshootApi.matchSymptom(
          trimmed,
          vendor ?? null,
          platform ?? null,
        );
        // Drop stale responses — only the latest symptom gets to
        // mutate state.
        if (symptomRef.current.trim() !== trimmed) return;
        setMatches(out);
        setMatchError(null);
      } catch (e) {
        if (symptomRef.current.trim() !== trimmed) return;
        setMatches([]);
        setMatchError(
          e instanceof Error ? e.message : String(e ?? "matcher error"),
        );
      } finally {
        if (symptomRef.current.trim() === trimmed) setMatching(false);
      }
    }, MATCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [symptom, vendor, platform]);

  const groups = useMemo(() => {
    const builtins: PlaybookMeta[] = [];
    const user: PlaybookMeta[] = [];
    for (const p of playbooks) {
      (p.builtin ? builtins : user).push(p);
    }
    return { builtins, user };
  }, [playbooks]);

  /** Quick lookup: id -> name for rendering match rows. */
  const playbookById = useMemo(() => {
    const m = new Map<string, PlaybookMeta>();
    for (const p of playbooks) m.set(p.id, p);
    return m;
  }, [playbooks]);

  /** True when the matcher has a candidate strong enough to suggest.
   * Below this we surface the no-match fallback panel. */
  const topScore = matches.length ? matches[0].score : 0;
  const hasGoodMatch = topScore >= MATCH_THRESHOLD;
  const showNoMatchPanel =
    symptom.trim().length > 0 && !matching && matches.length > 0 && !hasGoodMatch;

  const onVarsBlur = () => {
    try {
      const parsed = JSON.parse(varsText);
      setVarsValid(typeof parsed === "object" && parsed !== null);
    } catch {
      setVarsValid(false);
    }
  };

  // Variables the playbook needs that the operator hasn't filled in yet.
  const missingVars = requiredVars.filter((n) => !varValues[n]?.trim());

  const canStart =
    !!selected && varsValid && !starting && missingVars.length === 0;

  /** Parse the vars textarea; returns null (and flags invalid) on bad JSON. */
  const parseVars = (): Record<string, unknown> | null => {
    try {
      return JSON.parse(varsText) as Record<string, unknown>;
    } catch {
      setVarsValid(false);
      return null;
    }
  };

  const onStart = async () => {
    if (!selected) return;
    const vars = parseVars();
    if (vars === null) return;

    // Current-tab runs (or anything non-SSH) need no password handling.
    if (targetDevice.type !== "ssh") {
      await executeRun(vars, undefined);
      return;
    }

    // SSH: try the saved+encrypted password first.
    const conn = sshConnections.find((c) => c.id === targetDevice.connectionId);
    if (conn?.password_encrypted) {
      let password: string | undefined;
      try {
        const pwd = await sshDecryptPassword(conn.password_encrypted);
        if (pwd) password = pwd;
      } catch (e) {
        console.warn("Could not decrypt saved password:", e);
      }
      if (password) {
        await executeRun(vars, password);
        return;
      }
    }

    // No usable saved password → prompt. The modal's submit handler
    // calls executeRun directly with the entered password, so we do
    // NOT round-trip through state here (that caused a double prompt).
    setPasswordPromptOpen(true);
  };

  const executeRun = async (vars: Record<string, unknown>, password?: string) => {
    if (!selected) return;
    setStarting(true);
    try {
      const connectionId =
        targetDevice.type === "ssh" ? targetDevice.connectionId : undefined;
      await startRun({
        playbookId: selected,
        tabId,
        symptom: symptom.trim() || "(no symptom)",
        vars,
        connectionId,
        password,
      });
    } catch (e) {
      console.warn("[troubleshoot] startRun failed", e);
    } finally {
      setStarting(false);
    }
  };

  const handlePasswordSubmit = (password: string) => {
    setPasswordPromptOpen(false);
    const vars = parseVars();
    if (vars === null) return;
    void executeRun(vars, password);
  };

  const handlePasswordCancel = () => {
    setPasswordPromptOpen(false);
  };

  return (
    <div className="tb-picker" data-testid="tb-picker">
      <div className="tb-picker-device-selector">
        <div className="tb-picker-section-label">Target Device</div>
        <label className="tb-picker-device-option">
          <input
            type="radio"
            name="target-device"
            value="current-tab"
            checked={targetDevice.type === "current-tab"}
            onChange={() => setTargetDevice({ type: "current-tab" })}
            data-testid="tb-target-current-tab"
          />
          <span>Current tab</span>
        </label>

        {!loadingDevices && sshConnections.length > 0 && (
          <label className="tb-picker-device-option">
            <input
              type="radio"
              name="target-device"
              value="ssh"
              checked={targetDevice.type === "ssh"}
              onChange={() => {
                if (sshConnections.length > 0) {
                  setTargetDevice({
                    type: "ssh",
                    connectionId: sshConnections[0].id,
                    name: sshConnections[0].name,
                  });
                }
              }}
              data-testid="tb-target-ssh"
            />
            <span>SSH:</span>
            {targetDevice.type === "ssh" && (
              <select
                value={targetDevice.connectionId}
                onChange={(e) => {
                  const conn = sshConnections.find((c) => c.id === e.target.value);
                  if (conn) {
                    setTargetDevice({
                      type: "ssh",
                      connectionId: conn.id,
                      name: conn.name,
                    });
                  }
                }}
                className="tb-picker-device-dropdown"
                data-testid="tb-ssh-connection-select"
              >
                {sshConnections.map((conn) => (
                  <option key={conn.id} value={conn.id}>
                    {conn.name} ({conn.user ? `${conn.user}@` : ""}{conn.host})
                  </option>
                ))}
              </select>
            )}
          </label>
        )}

        {!loadingDevices && sshConnections.length === 0 && (
          <div className="tb-picker-device-empty">
            No saved SSH connections. Save one to target it directly.
          </div>
        )}
      </div>

      <label htmlFor="tb-picker-symptom">Symptom</label>
      <textarea
        id="tb-picker-symptom"
        rows={3}
        value={symptom}
        onChange={(e) => setSymptom(e.target.value)}
        placeholder="BGP session to 10.0.0.5 stuck in Idle (Admin)"
        data-testid="tb-picker-symptom"
      />

      {/* Phase 5 — ranked suggestions surface. Renders only when the
          symptom is non-empty so the empty state still shows the
          curated builtin list cleanly. */}
      {symptom.trim().length > 0 && (
        <div className="tb-picker-matches" data-testid="tb-picker-matches">
          <div className="tb-picker-section-label">
            Suggestions
            {matching && (
              <span
                className="tb-picker-matching-spinner"
                aria-label="matching"
              >
                …
              </span>
            )}
          </div>

          {matchError && (
            <div className="tb-picker-error" data-testid="tb-picker-match-error">
              Matcher unavailable: {matchError}
            </div>
          )}

          {!matchError && matches.length === 0 && !matching && (
            <div
              className="tb-picker-match-empty"
              data-testid="tb-picker-match-empty"
            >
              No suggestions yet — keep typing.
            </div>
          )}

          {hasGoodMatch &&
            matches.map((m) => {
              const meta = playbookById.get(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  className="tb-picker-match-row"
                  data-selected={selected === m.id}
                  data-testid={`tb-picker-match-${m.id}`}
                  onClick={() => setSelected(m.id)}
                >
                  <div className="tb-picker-match-row-head">
                    <span className="tb-picker-match-name">
                      {meta?.name ?? m.id}
                    </span>
                    <span
                      className="tb-picker-match-score"
                      data-testid={`tb-picker-match-score-${m.id}`}
                    >
                      {(m.score * 100).toFixed(0)}%
                    </span>
                  </div>
                  {m.reasons.length > 0 && (
                    <div className="tb-picker-match-reasons">
                      {m.reasons.slice(0, 3).map((r, i) => (
                        <span
                          key={i}
                          className="tb-picker-match-reason"
                          title={r}
                        >
                          {r}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}

          {showNoMatchPanel && (
            <div
              className="tb-picker-no-match"
              data-testid="tb-picker-no-match"
            >
              <div className="tb-picker-no-match-text">
                No good match (top score {(topScore * 100).toFixed(0)}%).
                Pick a playbook below, or:
              </div>
              <div className="tb-picker-no-match-actions">
                <button
                  type="button"
                  className="tb-picker-no-match-btn"
                  onClick={() => setSelected(null)}
                  data-testid="tb-picker-blank-run"
                >
                  Start a blank run
                </button>
                <button
                  type="button"
                  className="tb-picker-no-match-btn"
                  disabled
                  title="AI playbook generation lands in Phase 6"
                  data-testid="tb-picker-generate-ai"
                >
                  Generate with AI (Phase 6)
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Per-variable inputs derived from the selected playbook's
          `{{var}}` placeholders. This is the primary vars surface — it
          tells the operator EXACTLY what the playbook needs instead of
          leaving them to guess at a blank JSON box. */}
      {requiredVars.length > 0 && (
        <div className="tb-picker-vars-fields" data-testid="tb-picker-vars-fields">
          <div className="tb-picker-section-label">
            Required variables
          </div>
          {requiredVars.map((name) => (
            <label key={name} className="tb-picker-var-field">
              <span className="tb-picker-var-name">{name}</span>
              <input
                type="text"
                value={varValues[name] ?? ""}
                onChange={(e) =>
                  setVarValues((prev) => ({ ...prev, [name]: e.target.value }))
                }
                placeholder={`e.g. ${varPlaceholder(name)}`}
                data-invalid={!varValues[name]?.trim()}
                data-testid={`tb-picker-var-${name}`}
              />
            </label>
          ))}
          {missingVars.length > 0 && (
            <div
              className="tb-picker-var-hint"
              data-testid="tb-picker-var-hint"
            >
              Fill in {missingVars.length === 1 ? "this value" : "these values"} to run:{" "}
              {missingVars.join(", ")}
            </div>
          )}
          <button
            type="button"
            className="tb-picker-vars-advanced-toggle"
            onClick={() => setShowRawVars((v) => !v)}
            data-testid="tb-picker-vars-advanced"
          >
            {showRawVars ? "Hide raw JSON" : "Edit as JSON"}
          </button>
        </div>
      )}

      {/* Raw JSON editor — always available when no vars were detected
          (so power users can still pass extras), and toggleable when
          per-field inputs are shown. */}
      {(requiredVars.length === 0 || showRawVars) && (
        <>
          <label htmlFor="tb-picker-vars">Vars (JSON)</label>
          <textarea
            id="tb-picker-vars"
            rows={4}
            value={varsText}
            onChange={(e) => {
              setVarsText(e.target.value);
              setVarsValid(true);
            }}
            onBlur={onVarsBlur}
            data-invalid={!varsValid}
            data-testid="tb-picker-vars"
          />
          {!varsValid && (
            <div className="tb-picker-error" data-testid="tb-picker-vars-error">
              Vars must be a JSON object.
            </div>
          )}
        </>
      )}
      {playbooksError && (
        <div className="tb-picker-error">{playbooksError}</div>
      )}

      <div className="tb-picker-list" data-testid="tb-picker-list">
        {groups.builtins.length > 0 && (
          <div className="tb-picker-section-label">Builtin</div>
        )}
        {groups.builtins.map((p) => (
          <PlaybookRow
            key={p.id}
            p={p}
            selected={selected === p.id}
            onClick={() => setSelected(p.id)}
          />
        ))}
        {groups.user.length > 0 && (
          <div className="tb-picker-section-label">User</div>
        )}
        {groups.user.map((p) => (
          <PlaybookRow
            key={p.id}
            p={p}
            selected={selected === p.id}
            onClick={() => setSelected(p.id)}
          />
        ))}
        {playbooks.length === 0 && (
          <div
            style={{
              color: "var(--text-secondary)",
              fontSize: 11,
              padding: 6,
              textAlign: "center",
            }}
          >
            No playbooks available.
          </div>
        )}
      </div>

      <button
        type="button"
        className="tb-picker-start-btn"
        onClick={() => void onStart()}
        disabled={!canStart}
        data-testid="tb-picker-start"
      >
        {starting ? "Starting…" : "Start run ▸"}
      </button>

      <PasswordPromptModal
        isOpen={passwordPromptOpen}
        connectionName={
          targetDevice.type === "ssh"
            ? sshConnections.find((c) => c.id === targetDevice.connectionId)?.name || "Unknown"
            : ""
        }
        onSubmit={handlePasswordSubmit}
        onCancel={handlePasswordCancel}
      />
    </div>
  );
}

function PlaybookRow({
  p,
  selected,
  onClick,
}: {
  p: PlaybookMeta;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="tb-picker-row"
      data-selected={selected}
      onClick={onClick}
      data-testid={`tb-picker-row-${p.id}`}
    >
      <span>{p.name}</span>
      <span className="tb-picker-row-meta">
        {p.builtin && (
          <span className="tb-picker-row-meta-builtin">BUILTIN</span>
        )}
        <span>
          {p.vendor}/{p.platform}
        </span>
      </span>
    </button>
  );
}
