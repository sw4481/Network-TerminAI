import { useEffect, useState, useMemo } from "react";
import { useVault } from "../../state/vaultStore";
import type { SecretDto, SecretKind } from "../../lib/vault";
import { vault } from "../../lib/vault";
import { copyWithAutoClear } from "../../lib/clipboard";
import "./VaultTab.css";

const KIND_LABELS: Record<SecretKind, string> = {
  password: "Password",
  ssh_key: "SSH Key",
  api_token: "API Token",
  snmp_community: "SNMP",
  netconf: "NETCONF",
};

const KIND_ICONS: Record<SecretKind, string> = {
  password: "•••",
  ssh_key: "🔑",
  api_token: "⌨",
  snmp_community: "📡",
  netconf: "⚙",
};

export function VaultTab() {
  const {
    envelopes,
    unlockedIds,
    selectedEnvelopeId,
    secretsByEnvelope,
    revealedUntil,
    revealedPlaintext,
    loadEnvelopes,
    selectEnvelope,
    unlock,
    lock,
    createEnvelope,
    addSecret,
    loadSecrets,
    revealSecret,
    deleteSecret,
    deleteEnvelope,
    initListeners,
  } = useVault();

  const [unlockPassphrase, setUnlockPassphrase] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [autoUnlockError, setAutoUnlockError] = useState<string | null>(null);
  const [showNewEnvelope, setShowNewEnvelope] = useState(false);
  const [newEnvName, setNewEnvName] = useState("");
  const [newEnvDesc, setNewEnvDesc] = useState("");
  const [newEnvPp, setNewEnvPp] = useState("");
  const [showAddSecret, setShowAddSecret] = useState(false);
  const [newSecretKind, setNewSecretKind] = useState<SecretKind>("password");
  const [newSecretLabel, setNewSecretLabel] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteEnvelopeId, setConfirmDeleteEnvelopeId] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    void loadEnvelopes();
    let unlistenFn: (() => void) | null = null;
    void initListeners().then((fn) => {
      unlistenFn = fn;
    });
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, [loadEnvelopes, initListeners]);

  // Re-render every 1s so reveal timer countdown updates.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const selectedEnvelope = useMemo(
    () => envelopes.find((e) => e.id === selectedEnvelopeId) ?? null,
    [envelopes, selectedEnvelopeId],
  );

  const isSelectedUnlocked = selectedEnvelope
    ? unlockedIds.has(selectedEnvelope.id)
    : false;

  useEffect(() => {
    if (selectedEnvelope && unlockedIds.has(selectedEnvelope.id)) {
      void loadSecrets(selectedEnvelope.id);
    }
  }, [selectedEnvelope, unlockedIds, loadSecrets]);

  const onUnlockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvelope) return;
    setUnlockError(null);
    try {
      await unlock(selectedEnvelope.name, unlockPassphrase);
      setUnlockPassphrase("");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setUnlockError(msg);
    }
  };

  const onCreateEnvelope = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEnvName.trim() || !newEnvPp) return;
    try {
      const env = await createEnvelope(
        newEnvName.trim(),
        newEnvDesc.trim() || null,
        newEnvPp,
      );
      selectEnvelope(env.id);
      setNewEnvName("");
      setNewEnvDesc("");
      setNewEnvPp("");
      setShowNewEnvelope(false);
    } catch (err) {
      console.error("create envelope failed", err);
    }
  };

  const onAddSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvelope || !newSecretLabel.trim() || !newSecretValue) return;
    try {
      await addSecret(
        selectedEnvelope.id,
        newSecretKind,
        newSecretLabel.trim(),
        newSecretValue,
      );
      setNewSecretLabel("");
      setNewSecretValue("");
      setShowAddSecret(false);
    } catch (err) {
      console.error("add secret failed", err);
    }
  };

  const onCopySecret = async (secret: SecretDto) => {
    try {
      const pt = await revealSecret(secret.id);
      await copyWithAutoClear(pt, 30_000);
    } catch (err) {
      console.error("copy secret failed", err);
    }
  };

  const onRevealSecret = async (secret: SecretDto) => {
    try {
      await revealSecret(secret.id);
    } catch (err) {
      console.error("reveal failed", err);
    }
  };

  const onDeleteSecret = async (secret: SecretDto) => {
    if (!selectedEnvelope) return;
    if (confirmDeleteId !== secret.id) {
      setConfirmDeleteId(secret.id);
      setTimeout(() => setConfirmDeleteId(null), 4000);
      return;
    }
    setConfirmDeleteId(null);
    await deleteSecret(selectedEnvelope.id, secret.id);
  };

  const onDeleteEnvelope = async (envelopeId: string) => {
    if (confirmDeleteEnvelopeId !== envelopeId) {
      setConfirmDeleteEnvelopeId(envelopeId);
      setTimeout(() => setConfirmDeleteEnvelopeId(null), 4000);
      return;
    }
    setConfirmDeleteEnvelopeId(null);
    try {
      await deleteEnvelope(envelopeId);
    } catch (err) {
      console.error("delete envelope failed", err);
    }
  };

  const secrets = selectedEnvelope
    ? secretsByEnvelope[selectedEnvelope.id] ?? []
    : [];

  return (
    <div className="vault-tab" data-testid="vault-tab">
      <div className="vault-pane vault-pane-list">
        <div className="vault-pane-header">
          <span>Envelopes</span>
          <button
            className="vault-btn vault-btn-small"
            onClick={() => setShowNewEnvelope(true)}
            data-testid="vault-new-envelope"
          >
            + New
          </button>
        </div>
        {envelopes.length === 0 ? (
          <div className="vault-empty">
            No envelopes yet. Create one to start storing credentials.
          </div>
        ) : (
          <ul className="vault-envelope-list">
            {envelopes.map((env) => {
              const u = unlockedIds.has(env.id);
              return (
                <li
                  key={env.id}
                  className={`vault-envelope ${
                    env.id === selectedEnvelopeId ? "vault-envelope-active" : ""
                  }`}
                  data-testid={`vault-envelope-${env.id}`}
                  onClick={() => selectEnvelope(env.id)}
                >
                  <span className="vault-envelope-icon">{u ? "🔓" : "🔒"}</span>
                  <span className="vault-envelope-name">{env.name}</span>
                  <div className="vault-envelope-actions">
                    {u && (
                      <button
                        className="vault-btn vault-btn-tiny"
                        onClick={(e) => {
                          e.stopPropagation();
                          void lock(env.id);
                        }}
                        title="Lock envelope (⌘L)"
                      >
                        Lock
                      </button>
                    )}
                    <button
                      className={`vault-btn vault-btn-tiny ${
                        confirmDeleteEnvelopeId === env.id ? "vault-btn-danger" : ""
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDeleteEnvelope(env.id);
                      }}
                      title="Delete envelope"
                    >
                      {confirmDeleteEnvelopeId === env.id ? "Confirm?" : "Delete"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="vault-pane vault-pane-detail">
        {!selectedEnvelope ? (
          <div className="vault-empty">Select an envelope to view secrets.</div>
        ) : !isSelectedUnlocked ? (
          <form
            className="vault-unlock"
            onSubmit={onUnlockSubmit}
            data-testid="vault-unlock-form"
          >
            <h3>Unlock {selectedEnvelope.name}</h3>
            {selectedEnvelope.description && (
              <p className="vault-meta">{selectedEnvelope.description}</p>
            )}
            <input
              type="password"
              autoFocus
              placeholder="Passphrase"
              value={unlockPassphrase}
              onChange={(e) => setUnlockPassphrase(e.target.value)}
              data-testid="vault-unlock-input"
            />
            {unlockError && (
              <div className="vault-error" role="alert">
                {unlockError}
              </div>
            )}
            <div className="vault-actions">
              <button
                type="submit"
                className="vault-btn vault-btn-primary"
                disabled={!unlockPassphrase}
                data-testid="vault-unlock-submit"
              >
                Unlock
              </button>
            </div>
            <div className="vault-auto-unlock-section">
              <button
                type="button"
                className="vault-checkbox-label"
                role="checkbox"
                aria-checked={selectedEnvelope.autoUnlock}
                onClick={async () => {
                  const enabled = !selectedEnvelope.autoUnlock;
                  if (enabled) {
                    if (!unlockPassphrase) {
                      setAutoUnlockError("Enter the passphrase above and try again.");
                      return;
                    }
                    setAutoUnlockError(null);
                    try {
                      await vault.setAutoUnlock(selectedEnvelope.id, true, unlockPassphrase);
                      await loadEnvelopes(); // Refresh to show updated state
                    } catch (err) {
                      alert(`Failed to enable auto-unlock: ${err}`);
                    }
                  } else {
                    // Disable
                    try {
                      await vault.setAutoUnlock(selectedEnvelope.id, false, null);
                      await loadEnvelopes();
                    } catch (err) {
                      alert(`Failed to disable auto-unlock: ${err}`);
                    }
                  }
                }}
              >
                <span className="vault-checkbox-control" aria-hidden="true">
                  {selectedEnvelope.autoUnlock ? "✓" : ""}
                </span>
                <span>Auto-unlock on app startup</span>
              </button>
              {autoUnlockError && (
                <div className="vault-error" role="alert">
                  {autoUnlockError}
                </div>
              )}
              <p className="vault-auto-unlock-hint">
                Stores passphrase securely in keychain. Vault will unlock automatically when app starts.
              </p>
            </div>
          </form>
        ) : (
          <div className="vault-secrets">
            <div className="vault-pane-header">
              <span>{selectedEnvelope.name}</span>
              <button
                className="vault-btn vault-btn-small"
                onClick={() => setShowAddSecret(true)}
                data-testid="vault-add-secret"
              >
                + Add Secret
              </button>
            </div>
            {secrets.length === 0 ? (
              <div className="vault-empty">
                No secrets in this envelope yet.
              </div>
            ) : (
              <ul className="vault-secret-list">
                {secrets.map((s) => {
                  const exp = revealedUntil[s.id];
                  const isRevealed = !!exp && exp > Date.now();
                  const remainingMs = isRevealed ? exp - Date.now() : 0;
                  return (
                    <li
                      key={s.id}
                      className="vault-secret"
                      data-testid={`vault-secret-${s.id}`}
                    >
                      <span className="vault-secret-icon" aria-hidden>
                        {KIND_ICONS[s.kind]}
                      </span>
                      <div className="vault-secret-body">
                        <span className="vault-secret-label">{s.label}</span>
                        <span className="vault-secret-meta">
                          {KIND_LABELS[s.kind]}
                          {s.lastUsedAt
                            ? ` · last used ${new Date(s.lastUsedAt * 1000).toLocaleString()}`
                            : ""}
                        </span>
                        {isRevealed && (
                          <code className="vault-secret-value">
                            {revealedPlaintext[s.id]}
                            <span className="vault-secret-countdown">
                              {" "}
                              ({Math.ceil(remainingMs / 1000)}s)
                            </span>
                          </code>
                        )}
                      </div>
                      <div className="vault-secret-actions">
                        <button
                          className="vault-btn vault-btn-small"
                          onClick={() => onCopySecret(s)}
                          title="Copy with 30s auto-clear"
                          data-testid={`vault-copy-${s.id}`}
                        >
                          Copy
                        </button>
                        <button
                          className="vault-btn vault-btn-small"
                          onClick={() => onRevealSecret(s)}
                          data-testid={`vault-reveal-${s.id}`}
                        >
                          {isRevealed ? "Re-reveal" : "Reveal 5s"}
                        </button>
                        <button
                          className={`vault-btn vault-btn-small ${
                            confirmDeleteId === s.id ? "vault-btn-danger" : ""
                          }`}
                          onClick={() => onDeleteSecret(s)}
                          data-testid={`vault-delete-${s.id}`}
                        >
                          {confirmDeleteId === s.id ? "Confirm?" : "Delete"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      {showNewEnvelope && (
        <div className="vault-modal-backdrop" onClick={() => setShowNewEnvelope(false)}>
          <form
            className="vault-modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={onCreateEnvelope}
            data-testid="vault-new-envelope-modal"
          >
            <h3>New Envelope</h3>
            <label>
              Name
              <input
                value={newEnvName}
                onChange={(e) => setNewEnvName(e.target.value)}
                placeholder="site-A"
                autoFocus
              />
            </label>
            <label>
              Description (optional)
              <input
                value={newEnvDesc}
                onChange={(e) => setNewEnvDesc(e.target.value)}
                placeholder="Production network"
              />
            </label>
            <label>
              Passphrase
              <input
                type="password"
                value={newEnvPp}
                onChange={(e) => setNewEnvPp(e.target.value)}
                placeholder="Strong passphrase"
              />
            </label>
            <div className="vault-actions">
              <button
                type="button"
                className="vault-btn"
                onClick={() => setShowNewEnvelope(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="vault-btn vault-btn-primary"
                disabled={!newEnvName.trim() || !newEnvPp}
              >
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {showAddSecret && selectedEnvelope && (
        <div className="vault-modal-backdrop" onClick={() => setShowAddSecret(false)}>
          <form
            className="vault-modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={onAddSecret}
            data-testid="vault-add-secret-modal"
          >
            <h3>Add Secret</h3>
            <label>
              Kind
              <select
                value={newSecretKind}
                onChange={(e) => setNewSecretKind(e.target.value as SecretKind)}
              >
                <option value="password">Password</option>
                <option value="ssh_key">SSH Key</option>
                <option value="api_token">API Token</option>
                <option value="snmp_community">SNMP Community</option>
                <option value="netconf">NETCONF</option>
              </select>
            </label>
            <label>
              Label
              <input
                value={newSecretLabel}
                onChange={(e) => setNewSecretLabel(e.target.value)}
                placeholder="rtr1-enable"
                autoFocus
              />
            </label>
            <label>
              {newSecretKind === "ssh_key" ? "Key (paste full PEM)" : "Value"}
              {newSecretKind === "ssh_key" ? (
                <textarea
                  rows={6}
                  value={newSecretValue}
                  onChange={(e) => setNewSecretValue(e.target.value)}
                  placeholder="Paste the full OpenSSH key block here"
                />
              ) : (
                <input
                  type="password"
                  value={newSecretValue}
                  onChange={(e) => setNewSecretValue(e.target.value)}
                />
              )}
            </label>
            <div className="vault-actions">
              <button
                type="button"
                className="vault-btn"
                onClick={() => setShowAddSecret(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="vault-btn vault-btn-primary"
                disabled={!newSecretLabel.trim() || !newSecretValue}
              >
                Add
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
