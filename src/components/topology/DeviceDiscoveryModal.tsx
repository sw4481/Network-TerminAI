/**
 * Topology automated discovery modal.
 *
 * Displays all saved SSH connections and allows users to select one or more
 * devices for automated topology discovery. The modal calls the discovery
 * orchestration logic which SSHs into each device and runs neighbor
 * discovery commands automatically.
 */
import { useState, useEffect } from "react";
import { sshListConnections, type SshConnection } from "../../lib/sshConnections";
import "./DeviceDiscoveryModal.css";

export interface DeviceDiscoveryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDiscover: (deviceIds: string[], passwords: Record<string, string>) => void;
}

export function DeviceDiscoveryModal({
  isOpen,
  onClose,
  onDiscover,
}: DeviceDiscoveryModalProps) {
  const [connections, setConnections] = useState<SshConnection[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    // Load saved SSH connections
    setLoading(true);
    setError(null);
    sshListConnections()
      .then((conns) => {
        setConnections(conns);
        setLoading(false);
      })
      .catch((err) => {
        console.error("[DeviceDiscoveryModal] Failed to load connections:", err);
        setError(String(err));
        setLoading(false);
      });
  }, [isOpen]);

  if (!isOpen) return null;

  const handleToggle = (id: string) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedIds(newSet);
  };

  const handleSelectAll = () => {
    if (selectedIds.size === connections.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(connections.map((c) => c.id)));
    }
  };

  const handleDiscover = () => {
    if (selectedIds.size === 0) return;

    // Check if any selected connections need passwords
    const selectedConns = connections.filter(c => selectedIds.has(c.id));
    const needsPassword = selectedConns.filter(
      c => !c.password_encrypted && !passwords[c.id]
    );

    if (needsPassword.length > 0) {
      alert(`Please enter passwords for: ${needsPassword.map(c => c.name || c.host).join(', ')}`);
      return;
    }

    onDiscover(Array.from(selectedIds), passwords);
    onClose();
  };

  const handlePasswordChange = (connId: string, password: string) => {
    setPasswords(prev => ({
      ...prev,
      [connId]: password,
    }));
  };

  return (
    <div
      className="discovery-modal-overlay"
      onClick={onClose}
      data-testid="discovery-modal-overlay"
    >
      <div
        className="discovery-modal"
        onClick={(e) => e.stopPropagation()}
        data-testid="discovery-modal"
      >
        <div className="discovery-modal__header">
          <h2>Discover Topology</h2>
          <button
            className="discovery-modal__close"
            onClick={onClose}
            title="Close"
          >
            ✕
          </button>
        </div>

        <div className="discovery-modal__body">
          {loading ? (
            <div className="discovery-modal__loading">
              Loading saved connections...
            </div>
          ) : error ? (
            <div className="discovery-modal__error">
              Error loading connections: {error}
            </div>
          ) : connections.length === 0 ? (
            <div className="discovery-modal__empty">
              No saved SSH connections found. Add connections first.
            </div>
          ) : (
            <>
              <div className="discovery-modal__instructions">
                Select devices to discover neighbors from. The app will
                automatically SSH to each device and run topology discovery
                commands.
              </div>

              <div className="discovery-modal__select-all">
                <label>
                  <input
                    type="checkbox"
                    checked={selectedIds.size === connections.length}
                    onChange={handleSelectAll}
                  />
                  <span>Select All ({connections.length})</span>
                </label>
              </div>

              <div className="discovery-modal__list">
                {connections.map((conn) => {
                  const needsPassword = !conn.password_encrypted && selectedIds.has(conn.id);
                  return (
                    <div key={conn.id} className="discovery-modal__device-container">
                      <label
                        className="discovery-modal__device"
                        data-testid={`discovery-device-${conn.id}`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.has(conn.id)}
                          onChange={() => handleToggle(conn.id)}
                        />
                        <div className="discovery-modal__device-info">
                          <div className="discovery-modal__device-name">
                            {conn.name || conn.host}
                            {!conn.password_encrypted && (
                              <span style={{ color: 'var(--text-primary)', fontSize: 11, marginLeft: 8 }}>
                                (password required)
                              </span>
                            )}
                          </div>
                          <div className="discovery-modal__device-details">
                            {conn.user ? `${conn.user}@` : ""}{conn.host}:{conn.port ?? 22}
                          </div>
                        </div>
                      </label>
                      {needsPassword && (
                        <input
                          type="password"
                          className="discovery-modal__password-input"
                          placeholder="Enter password..."
                          value={passwords[conn.id] || ''}
                          onChange={(e) => handlePasswordChange(conn.id, e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="discovery-modal__footer">
          <button className="discovery-modal__button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="discovery-modal__button discovery-modal__button--primary"
            onClick={handleDiscover}
            disabled={selectedIds.size === 0}
          >
            Discover {selectedIds.size > 0 && `(${selectedIds.size})`}
          </button>
        </div>
      </div>
    </div>
  );
}
