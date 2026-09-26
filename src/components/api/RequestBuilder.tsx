import { useState } from "react";
import type { BodyKind, HttpMethod } from "../../lib/tauri";
import { useApiRunner } from "../../state/apiRunnerStore";
import type { ApiTabState } from "../../state/apiRunnerStore";
import { isSendable } from "../../state/apiRunnerStore";

type PanelKey = "params" | "headers" | "body" | "auth";

const METHODS: HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

const BODY_KINDS: BodyKind[] = ["none", "json", "form", "text", "binary"];

export function RequestBuilder({
  tabId,
  onSend,
  onSaveRequest,
}: {
  tabId: string;
  onSend: () => void;
  onSaveRequest?: () => void;
}) {
  const tabs = useApiRunner((s) => s.tabs);
  const patch = useApiRunner((s) => s.patch);
  const setHeaders = useApiRunner((s) => s.setHeaders);
  const setQuery = useApiRunner((s) => s.setQuery);

  // Ensure lazy init on first render.
  const state: ApiTabState =
    tabs[tabId] ?? useApiRunner.getState().ensure(tabId);

  const [panel, setPanel] = useState<PanelKey>("params");

  const canSend = isSendable(state);

  return (
    <div
      className="api-request-builder"
      data-testid="api-request-builder"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        minWidth: 0,
      }}
    >
      {/* Row 1: method + url + send */}
      <div style={{ display: "flex", gap: 8 }}>
        <select
          aria-label="HTTP method"
          data-testid="api-method"
          value={state.method}
          onChange={(e) =>
            patch(tabId, { method: e.target.value as HttpMethod })
          }
          style={{
            background: "var(--surface-2)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-default)",
            borderRadius: 4,
            padding: "4px 8px",
          }}
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="https://api.meraki.com/api/v1/organizations"
          aria-label="Request URL"
          data-testid="api-url"
          value={state.url}
          onChange={(e) => patch(tabId, { url: e.target.value })}
          style={{
            flex: 1,
            background: "var(--app-canvas)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-default)",
            borderRadius: 4,
            padding: "4px 8px",
            fontFamily: "Menlo, monospace",
          }}
        />
        <button
          data-testid="api-send"
          disabled={!canSend}
          onClick={onSend}
          style={{
            background: canSend ? "var(--accent-subtle)" : "var(--surface-3)",
            color: "var(--text-primary)",
            border: "none",
            borderRadius: 4,
            padding: "4px 16px",
            cursor: canSend ? "pointer" : "not-allowed",
            fontWeight: 600,
          }}
        >
          {state.sending ? "Sending..." : "Send"}
        </button>
        {onSaveRequest && (
          <button
            data-testid="api-save-request"
            onClick={onSaveRequest}
            disabled={!canSend}
            title="Save this request"
            aria-label="Save request"
            style={{
              background: "transparent",
              color: canSend ? "var(--status-warning)" : "var(--text-muted)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: "4px 10px",
              cursor: canSend ? "pointer" : "not-allowed",
              fontSize: 16,
            }}
          >
            ★
          </button>
        )}
      </div>

      {/* Row 2: sub-panel tabs */}
      <div style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--border-default)" }}>
        {(["params", "headers", "body", "auth"] as PanelKey[]).map((k) => (
          <button
            key={k}
            data-testid={`api-panel-${k}`}
            onClick={() => setPanel(k)}
            style={{
              background: panel === k ? "var(--surface-3)" : "transparent",
              color: panel === k ? "var(--text-primary)" : "var(--text-secondary)",
              border: "none",
              borderBottom:
                panel === k ? "2px solid var(--accent)" : "2px solid transparent",
              padding: "6px 12px",
              cursor: "pointer",
              fontSize: 12,
              textTransform: "capitalize",
            }}
          >
            {k}
          </button>
        ))}
      </div>

      {panel === "params" && (
        <KVEditor
          testIdPrefix="api-query"
          rows={state.query}
          onChange={(rows) => setQuery(tabId, rows)}
        />
      )}
      {panel === "headers" && (
        <KVEditor
          testIdPrefix="api-header"
          rows={state.headers}
          onChange={(rows) => setHeaders(tabId, rows)}
        />
      )}
      {panel === "body" && <BodyEditor tabId={tabId} state={state} />}
      {panel === "auth" && <AuthEditor tabId={tabId} state={state} />}
    </div>
  );
}

