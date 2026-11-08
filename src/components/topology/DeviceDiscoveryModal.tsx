/**
 * Topology automated discovery modal.
 *
 * Displays all saved SSH connections and allows users to select one or more
 * devices for automated topology discovery. The modal calls the discovery
 * orchestration logic which SSHs into each device and runs neighbor
 * discovery commands automatically.
 */
import { useState, useEffect, useRef } from "react";
import { sshListConnections, type SshConnection } from "../../lib/sshConnections";
import { GLOBAL_GRAPH_ID, type CollectionMode } from "../../lib/topology";
import { vault, type SecretDto } from "../../lib/vault";
import { SnmpProfile } from "../../lib/snmpProfile";
import { useTopologyStore } from "../../state/topologyStore";
import "./DeviceDiscoveryModal.css";

export interface DeviceDiscoveryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDiscover: (deviceIds: string[], passwords: Record<string, string>, graphId?: string, scope?: { eligibleIds: string[]; maxDepth: 0 | 1; includeRouting: boolean; collectionMode?: CollectionMode; snmpSecretId?: string }) => void;
}

export function DeviceDiscoveryModal({
  isOpen,
  onClose,
  onDiscover,
}: DeviceDiscoveryModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [connections, setConnections] = useState<SshConnection[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [maxDepth, setMaxDepth] = useState<0 | 1>(0);
  const [includeRouting, setIncludeRouting] = useState(false);
  const [collectionMode, setCollectionMode] = useState<CollectionMode>("ssh");
  const [snmpSecretId, setSnmpSecretId] = useState("");
  const [snmpSecrets, setSnmpSecrets] = useState<SecretDto[]>([]);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [eligibleIds, setEligibleIds] = useState<Set<string>>(new Set());
  const [validationError, setValidationError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const graphs = useTopologyStore((state) => state.graphs);
  const [destination, setDestination] = useState(GLOBAL_GRAPH_ID);
  const graphOptions = [{ id: GLOBAL_GRAPH_ID, name: "Global" }, ...graphs.filter((graph) => graph.id !== GLOBAL_GRAPH_ID)];
  if (!graphOptions.some((graph) => graph.id === destination)) graphOptions.push({ id: destination, name: destination });

  useEffect(() => {
    if (!isOpen) { setPasswords({}); return; }
    let active = true;
    setDestination(useTopologyStore.getState().currentGraphId);
    setSelectedIds(new Set());
    setEligibleIds(new Set());
    setMaxDepth(0);
    setIncludeRouting(false);
    setCollectionMode("ssh");
    setSnmpSecretId("");
    setSnmpSecrets([]);
    setVaultError(null);
    setValidationError(null);
    setPasswords({});
    setConnections([]);
    setLoading(true);
    setError(null);
    sshListConnections()
      .then((conns) => {
        if (!active) return;
        setConnections(conns);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setError(String(err));
        setLoading(false);
      });
    return () => { active = false; };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || collectionMode === "ssh") return;
    let active = true;
    setVaultLoading(true);
    setVaultError(null);
    setSnmpSecretId("");
    setSnmpSecrets([]);
    void vault.unlockedIds().then(async (ids) => {
      const lists = await Promise.all(ids.map((id) => vault.listSecrets(id)));
      if (active) setSnmpSecrets(lists.flat());
    }).catch(() => {
      if (active) setVaultError("Could not load unlocked SNMP profiles. Unlock the envelope in Vault, then reopen discovery.");
    }).finally(() => { if (active) setVaultLoading(false); });
    return () => { active = false; };
  }, [isOpen, collectionMode]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!isOpen || !dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, summary, [tabindex]',
    )).filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0);
    focusables()[0]?.focus();
    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = focusables();
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog.addEventListener("keydown", trapTab);
    return () => {
      dialog.removeEventListener("keydown", trapTab);
      if (previous?.isConnected) {
        const target = previous.matches(":disabled")
          ? previous.closest('[role="toolbar"]')?.querySelector<HTMLElement>('button:not(:disabled)')
          : previous;
        target?.focus();
      }
    };
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
    if (selectedIds.size > 50) { setValidationError("Select at most 50 seeds."); return; }
    const eligible = new Set([...selectedIds, ...(maxDepth === 1 ? eligibleIds : [])]);
    if (eligible.size > 500) { setValidationError("Select at most 500 eligible saved profiles."); return; }
    if (collectionMode !== "ssh" && !snmpSecrets.some((secret) => secret.id === snmpSecretId && SnmpProfile.matches(secret, collectionMode === "snmp_v3" ? "3" : "2c"))) {
      setValidationError("Choose a matching SNMP profile from an unlocked vault envelope.");
      return;
    }
    const selectedConns = collectionMode === "ssh" ? connections.filter(c => eligible.has(c.id)) : [];
    const needsPassword = selectedConns.filter(c =>
      c.vendor.toLowerCase() === "cisco" && ["ios", "iosxe"].includes(c.platform.toLowerCase()) && !c.password_encrypted && !passwords[c.id]);
    if (needsPassword.length > 0) {
      setValidationError(`Enter temporary passwords for: ${needsPassword.map(c => c.name || c.host).join(", ")}`);
      return;
    }
    const overrides = collectionMode === "ssh" ? Object.fromEntries(Object.entries(passwords).filter(([id]) => eligible.has(id))) : {};
    onDiscover(Array.from(selectedIds), overrides, destination, { eligibleIds: [...eligible], maxDepth, includeRouting: collectionMode === "ssh" && includeRouting,
      ...(collectionMode !== "ssh" ? { collectionMode, snmpSecretId } : {}),
    });
    setPasswords({});
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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Discover topology"
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}
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
          <label>
            Destination graph
            <select aria-label="Destination graph" value={destination} onChange={(event) => setDestination(event.target.value)}>
              {graphOptions.map((graph) => <option key={graph.id} value={graph.id}>{graph.name}</option>)}
            </select>
          </label>
          <label>Collection method<select aria-label="Collection method" value={collectionMode} onChange={(event) => {
            setCollectionMode(event.target.value as CollectionMode); setPasswords({}); setSnmpSecretId(""); setIncludeRouting(false); setValidationError(null);
          }}>
            <option value="ssh">SSH — Cisco IOS / IOS-XE (default)</option>
            <option value="snmp_v3">SNMPv3 — authPriv, SHA-256 / AES-128</option>
            <option value="snmp_v2c">SNMPv2c — unencrypted, explicit opt-in</option>
          </select></label>
          {collectionMode === "ssh" ? <details className="discovery-modal__requirements"><summary>SSH requirements</summary><p>Discovery supports saved Cisco IOS / IOS-XE profiles with password authentication on macOS/Linux. Key-only and Windows collection are not supported. OpenSSH must already trust the saved host in your known_hosts; unknown or changed keys stop without enrollment.</p></details> : <>
            <p>Read-only CDP/LLDP MIB collection uses a separate bounded worker on macOS/Linux. No SSH login, SET requests, subnet scan, credential fallback or Windows collection. One selected profile is used only for the explicitly eligible saved hosts.</p>
            {collectionMode === "snmp_v2c" && <p>SNMPv2c sends the community and device data without encryption. Choose it only on an authorized trusted network.</p>}
            <label>Unlocked SNMP profile<select aria-label="Unlocked SNMP profile" value={snmpSecretId} disabled={vaultLoading} onChange={(event) => setSnmpSecretId(event.target.value)}>
              <option value="">{vaultLoading ? "Loading profiles…" : "Choose a profile"}</option>
              {snmpSecrets.filter((secret) => SnmpProfile.matches(secret, collectionMode === "snmp_v3" ? "3" : "2c")).map((secret) => <option key={secret.id} value={secret.id}>{secret.label}</option>)}
            </select></label>
            <p>Create an SNMP discovery profile in Vault → Add Secret and unlock its envelope before opening discovery. Legacy plain communities are not selected automatically. The app receives a secret reference, not revealed credential values.</p>
            {vaultError && <p role="alert">{vaultError}</p>}
          </>}
          <label>Discovery scope
            <select aria-label="Discovery scope" value={maxDepth} onChange={(event) => setMaxDepth(event.target.value === "1" ? 1 : 0)}>
              <option value="0">Selected seeds only (default)</option>
              <option value="1">Seeds + one hop within explicitly eligible saved profiles</option>
            </select>
          </label>
          <label><input type="checkbox" checked={includeRouting} disabled={collectionMode !== "ssh"} onChange={(event) => setIncludeRouting(event.target.checked)} /> Include routing observations (BGP/OSPF/IS-IS/EIGRP)</label>
          <p className="discovery-modal__routing-hint">Logical adjacencies, not route tables. SSH only. EIGRP collects IPv4 neighbors in the default VRF, not routes or the EIGRP topology table.</p>
          <details className="discovery-modal__requirements">
            <summary>Routing evidence and collection limits</summary>
            <p>CDP/LLDP remain the default. SSH routing collection also reads local IPv4 interface addresses: unique subnet ownership may support an interface association, not address-to-interface proof of a physical cable or direct session. Missing/ambiguous evidence stays unknown.</p>
            <p>Limits: 4 concurrent devices, 50 attempts, 90 seconds/device, 30 seconds/command, 15 minutes/run. Stop retains captures already committed.</p>
          </details>
          {validationError && <p role="alert">{validationError}</p>}
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
                Select saved devices to discover neighbors from. The app uses only
                the chosen collection method; there is no automatic fallback.
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
                  const inScope = selectedIds.has(conn.id) || (maxDepth === 1 && eligibleIds.has(conn.id));
                  const needsPassword = collectionMode === "ssh" && !conn.password_encrypted && inScope && conn.vendor.toLowerCase() === "cisco" && ["ios", "iosxe"].includes(conn.platform.toLowerCase());
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
                            {collectionMode === "ssh" && !conn.password_encrypted && (
                              <span style={{ color: 'var(--text-primary)', fontSize: 11, marginLeft: 8 }}>
                                (password required)
                              </span>
                            )}
                          </div>
                          <div className="discovery-modal__device-details">
                            {conn.user ? `${conn.user}@` : ""}{conn.host}:{conn.port ?? 22}
                            {" · "}{conn.vendor} / {conn.platform}
                            {collectionMode === "ssh" && !(conn.vendor.toLowerCase() === "cisco" && ["ios", "iosxe"].includes(conn.platform.toLowerCase())) && " (unsupported SSH profile)"}
                          </div>
                        </div>
                      </label>
                      {maxDepth === 1 && <label>
                        <input type="checkbox" aria-label={`Allow follow-up to ${conn.name || conn.host}`} checked={selectedIds.has(conn.id) || eligibleIds.has(conn.id)} disabled={selectedIds.has(conn.id)} onChange={() => setEligibleIds((previous) => { const next = new Set(previous); if (next.has(conn.id)) next.delete(conn.id); else next.add(conn.id); return next; })} />
                        Eligible saved neighbor (only dialed if uniquely observed)
                      </label>}
                      {needsPassword && (
                        <input
                          type="password"
                          aria-label={`Password for ${conn.name || conn.host}`}
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
