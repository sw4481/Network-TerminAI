import { useCallback, useEffect, useState } from "react";
import {
  apiDeleteEnvVar,
  apiGetEnvVars,
  apiSetEnvVar,
  type ApiEnvVar,
} from "../../lib/tauri";
import {
  CREDENTIAL_PRESETS,
  findPreset,
  type CredentialPreset,
} from "./credentialPresets";

type Props = {
  environment: string;
  onClose: () => void;
  /**
   * Keys that the currently-picked target/endpoint references via
   * `${env:X}` or `${var:X}`. Missing ones get a warning badge; the
   * "Add missing rows" button creates empty rows for every missing
   * key so the user can fill in values instead of guessing names.
   */
  requiredKeys?: string[];
  /**
   * Active target id. When it matches a known preset (meraki, dnac, ise,
   * sna), the panel opens with that preset's Quick Setup section expanded.
   */
  targetId?: string | null;
};

/**
 * Modal-ish credentials editor for one environment. Lists every key, lets
 * the user add / edit / delete rows. Secrets render masked with an
 * unmask toggle per row.
 *
 * The backend writes `~/.ccie-terminal/environments/<env>.env` atomically
 * with chmod 600 — the user never touches those files directly.
 */
export function CredentialsPanel({
  environment,
  onClose,
  requiredKeys = [],
  targetId,
}: Props) {
  const [rows, setRows] = useState<ApiEnvVar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  // Local per-row draft buffer so typing doesn't hit the backend on every
  // keystroke; we commit on blur or Enter.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [addKey, setAddKey] = useState("");
  const [addValue, setAddValue] = useState("");
  const [addSecret, setAddSecret] = useState(true);

  const reload = useCallback(() => {
    apiGetEnvVars(environment)
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, [environment]);

  useEffect(() => {
    reload();
  }, [reload]);

  const upsert = useCallback(
    async (key: string, value: string, is_secret: boolean) => {
      try {
        await apiSetEnvVar({ environment, key, value, isSecret: is_secret });
        reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [environment, reload],
  );

  const remove = useCallback(
    async (key: string) => {
      try {
        await apiDeleteEnvVar(environment, key);
        reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [environment, reload],
  );

  const onAdd = async () => {
    const k = addKey.trim();
    if (!k || !addValue) return;
    await upsert(k, addValue, addSecret);
    setAddKey("");
    setAddValue("");
  };

  // Compute the set of required keys that don't yet exist in this env.
  // Case-sensitive — env var names in .env files are case-sensitive,
  // and the Rust resolver looks them up exactly.
  const existingKeys = new Set((rows ?? []).map((r) => r.key));
  const missingRequired = requiredKeys.filter((k) => !existingKeys.has(k));

  // Which preset (if any) matches the active target. Opens to that tab.
  const initialPresetId =
    (targetId && findPreset(targetId) && targetId) ||
    CREDENTIAL_PRESETS[0]?.id ||
    null;
  const [activePreset, setActivePreset] = useState<string | null>(
    initialPresetId,
  );
  const currentPreset: CredentialPreset | null = activePreset
    ? findPreset(activePreset) ?? null
    : null;

  // Per-field draft for the Quick Setup inputs (separate from the table
  // draft map so the two sections can't collide).
  const [presetDrafts, setPresetDrafts] = useState<Record<string, string>>({});
  const rowValue = useCallback(
    (key: string) => rows?.find((r) => r.key === key)?.value ?? "",
    [rows],
  );
  // Save a single preset field. Accepts an explicit value so the caller
  // can clear the draft atomically.
  const savePresetField = useCallback(
    async (envKey: string, value: string, isSecret: boolean) => {
      try {
        await apiSetEnvVar({ environment, key: envKey, value, isSecret });
        setPresetDrafts((d) => {
          const { [envKey]: _, ...rest } = d;
          return rest;
        });
        reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [environment, reload],
  );

  return (
    <div
      data-testid="api-credentials-panel"
      role="dialog"
      aria-label={`Credentials for ${environment}`}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgb(var(--backdrop-rgb) / 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 20,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "var(--surface-2)",
          border: "1px solid var(--border-default)",
          borderRadius: 6,
          padding: 16,
          width: 560,
          maxWidth: "90vw",
          maxHeight: "80vh",
          overflowY: "auto",
          color: "var(--text-primary)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
          }}
        >
          <h3 style={{ margin: 0 }}>
            Credentials — <span style={{ color: "var(--accent)" }}>{environment}</span>
          </h3>
          <button
            data-testid="api-credentials-close"
            onClick={onClose}
            style={{
              background: "transparent",
              color: "var(--text-secondary)",
              border: "none",
              cursor: "pointer",
              fontSize: 18,
            }}
          >
            ×
          </button>
        </div>
        <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: 0 }}>
          Values are saved to <code>environments/{environment}.env</code>{" "}
          (chmod 600). Never hand-edit that file — use this panel.
        </p>
        {/* Quick Setup — preset-driven labeled inputs for built-in targets.
            Writes directly to `<env>.env` with the correct env var names
            so users don't have to know them. */}
        <div
          data-testid="api-credentials-presets"
          style={{
            border: "1px solid var(--border-default)",
            borderRadius: 4,
            padding: 8,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            background: "var(--app-canvas)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              flexWrap: "wrap",
            }}
          >
            <span style={{ color: "var(--text-secondary)", fontSize: 11, marginRight: 4 }}>
              Quick setup:
            </span>
            {CREDENTIAL_PRESETS.map((p) => (
              <button
                key={p.id}
                data-testid={`api-credentials-preset-${p.id}`}
                onClick={() => setActivePreset(p.id)}
                style={{
                  background:
                    activePreset === p.id ? "var(--surface-selected)" : "transparent",
                  color: activePreset === p.id ? "var(--text-primary)" : "var(--text-secondary)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: "2px 10px",
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          {currentPreset && (
            <>
              <p
                style={{
                  color: "var(--text-secondary)",
                  fontSize: 11,
                  margin: 0,
                }}
              >
                {currentPreset.description}
              </p>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "140px 1fr",
                  gap: "4px 10px",
                  alignItems: "center",
                }}
              >
                {currentPreset.fields.map((f) => {
                  const stored = rowValue(f.envKey);
                  const draft = presetDrafts[f.envKey];
                  const value = draft ?? stored;
                  const dirty = draft !== undefined && draft !== stored;
                  const isMissing = f.required && !stored;
                  return (
                    <PresetRow
                      key={f.envKey}
                      label={f.label}
                      hint={f.hint}
                      envKey={f.envKey}
                      value={value}
                      dirty={dirty}
                      missing={isMissing}
                      isSecret={f.isSecret}
                      onChange={(v) =>
                        setPresetDrafts((d) => ({ ...d, [f.envKey]: v }))
                      }
                      onCommit={() =>
                        savePresetField(f.envKey, value, f.isSecret)
                      }
                      onRevert={() =>
                        setPresetDrafts((d) => {
                          const { [f.envKey]: _, ...rest } = d;
                          return rest;
                        })
                      }
                    />
                  );
                })}
              </div>
            </>
          )}
        </div>

        {missingRequired.length > 0 && (
          <div
            data-testid="api-credentials-missing"
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--status-warning)",
              borderRadius: 4,
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              fontSize: 12,
            }}
          >
            <div style={{ color: "var(--status-warning)", fontWeight: 600 }}>
              Missing required variables for the selected target
            </div>
            <div style={{ color: "var(--text-primary)", fontFamily: "Menlo, monospace" }}>
              {missingRequired.join(", ")}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                data-testid="api-credentials-add-required"
                onClick={async () => {
                  // Create empty rows for every missing key so the user
                  // just has to fill in values instead of retyping names
                  // from the manifest. Heuristic for `is_secret`:
                  // ALL_CAPS_SNAKE → secret (API keys, passwords),
                  // camelCase / kebab-case → non-secret (IDs, hosts, path
                  // params like `organizationId`).
                  for (const k of missingRequired) {
                    const isSecret = /^[A-Z][A-Z0-9_]*$/.test(k);
                    try {
                      await apiSetEnvVar({
                        environment,
                        key: k,
                        value: "",
                        isSecret,
                      });
                    } catch (err) {
                      setError(
                        err instanceof Error ? err.message : String(err),
                      );
                      break;
                    }
                  }
                  reload();
                }}
                style={{
                  background: "var(--status-warning)",
                  color: "var(--surface-2)",
                  border: "none",
                  borderRadius: 4,
                  padding: "3px 10px",
                  cursor: "pointer",
                  fontWeight: 600,
                  fontSize: 11,
                }}
              >
                Add missing rows
              </button>
            </div>
          </div>
        )}
        {error && (
          <div
            data-testid="api-credentials-error"
            style={{
              color: "var(--status-danger)",
              background: "var(--surface-2)",
              border: "1px solid var(--status-danger)",
              borderRadius: 4,
              padding: 6,
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}
        <table
          style={{
            borderCollapse: "collapse",
            fontSize: 12,
            fontFamily: "Menlo, monospace",
          }}
        >
          <thead>
            <tr style={{ color: "var(--text-secondary)", textAlign: "left" }}>
              <th style={{ padding: "4px 6px" }}>Key</th>
              <th style={{ padding: "4px 6px" }}>Value</th>
              <th style={{ padding: "4px 6px" }}>Secret</th>
              <th style={{ padding: "4px 6px" }}></th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((row) => {
              const shown = reveal[row.key] || !row.is_secret;
              const draft = drafts[row.key];
              const current = draft ?? row.value;
              const dirty = draft !== undefined && draft !== row.value;
              const commit = async () => {
                if (!dirty) return;
                await upsert(row.key, current, row.is_secret);
                setDrafts((d) => {
                  const { [row.key]: _, ...rest } = d;
                  return rest;
                });
              };
              return (
                <tr
                  key={row.key}
                  data-testid={`api-credentials-row-${row.key}`}
                >
                  <td style={{ padding: "4px 6px" }}>{row.key}</td>
                  <td style={{ padding: "4px 6px" }}>
                    <input
                      data-testid={`api-credentials-value-${row.key}`}
                      type={shown ? "text" : "password"}
                      value={current}
                      placeholder="(empty — click to edit)"
                      onChange={(e) =>
                        setDrafts((d) => ({ ...d, [row.key]: e.target.value }))
                      }
                      onBlur={commit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          (e.target as HTMLInputElement).blur();
                        } else if (e.key === "Escape") {
                          setDrafts((d) => {
                            const { [row.key]: _, ...rest } = d;
                            return rest;
                          });
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      style={{
                        background: dirty ? "var(--surface-2)" : "var(--app-canvas)",
                        color: "var(--text-primary)",
                        border: `1px solid ${dirty ? "var(--status-success)" : "var(--border-default)"}`,
                        borderRadius: 4,
                        padding: "2px 6px",
                        fontFamily: "Menlo, monospace",
                        fontSize: 12,
                        minWidth: 180,
                      }}
                    />
                    {dirty && (
                      <span
                        data-testid={`api-credentials-dirty-${row.key}`}
                        style={{
                          color: "var(--status-success)",
                          fontSize: 10,
                          marginLeft: 6,
                        }}
                      >
                        unsaved
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "4px 6px" }}>
                    <input
                      type="checkbox"
                      data-testid={`api-credentials-secret-${row.key}`}
                      checked={row.is_secret}
                      onChange={(e) =>
                        upsert(row.key, current, e.target.checked)
                      }
                    />
                  </td>
                  <td style={{ padding: "4px 6px", display: "flex", gap: 4 }}>
                    {row.is_secret && (
                      <button
                        data-testid={`api-credentials-reveal-${row.key}`}
                        onClick={() =>
                          setReveal({ ...reveal, [row.key]: !reveal[row.key] })
                        }
                        style={linkBtn}
                      >
                        {reveal[row.key] ? "hide" : "show"}
                      </button>
                    )}
                    {dirty && (
                      <button
                        data-testid={`api-credentials-save-${row.key}`}
                        onClick={commit}
                        style={{ ...linkBtn, color: "var(--status-success)" }}
                      >
                        save
                      </button>
                    )}
                    <button
                      data-testid={`api-credentials-delete-${row.key}`}
                      onClick={() => remove(row.key)}
                      style={{ ...linkBtn, color: "var(--status-danger)" }}
                    >
                      delete
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows && rows.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  style={{
                    color: "var(--text-muted)",
                    padding: 8,
                    fontStyle: "italic",
                  }}
                  data-testid="api-credentials-empty"
                >
                  No variables yet. Add one below.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div
          style={{
            borderTop: "1px solid var(--border-default)",
            paddingTop: 8,
            display: "flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          <input
            data-testid="api-credentials-new-key"
            placeholder="KEY"
            value={addKey}
            onChange={(e) => setAddKey(e.target.value)}
            style={field}
          />
          <input
            data-testid="api-credentials-new-value"
            placeholder="value"
            type={addSecret ? "password" : "text"}
            value={addValue}
            onChange={(e) => setAddValue(e.target.value)}
            style={{ ...field, flex: 1 }}
          />
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              color: "var(--text-secondary)",
              fontSize: 12,
            }}
          >
            <input
              type="checkbox"
              data-testid="api-credentials-new-secret"
              checked={addSecret}
              onChange={(e) => setAddSecret(e.target.checked)}
            />
            secret
          </label>
          <button
            data-testid="api-credentials-add"
            onClick={onAdd}
            disabled={!addKey.trim() || !addValue}
            style={{
              background:
                !addKey.trim() || !addValue ? "var(--surface-selected)" : "var(--accent-subtle)",
              color: "var(--text-primary)",
              border: "none",
              borderRadius: 4,
              padding: "4px 12px",
              cursor:
                !addKey.trim() || !addValue ? "not-allowed" : "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            add
          </button>
        </div>
      </div>
    </div>
  );
}

function PresetRow({
  label,
  hint,
  envKey,
  value,
  dirty,
  missing,
  isSecret,
  onChange,
  onCommit,
  onRevert,
}: {
  label: string;
  hint: string;
  envKey: string;
  value: string;
  dirty: boolean;
  missing: boolean;
  isSecret: boolean;
  onChange: (v: string) => void;
  onCommit: () => void;
  onRevert: () => void;
}) {
  const [reveal, setReveal] = useState(false);
  const shown = reveal || !isSecret;
  return (
    <>
      <label
        htmlFor={`api-preset-${envKey}`}
        style={{
          color: missing ? "var(--status-warning)" : "var(--text-primary)",
          fontSize: 12,
          fontWeight: 600,
          whiteSpace: "nowrap",
        }}
        title={`env var name: ${envKey}`}
      >
        {label}
        {missing && <span style={{ marginLeft: 4 }}>*</span>}
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          id={`api-preset-${envKey}`}
          data-testid={`api-preset-${envKey}`}
          type={shown ? "text" : "password"}
          value={value}
          placeholder={hint}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              onRevert();
              (e.target as HTMLInputElement).blur();
            }
          }}
          style={{
            flex: 1,
            background: dirty ? "var(--surface-2)" : "var(--app-canvas)",
            color: "var(--text-primary)",
            border: `1px solid ${
              dirty ? "var(--status-success)" : missing ? "var(--status-warning)" : "var(--surface-selected)"
            }`,
            borderRadius: 4,
            padding: "4px 8px",
            fontFamily: "Menlo, monospace",
            fontSize: 12,
          }}
        />
        {isSecret && (
          <button
            data-testid={`api-preset-reveal-${envKey}`}
            type="button"
            onClick={() => setReveal((r) => !r)}
            style={{
              background: "transparent",
              color: "var(--accent)",
              border: "none",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            {reveal ? "hide" : "show"}
          </button>
        )}
        {dirty && (
          <button
            data-testid={`api-preset-save-${envKey}`}
            type="button"
            onClick={onCommit}
            style={{
              background: "transparent",
              color: "var(--status-success)",
              border: "none",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            save
          </button>
        )}
      </div>
    </>
  );
}

const linkBtn: React.CSSProperties = {
  background: "transparent",
  color: "var(--accent)",
  border: "none",
  cursor: "pointer",
  fontSize: 11,
  padding: 0,
};

const field: React.CSSProperties = {
  background: "var(--app-canvas)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-default)",
  borderRadius: 4,
  padding: "4px 8px",
  fontFamily: "Menlo, monospace",
  fontSize: 12,
};
