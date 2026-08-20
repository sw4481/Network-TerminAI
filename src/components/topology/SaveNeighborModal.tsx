/**
 * Plan 13 Phase 3 Task 3.3 — SaveNeighborModal.
 *
 * Self-contained modal that lets the user save an unknown topology
 * neighbor (clicked in `InlineTopologyPanel`) as either an SSH
 * connection or a NETCONF device. The parent component owns
 * `isOpen` / `onClose` state — there is no shared `uiStore` in this
 * codebase. Mirrors the pattern of `SaveSessionModal.tsx` and reuses
 * the global `.modal-*` classes defined in `App.css`.
 *
 * On a successful save we invoke `onSaved(kind, host)` so the parent
 * can re-trigger `openNeighbor` and immediately spawn the matching tab
 * for the freshly-saved device.
 */
import { useEffect, useState } from "react";
import { sshListConnections, sshSaveConnection } from "../../lib/sshConnections";

import {
  netconfDeviceCreate,
  netconfDeviceList,
  type SavedNetconfDevice,
} from "../../lib/tauri";
import type { TopologyNode } from "../../lib/topology";

import "./SaveNeighborModal.css";

type SaveKind = "ssh" | "netconf";

const DEFAULT_SSH_PORT = 22;
const DEFAULT_NETCONF_PORT = 830;

export interface SaveNeighborModalProps {
  isOpen: boolean;
  neighbor: TopologyNode | null;
  onClose: () => void;
  /** Called after a successful save — parent can re-trigger openNeighbor. */
  onSaved?: (kind: SaveKind, host: string) => void;
}

