import { useState } from "react";
import { usePyatsStore, emptyDevice } from "../../state/pyatsStore";
import { saveTestbed, importFromTopology, testConnection, type PyatsDevice } from "../../features/pyats/api";
import "./PyatsSettingsTab.css";

const OS_OPTIONS = ["iosxe", "iosxr", "nxos", "ios", "eos", "junos", "linux", "generic"];

export function PyatsSettingsTab() {
  const { devices, transport, addDevice, updateDevice, removeDevice, setDevices, setTransport } =
    usePyatsStore();
  const [status, setStatus] = useState<string>("");
  const [probe, setProbe] = useState<Record<number, string>>({});

  const onField = (i: number, field: keyof PyatsDevice, value: string | number | null) =>
    updateDevice(i, { ...devices[i], [field]: value } as PyatsDevice);

  const onSave = async () => {
    setStatus("Saving…");
    try {
      const path = await saveTestbed(devices);
      setStatus(`✓ Saved to ${path}`);
      setTimeout(() => setStatus(""), 3000);
    } catch (e) {
      setStatus(`Error: ${String(e)}`);
    }
  };

  const onImport = async () => {
    setStatus("Importing from topology…");
    try {
      const imported = await importFromTopology();
      setDevices([...devices, ...imported]);
      setStatus(`✓ Imported ${imported.length} device(s)`);
      setTimeout(() => setStatus(""), 3000);
    } catch (e) {
      setStatus(`Error: ${String(e)}`);
    }
  };

  const onTest = async (i: number) => {
    const d = devices[i];
    const label = d.name || d.host || `device ${i + 1}`;
    setProbe((p) => ({ ...p, [i]: "…" }));
    setStatus(`Testing ${label}…`);
    try {
      const res = await testConnection(d);
      const msg = res.ok ? `✅ Connected` : `❌ ${res.message}`;
      setProbe((p) => ({ ...p, [i]: msg }));
      // Surface the result in the always-visible status bar too — the Actions
      // cell is narrow and clips longer error text.
      setStatus(`${label}: ${res.ok ? "✅ Connected" : `❌ ${res.message}`}`);
      setTimeout(() => setProbe((p) => ({ ...p, [i]: "" })), 8000);
    } catch (e) {
      setProbe((p) => ({ ...p, [i]: `❌ error` }));
      setStatus(`${label}: ❌ ${String(e)}`);
    }
  };

  return (
    <div className="pyats-settings">
      <h2>pyATS Devices</h2>
      <p className="pyats-warning">
        ⚠️ Device passwords are <strong>stored unencrypted</strong> on this machine
        (<code>~/.ccie-terminal/pyats/.env</code>, file permissions 600).
      </p>

      <div className="pyats-toolbar">
        <button onClick={() => addDevice(emptyDevice())}>Add Device</button>
        <button onClick={onImport}>Import from Topology</button>
        <button onClick={onSave} className="pyats-save-btn">Save</button>
      </div>

      {devices.length === 0 ? (
        <div className="pyats-empty">
          <p>No devices configured. Click "Add Device" to get started.</p>
        </div>
      ) : (
        <div className="pyats-table-container">
          <table className="pyats-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Host/IP</th>
                <th>OS</th>
                <th>Port</th>
                <th>Username</th>
                <th>Password</th>
                <th>Enable</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d, i) => (
                <tr key={i}>
                  <td>
                    <input
                      value={d.name}
                      onChange={(e) => onField(i, "name", e.target.value)}
                      placeholder="CORE1"
                    />
                  </td>
                  <td>
                    <input
                      value={d.host}
                      onChange={(e) => onField(i, "host", e.target.value)}
                      placeholder="10.0.0.1"
                    />
                  </td>
                  <td>
                    <select value={d.os} onChange={(e) => onField(i, "os", e.target.value)}>
                      {OS_OPTIONS.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      value={d.port}
                      onChange={(e) => onField(i, "port", Number(e.target.value))}
                      style={{ width: "60px" }}
                    />
                  </td>
                  <td>
                    <input
                      value={d.username}
                      onChange={(e) => onField(i, "username", e.target.value)}
                      placeholder="admin"
                    />
                  </td>
                  <td>
                    <input
                      type="password"
                      value={d.password}
                      onChange={(e) => onField(i, "password", e.target.value)}
                      placeholder="password"
                    />
                  </td>
                  <td>
                    <input
                      type="password"
                      value={d.enablePassword}
                      onChange={(e) => onField(i, "enablePassword", e.target.value)}
                      placeholder="enable"
                    />
                  </td>
                  <td>
                    <div className="pyats-actions">
                      <button onClick={() => onTest(i)} className="pyats-test-btn" title="Test connection">
                        Test
                      </button>
                      <button onClick={() => removeDevice(i)} className="pyats-remove-btn" title="Remove device">
                        ✕
                      </button>
                      {probe[i] && <span className="pyats-probe">{probe[i]}</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="pyats-transport">
        <label>
          <input
            type="checkbox"
            checked={transport === "pyats"}
            onChange={(e) => setTransport(e.target.checked ? "pyats" : "sshpass")}
          />
          Use pyATS (instead of sshpass) for topology discovery and device info in tabs
        </label>
      </div>

      {status && <div className="pyats-status">{status}</div>}
    </div>
  );
}
