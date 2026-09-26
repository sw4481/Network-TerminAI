import { useCallback, useEffect, useState } from "react";
import {
  apiCreateEnvironment,
  apiListEnvironments,
} from "../../lib/tauri";

/** Sentinel: no environment selected (raw env-var lookup fails). */
export const NO_ENVIRONMENT = "";

type Props = {
  /** Currently-selected environment, or NO_ENVIRONMENT (empty string). */
  value: string;
  onChange: (env: string) => void;
  /** Invoked when the user opens the credentials/settings panel. */
  onOpenCredentials?: () => void;
  /** Refresh signal after an importer creates or removes an environment. */
  refreshKey?: number;
};

export function EnvironmentPicker({ value, onChange, onOpenCredentials, refreshKey }: Props) {
  const [envs, setEnvs] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const reload = useCallback(() => {
    apiListEnvironments()
      .then((list) => {
        setEnvs(list);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload, refreshKey]);

  const onAdd = useCallback(async () => {
    const name = draft.trim();
    if (!name) return;
    try {
      await apiCreateEnvironment(name);
      setAdding(false);
      setDraft("");
      reload();
      onChange(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [draft, reload, onChange]);

  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8 }}
      data-testid="api-env-picker"
    >
      <label style={{ color: "var(--text-secondary)", fontSize: 12 }}>Environment:</label>
      <select
        data-testid="api-env-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: "var(--surface-2)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-default)",
          borderRadius: 4,
          padding: "4px 8px",
          minWidth: 120,
        }}
      >
        <option value={NO_ENVIRONMENT}>— none —</option>
        {value && !(envs ?? []).includes(value) && (
          <option value={value}>{value}</option>
        )}
        {(envs ?? []).map((e) => (
          <option key={e} value={e}>
            {e}
          </option>
        ))}
      </select>
      {!adding && (
        <button
          data-testid="api-env-add"
          onClick={() => setAdding(true)}
          title="New environment"
          style={{
            background: "transparent",
            color: "var(--accent)",
            border: "1px dashed var(--border-default)",
            borderRadius: 4,
            padding: "2px 8px",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          + env
        </button>
      )}
      {adding && (
        <>
          <input
            data-testid="api-env-new-name"
            autoFocus
            placeholder="lab"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onAdd();
              if (e.key === "Escape") {
                setAdding(false);
                setDraft("");
              }
            }}
            style={{
              background: "var(--app-canvas)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: "4px 8px",
              fontFamily: "Menlo, monospace",
              fontSize: 12,
              width: 100,
            }}
          />
          <button
            data-testid="api-env-save"
            onClick={onAdd}
            style={{
              background: "var(--accent-subtle)",
              color: "var(--text-primary)",
              border: "none",
              borderRadius: 4,
              padding: "2px 8px",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            save
          </button>
        </>
      )}
      {onOpenCredentials && (
        <button
          data-testid="api-env-credentials"
          onClick={onOpenCredentials}
          disabled={!value}
          title={value ? `Edit credentials for ${value}` : "Select an environment first"}
          style={{
            background: "transparent",
            color: value ? "var(--status-warning)" : "var(--text-muted)",
            border: "1px dashed var(--border-default)",
            borderRadius: 4,
            padding: "2px 8px",
            cursor: value ? "pointer" : "not-allowed",
            fontSize: 12,
          }}
        >
          credentials
        </button>
      )}
      {error && (
        <span
          data-testid="api-env-error"
          style={{ color: "var(--status-danger)", fontSize: 11 }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