export function SaveNeighborModal({
  isOpen,
  neighbor,
  onClose,
  onSaved,
}: SaveNeighborModalProps) {
  const initialName = neighbor?.label ?? neighbor?.device_ref ?? "";
  const initialHost = neighbor?.mgmt_ip ?? neighbor?.device_ref ?? "";

  const [name, setName] = useState(initialName);
  const [host, setHost] = useState(initialHost);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [port, setPort] = useState<number>(DEFAULT_SSH_PORT);
  const [kind, setKind] = useState<SaveKind>("ssh");
  const [verifyHostKey, setVerifyHostKey] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Re-seed form fields whenever the neighbor changes (e.g., parent
  // opens the modal for a different unknown click). Reset transient UI
  // state too so the previous error/success banner doesn't leak.
  useEffect(() => {
    if (!neighbor) return;
    setName(neighbor.label ?? neighbor.device_ref);
    setHost(neighbor.mgmt_ip ?? neighbor.device_ref);
    setUsername("");
    setPassword("");
    setKind("ssh");
    setPort(DEFAULT_SSH_PORT);
    setVerifyHostKey(true);
    setError(null);
    setSuccess(false);
  }, [neighbor]);

  const handleKindChange = (next: SaveKind) => {
    setKind(next);
    // Flip the port default when switching modes, but only if the user
    // has not customized it away from the *other* mode's default.
    setPort((current) => {
      if (next === "ssh" && current === DEFAULT_NETCONF_PORT) {
        return DEFAULT_SSH_PORT;
      }
      if (next === "netconf" && current === DEFAULT_SSH_PORT) {
        return DEFAULT_NETCONF_PORT;
      }
      return current;
    });
  };

  const handleClose = () => {
    setError(null);
    setSuccess(false);
    setSaving(false);
    onClose();
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    const trimmedHost = host.trim();

    if (!trimmedName) {
      setError("Name is required");
      return;
    }
    if (!trimmedHost) {
      setError("Host is required");
      return;
    }
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      setError("Port must be between 1 and 65535");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      // Overwrite-protection: both ssh_connections.name and
      // netconf_devices.name are UNIQUE, so the underlying save commands
      // silently UPSERT on conflict. If a row already exists with this
      // name but a *different* host, prompt the user before clobbering.
      if (kind === "ssh") {
        const existing = await sshListConnections();
        const match = existing.find((c) => c.name === trimmedName);
        if (match && match.host !== trimmedHost) {
          const ok = window.confirm(
            `An SSH connection named '${trimmedName}' already exists pointing to ${match.host}. Overwrite with ${trimmedHost}?`,
          );
          if (!ok) {
            setError("Save cancelled");
            setSaving(false);
            return;
          }
        }
      } else {
        const existing: SavedNetconfDevice[] = await netconfDeviceList();
        const match = existing.find((d) => d.name === trimmedName);
        if (match && match.host !== trimmedHost) {
          const ok = window.confirm(
            `A NETCONF device named '${trimmedName}' already exists pointing to ${match.host}. Overwrite with ${trimmedHost}?`,
          );
          if (!ok) {
            setError("Save cancelled");
            setSaving(false);
            return;
          }
        }
      }

      if (kind === "ssh") {
        await sshSaveConnection({
          name: trimmedName,
          host: trimmedHost,
          user: username.trim() || null,
          port,
          identity_file: null,
          password: password ? password : null,
        });
      } else {
        await netconfDeviceCreate(
          trimmedName,
          trimmedHost,
          port,
          username.trim() || "",
          password || "",
          verifyHostKey,
        );
      }

      setSuccess(true);
      onSaved?.(kind, trimmedHost);
      // Brief success indicator, then close.
      setTimeout(() => {
        handleClose();
      }, 600);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen || !neighbor) return null;

  return (
    <div
      className="modal-overlay"
      onClick={handleClose}
      data-testid="save-neighbor-modal"
    >
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Save Neighbor</h2>
          <button
            className="close-btn"
            onClick={handleClose}
            aria-label="Close"
            disabled={saving}
          >
            ✕
          </button>
        </div>

        <div className="modal-body">
          {success ? (
            <div className="success-message">Neighbor saved successfully!</div>
          ) : (
            <div className="save-neighbor-form">
              <div className="field">
                <label htmlFor="save-neighbor-name">Name *</label>
                <input
                  id="save-neighbor-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={saving}
                  autoFocus
                />
              </div>

              <div className="field">
                <label htmlFor="save-neighbor-host">Host *</label>
                <input
                  id="save-neighbor-host"
                  type="text"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  readOnly
                  disabled={saving}
                />
              </div>

              <div className="field save-neighbor-kind">
                <span className="field-legend">Save as</span>
                <label className="radio-row">
                  <input
                    type="radio"
                    name="save-neighbor-kind"
                    value="ssh"
                    checked={kind === "ssh"}
                    onChange={() => handleKindChange("ssh")}
                    disabled={saving}
                  />
                  Save as SSH
                </label>
                <label className="radio-row">
                  <input
                    type="radio"
                    name="save-neighbor-kind"
                    value="netconf"
                    checked={kind === "netconf"}
                    onChange={() => handleKindChange("netconf")}
                    disabled={saving}
                  />
                  Save as NETCONF
                </label>
              </div>

              <div className="field">
                <label htmlFor="save-neighbor-username">Username</label>
                <input
                  id="save-neighbor-username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={saving}
                  autoComplete="off"
                />
              </div>

              <div className="field">
                <label htmlFor="save-neighbor-port">Port</label>
                <input
                  id="save-neighbor-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    setPort(Number.isNaN(val) ? port : val);
                  }}
                  disabled={saving}
                />
              </div>

              <div className="field">
                <label htmlFor="save-neighbor-password">Password</label>
                <input
                  id="save-neighbor-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={saving}
                  autoComplete="new-password"
                />
              </div>

              {kind === "netconf" && (
                <div className="field save-neighbor-checkbox">
                  <label htmlFor="save-neighbor-verify-host">
                    <input
                      id="save-neighbor-verify-host"
                      type="checkbox"
                      checked={verifyHostKey}
                      onChange={(e) => setVerifyHostKey(e.target.checked)}
                      disabled={saving}
                    />
                    Verify host key
                  </label>
                </div>
              )}

              {error && (
                <div className="error-message">
                  <strong>Error:</strong> {error}
                </div>
              )}

              <div className="button-row">
                <button
                  className="secondary"
                  onClick={handleClose}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  className="primary"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
