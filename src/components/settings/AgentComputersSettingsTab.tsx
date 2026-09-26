import { useEffect, useState } from "react";
import {
  agentComputerProvision,
  agentComputerStart,
  agentComputerStop,
  agentComputerTest,
  agentComputersGetConfig,
  agentComputersSaveConfig,
  proxmoxListInventory,
  type AgentComputerConfig,
  type AgentComputerEntry,
  type ProxmoxInventory,
} from "../../lib/tauri";
import "./ProxmoxSettingsTab.css";

type StatusKind = "ok" | "err" | "info";

const emptyComputer: AgentComputerEntry = {
  name: "",
  node: "",
  vmid: "",
  templateVmid: "",
  baseUrl: "",
  token: "",
};

const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, "");
const nodeKey = (node: string) => node.trim().toLowerCase();

export function AgentComputersSettingsTab() {
  const [computers, setComputers] = useState<AgentComputerEntry[]>([{ ...emptyComputer }]);
  const [saved, setSaved] = useState<AgentComputerEntry | null>(null);
  const [inventory, setInventory] = useState<ProxmoxInventory>({ nodes: [], templates: [] });
  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actionPending, setActionPending] = useState(false);

  useEffect(() => {
    Promise.all([
      agentComputersGetConfig().catch(() => null),
      proxmoxListInventory().catch(() => ({ nodes: [], templates: [] })),
    ]).then(([config, nextInventory]) => {
      setInventory(nextInventory);
      const loaded = config?.computers?.[0] ?? { ...emptyComputer };
      const inventoryNode = loaded.node
        ? nextInventory.nodes.find((item) => nodeKey(item.node) === nodeKey(loaded.node))?.node
        : undefined;
      const node = inventoryNode || loaded.node || nextInventory.templates[0]?.node || nextInventory.nodes[0]?.node || "";
      const template = nextInventory.templates.find((item) => nodeKey(item.node) === nodeKey(node) && item.vmid === loaded.templateVmid)
        ?? nextInventory.templates.find((item) => nodeKey(item.node) === nodeKey(node));
      const next = {
        ...loaded,
        node,
        templateVmid: template?.vmid || loaded.templateVmid || "",
      };
      setComputers([next]);
      if (config?.computers?.length) setSaved(next);
    }).finally(() => setLoading(false));
  }, []);

  const first = computers[0] ?? { ...emptyComputer };
  const set = <K extends keyof AgentComputerEntry>(key: K, value: AgentComputerEntry[K]) =>
    setComputers([{ ...first, [key]: value }]);

  const busy = loading || saving || actionPending;
  const templatesForNode = inventory.templates.filter((template) => nodeKey(template.node) === nodeKey(first.node));
  const current = (): AgentComputerEntry => ({ ...first, baseUrl: normalizeUrl(first.baseUrl) });
  const config = (): AgentComputerConfig => ({ computers: [current()] });
  const savedForDirty = saved ? { ...saved, baseUrl: normalizeUrl(saved.baseUrl), templateVmid: saved.templateVmid ?? "" } : null;
  const isDirty = JSON.stringify(savedForDirty) !== JSON.stringify(current());

  const save = async () => {
    setStatus({ kind: "info", text: "Saving…" });
    setSaving(true);
    try {
      const next = config();
      await agentComputersSaveConfig(next);
      setComputers(next.computers);
      setSaved(next.computers[0]);
      setStatus({ kind: "ok", text: "Saved. Agents can now use computer.list()/computer.health()." });
    } catch (e) {
      setStatus({ kind: "err", text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setStatus({ kind: "info", text: "Testing connection…" });
    setActionPending(true);
    try {
      const result = await agentComputerTest(current());
      setStatus({ kind: result.ok ? "ok" : "err", text: result.message });
    } catch (e) {
      setStatus({ kind: "err", text: `Test failed: ${String(e)}` });
    } finally {
      setActionPending(false);
    }
  };

  const start = async () => {
    if (isDirty) {
      setStatus({ kind: "err", text: "Save changes before starting this LXC." });
      return;
    }
    setActionPending(true);
    try {
      const result = await agentComputerStart(current());
      setStatus({ kind: result.ok ? "ok" : "err", text: result.message });
    } catch (e) {
      setStatus({ kind: "err", text: `Start failed: ${String(e)}` });
    } finally {
      setActionPending(false);
    }
  };

  const stop = async () => {
    if (isDirty) {
      setStatus({ kind: "err", text: "Save changes before stopping this LXC." });
      return;
    }
    setActionPending(true);
    try {
      const result = await agentComputerStop(current());
      setStatus({ kind: result.ok ? "ok" : "err", text: result.message });
    } catch (e) {
      setStatus({ kind: "err", text: `Stop failed: ${String(e)}` });
    } finally {
      setActionPending(false);
    }
  };

  const provision = async () => {
    setStatus({ kind: "info", text: "Provisioning LXC…" });
    setActionPending(true);
    try {
      const result = await agentComputerProvision(current());
      if (result.ok && result.computer) {
        const next = { computers: [result.computer] };
        await agentComputersSaveConfig(next);
        setComputers(next.computers);
        setSaved(next.computers[0]);
      }
      setStatus({ kind: result.ok ? "ok" : "err", text: result.message });
    } catch (e) {
      setStatus({ kind: "err", text: `Provision failed: ${String(e)}` });
    } finally {
      setActionPending(false);
    }
  };

  return (
    <div className="pve-tab">
      <div className="pve-header">
        <h3>Agent Computers</h3>
        <p className="pve-subtitle">
          Register one golden-template LXC running the agent-computer daemon. Browser control stays local.
        </p>
      </div>

      <div className="pve-section">
        <div className="pve-section-label">Computer</div>
        <div className="pve-grid">
          <div className="pve-field">
            <label htmlFor="agent-computer-name">Name</label>
            <input id="agent-computer-name" value={first.name} disabled={busy} onChange={(e) => set("name", e.target.value)} />
          </div>
          <div className="pve-field">
            <label htmlFor="agent-computer-node">Proxmox node</label>
            {inventory.nodes.length ? (
              <select id="agent-computer-node" value={first.node} disabled={busy} onChange={(e) => {
                const node = e.target.value;
                setComputers([{ ...first, node, templateVmid: inventory.templates.find((template) => nodeKey(template.node) === nodeKey(node))?.vmid || "" }]);
              }}>
                {!first.node && <option value="">Select node…</option>}
                {first.node && !inventory.nodes.some((node) => node.node === first.node) && (
                  <option value={first.node}>{first.node}</option>
                )}
                {inventory.nodes.map((node) => (
                  <option key={node.node} value={node.node}>{node.node}</option>
                ))}
              </select>
            ) : (
              <input id="agent-computer-node" value={first.node} disabled={busy} onChange={(e) => set("node", e.target.value)} />
            )}
          </div>
          <div className="pve-field">
            <label htmlFor="agent-computer-vmid">LXC VMID</label>
            <input id="agent-computer-vmid" value={first.vmid} disabled={busy} onChange={(e) => set("vmid", e.target.value)} />
          </div>
          <div className="pve-field">
            <label htmlFor="agent-computer-template-vmid">Template VMID</label>
            {templatesForNode.length ? (
              <select id="agent-computer-template-vmid" value={first.templateVmid ?? ""} disabled={busy} onChange={(e) => set("templateVmid", e.target.value)}>
                {!(first.templateVmid ?? "") && <option value="">Select template…</option>}
                {templatesForNode.map((template) => (
                  <option key={`${template.node}-${template.vmid}`} value={template.vmid}>{template.vmid}{template.name ? ` — ${template.name}` : ""}</option>
                ))}
              </select>
            ) : (
              <input id="agent-computer-template-vmid" value={first.templateVmid ?? ""} disabled={busy} onChange={(e) => set("templateVmid", e.target.value)} />
            )}
          </div>
          <div className="pve-field pve-field--full">
            <label htmlFor="agent-computer-base-url">Base URL</label>
            <input id="agent-computer-base-url" value={first.baseUrl} disabled={busy} onChange={(e) => set("baseUrl", e.target.value)} placeholder="http://10.0.0.10:8765" />
          </div>
          <div className="pve-field pve-field--full">
            <label htmlFor="agent-computer-token">Bearer token</label>
            <input id="agent-computer-token" type="password" value={first.token} disabled={busy} onChange={(e) => set("token", e.target.value)} />
          </div>
        </div>
      </div>

      <div className="pve-actions">
        <button className="pve-btn pve-btn--primary" onClick={save} disabled={busy}>Save</button>
        <button className="pve-btn" onClick={provision} disabled={busy}>Provision LXC</button>
        <button className="pve-btn" onClick={test} disabled={busy}>Test</button>
        <button className="pve-btn" onClick={start} disabled={busy || isDirty}>
          Start LXC
        </button>
        <button className="pve-btn" onClick={stop} disabled={busy || isDirty}>
          Stop LXC
        </button>
      </div>

      {status && (
        <div className={`pve-status pve-status--${status.kind}`} role="status">
          {status.text}
        </div>
      )}
    </div>
  );
}