function KVEditor({
  rows,
  onChange,
  testIdPrefix,
}: {
  rows: Array<{ key: string; value: string }>;
  onChange: (next: Array<{ key: string; value: string }>) => void;
  testIdPrefix: string;
}) {
  const update = (i: number, patch: Partial<{ key: string; value: string }>) => {
    const next = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    onChange(next);
  };
  const remove = (i: number) =>
    onChange(rows.filter((_, idx) => idx !== i));
  const add = () => onChange([...rows, { key: "", value: "" }]);
  return (
    <div
      data-testid={`${testIdPrefix}-editor`}
      style={{ display: "flex", flexDirection: "column", gap: 4 }}
    >
      {rows.map((r, i) => (
        <div
          key={i}
          style={{ display: "flex", gap: 4 }}
          data-testid={`${testIdPrefix}-row-${i}`}
        >
          <input
            placeholder="key"
            value={r.key}
            aria-label={`${testIdPrefix} key ${i}`}
            onChange={(e) => update(i, { key: e.target.value })}
            style={kvInputStyle}
          />
          <input
            placeholder="value"
            value={r.value}
            aria-label={`${testIdPrefix} value ${i}`}
            onChange={(e) => update(i, { value: e.target.value })}
            style={kvInputStyle}
          />
          <button
            onClick={() => remove(i)}
            aria-label={`remove ${testIdPrefix} row ${i}`}
            style={removeBtnStyle}
          >
            ×
          </button>
        </div>
      ))}
      <button
        onClick={add}
        data-testid={`${testIdPrefix}-add`}
        style={{
          alignSelf: "flex-start",
          background: "transparent",
          color: "var(--accent)",
          border: "1px dashed var(--border-default)",
          padding: "4px 10px",
          borderRadius: 4,
          cursor: "pointer",
          fontSize: 12,
        }}
      >
        + Add
      </button>
    </div>
  );
}

function BodyEditor({
  tabId,
  state,
}: {
  tabId: string;
  state: ApiTabState;
}) {
  const patch = useApiRunner((s) => s.patch);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label style={{ color: "var(--text-secondary)", fontSize: 12 }}>Body kind:</label>
        <select
          data-testid="api-body-kind"
          value={state.body_kind}
          onChange={(e) =>
            patch(tabId, { body_kind: e.target.value as BodyKind })
          }
          style={kvInputStyle}
        >
          {BODY_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
      {state.body_kind !== "none" && state.body_kind !== "binary" && (
        <textarea
          data-testid="api-body-text"
          value={state.body_text}
          onChange={(e) => patch(tabId, { body_text: e.target.value })}
          placeholder={state.body_kind === "json" ? "{}" : "key=value"}
          rows={8}
          style={{
            background: "var(--app-canvas)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-default)",
            borderRadius: 4,
            padding: 8,
            fontFamily: "Menlo, monospace",
            fontSize: 12,
            resize: "vertical",
          }}
        />
      )}
      {state.body_kind === "binary" && (
        <div style={{ color: "var(--text-secondary)", fontSize: 12 }}>
          Binary uploads arrive in a later step.
        </div>
      )}
    </div>
  );
}

function AuthEditor({
  tabId,
  state,
}: {
  tabId: string;
  state: ApiTabState;
}) {
  const patch = useApiRunner((s) => s.patch);
  const auth = state.auth;

  const onTypeChange = (t: string) => {
    switch (t) {
      case "none":
        patch(tabId, { auth: { type: "none" } });
        break;
      case "header":
        patch(tabId, { auth: { type: "header", name: "", value: "" } });
        break;
      case "basic":
        patch(tabId, {
          auth: { type: "basic", username: "", password: "" },
        });
        break;
      case "bearer":
        patch(tabId, { auth: { type: "bearer", token: "" } });
        break;
      case "token_login":
        patch(tabId, {
          auth: {
            type: "token_login",
            login: {
              method: "POST",
              url: "",
              credentials: { type: "basic", username: "", password: "" },
              token_jsonpath: "$.Token",
            },
            apply: { mode: "header", name: "X-Auth-Token" },
            refresh_on_status: [401],
          },
        });
        break;
      case "session_cookie":
        patch(tabId, {
          auth: {
            type: "session_cookie",
            login: {
              method: "POST",
              url: "",
              credentials: { type: "basic", username: "", password: "" },
            },
          },
        });
        break;
      case "hook":
        patch(tabId, {
          auth: { type: "hook", module: "", function: "sign_request" },
        });
        break;
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label style={{ color: "var(--text-secondary)", fontSize: 12 }}>Type:</label>
        <select
          data-testid="api-auth-type"
          value={auth.type}
          onChange={(e) => onTypeChange(e.target.value)}
          style={kvInputStyle}
        >
          <option value="none">None</option>
          <option value="header">Header</option>
          <option value="basic">Basic</option>
          <option value="bearer">Bearer</option>
          <option value="token_login">Token Login (DNA-C / SNA)</option>
          <option value="session_cookie">Session Cookie (NDFC / vManage)</option>
          <option value="hook">Python Hook (Intersight HMAC, etc.)</option>
        </select>
      </div>
      {auth.type === "header" && (
        <>
          <input
            data-testid="api-auth-header-name"
            placeholder="Header name (e.g. X-Cisco-Meraki-API-Key)"
            value={auth.name}
            onChange={(e) =>
              patch(tabId, {
                auth: { ...auth, name: e.target.value },
              })
            }
            style={kvInputStyle}
          />
          <input
            data-testid="api-auth-header-value"
            type="password"
            placeholder="Header value"
            value={auth.value}
            onChange={(e) =>
              patch(tabId, {
                auth: { ...auth, value: e.target.value },
              })
            }
            style={kvInputStyle}
          />
        </>
      )}
      {auth.type === "basic" && (
        <>
          <input
            data-testid="api-auth-basic-user"
            placeholder="Username"
            value={auth.username}
            onChange={(e) =>
              patch(tabId, {
                auth: { ...auth, username: e.target.value },
              })
            }
            style={kvInputStyle}
          />
          <input
            data-testid="api-auth-basic-pass"
            type="password"
            placeholder="Password"
            value={auth.password}
            onChange={(e) =>
              patch(tabId, {
                auth: { ...auth, password: e.target.value },
              })
            }
            style={kvInputStyle}
          />
        </>
      )}
      {auth.type === "bearer" && (
        <input
          data-testid="api-auth-bearer-token"
          type="password"
          placeholder="Bearer token"
          value={auth.token}
          onChange={(e) =>
            patch(tabId, {
              auth: { ...auth, token: e.target.value },
            })
          }
          style={kvInputStyle}
        />
      )}
      {auth.type === "token_login" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <input
            data-testid="api-auth-token-login-url"
            placeholder="Login URL (e.g. /dna/system/api/v1/auth/token)"
            value={auth.login.url}
            onChange={(e) =>
              patch(tabId, {
                auth: {
                  ...auth,
                  login: { ...auth.login, url: e.target.value },
                },
              })
            }
            style={kvInputStyle}
          />
          {auth.login.credentials.type === "basic" && (
            <>
              <input
                data-testid="api-auth-token-login-user"
                placeholder="Username"
                value={auth.login.credentials.username}
                onChange={(e) => {
                  if (auth.login.credentials.type !== "basic") return;
                  const creds = auth.login.credentials;
                  patch(tabId, {
                    auth: {
                      ...auth,
                      login: {
                        ...auth.login,
                        credentials: {
                          type: "basic",
                          username: e.target.value,
                          password: creds.password,
                        },
                      },
                    },
                  });
                }}
                style={kvInputStyle}
              />
              <input
                data-testid="api-auth-token-login-pass"
                type="password"
                placeholder="Password"
                value={auth.login.credentials.password}
                onChange={(e) => {
                  if (auth.login.credentials.type !== "basic") return;
                  const creds = auth.login.credentials;
                  patch(tabId, {
                    auth: {
                      ...auth,
                      login: {
                        ...auth.login,
                        credentials: {
                          type: "basic",
                          username: creds.username,
                          password: e.target.value,
                        },
                      },
                    },
                  });
                }}
                style={kvInputStyle}
              />
            </>
          )}
          <input
            data-testid="api-auth-token-login-jsonpath"
            placeholder="Token JSONPath (e.g. $.Token)"
            value={auth.login.token_jsonpath}
            onChange={(e) =>
              patch(tabId, {
                auth: {
                  ...auth,
                  login: { ...auth.login, token_jsonpath: e.target.value },
                },
              })
            }
            style={kvInputStyle}
          />
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <label style={{ color: "var(--text-secondary)", fontSize: 11 }}>Apply as:</label>
            <select
              data-testid="api-auth-token-apply"
              value={auth.apply.mode}
              onChange={(e) => {
                const mode = e.target.value;
                if (mode === "bearer") {
                  patch(tabId, { auth: { ...auth, apply: { mode: "bearer" } } });
                } else {
                  patch(tabId, {
                    auth: {
                      ...auth,
                      apply: { mode: "header", name: "X-Auth-Token" },
                    },
                  });
                }
              }}
              style={kvInputStyle}
            >
              <option value="header">Header</option>
              <option value="bearer">Bearer</option>
            </select>
            {auth.apply.mode === "header" && (
              <input
                data-testid="api-auth-token-header-name"
                placeholder="Header name"
                value={auth.apply.name}
                onChange={(e) =>
                  patch(tabId, {
                    auth: {
                      ...auth,
                      apply: { mode: "header", name: e.target.value },
                    },
                  })
                }
                style={kvInputStyle}
              />
            )}
          </div>
        </div>
      )}
      {auth.type === "session_cookie" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <input
            data-testid="api-auth-session-url"
            placeholder="Login URL"
            value={auth.login.url}
            onChange={(e) =>
              patch(tabId, {
                auth: {
                  ...auth,
                  login: { ...auth.login, url: e.target.value },
                },
              })
            }
            style={kvInputStyle}
          />
          {auth.login.credentials.type === "basic" && (
            <>
              <input
                data-testid="api-auth-session-user"
                placeholder="Username"
                value={auth.login.credentials.username}
                onChange={(e) => {
                  if (auth.login.credentials.type !== "basic") return;
                  const creds = auth.login.credentials;
                  patch(tabId, {
                    auth: {
                      ...auth,
                      login: {
                        ...auth.login,
                        credentials: {
                          type: "basic",
                          username: e.target.value,
                          password: creds.password,
                        },
                      },
                    },
                  });
                }}
                style={kvInputStyle}
              />
              <input
                data-testid="api-auth-session-pass"
                type="password"
                placeholder="Password"
                value={auth.login.credentials.password}
                onChange={(e) => {
                  if (auth.login.credentials.type !== "basic") return;
                  const creds = auth.login.credentials;
                  patch(tabId, {
                    auth: {
                      ...auth,
                      login: {
                        ...auth.login,
                        credentials: {
                          type: "basic",
                          username: creds.username,
                          password: e.target.value,
                        },
                      },
                    },
                  });
                }}
                style={kvInputStyle}
              />
            </>
          )}
        </div>
      )}
      {auth.type === "hook" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <input
            data-testid="api-auth-hook-module"
            placeholder="Hook module (e.g. intersight_hmac)"
            value={auth.module}
            onChange={(e) =>
              patch(tabId, { auth: { ...auth, module: e.target.value } })
            }
            style={kvInputStyle}
          />
          <input
            data-testid="api-auth-hook-function"
            placeholder="Function name (e.g. sign_request)"
            value={auth.function}
            onChange={(e) =>
              patch(tabId, { auth: { ...auth, function: e.target.value } })
            }
            style={kvInputStyle}
          />
          <p style={{ color: "var(--text-secondary)", fontSize: 11, margin: 0 }}>
            Place the module at{" "}
            <code>~/.ccie-terminal/api-hooks/{auth.module || "&lt;module&gt;"}.py</code>{" "}
            with a function <code>{auth.function || "sign_request"}(request, env)</code>.
          </p>
        </div>
      )}
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: "var(--text-secondary)",
          fontSize: 12,
          marginTop: 6,
        }}
      >
        <input
          type="checkbox"
          data-testid="api-tls-skip-verify"
          checked={state.insecure_skip_verify}
          onChange={(e) =>
            patch(tabId, { insecure_skip_verify: e.target.checked })
          }
        />
        Skip TLS verification (self-signed Cisco gear)
      </label>
    </div>
  );
}

const kvInputStyle: React.CSSProperties = {
  background: "var(--app-canvas)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-default)",
  borderRadius: 4,
  padding: "4px 8px",
  fontFamily: "Menlo, monospace",
  fontSize: 12,
  minWidth: 100,
  flex: 1,
};

const removeBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "var(--status-danger)",
  border: "none",
  cursor: "pointer",
  fontSize: 16,
  padding: "0 8px",
};
