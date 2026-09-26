import { useEffect } from "react";
import type { NetconfTabState } from "../../state/netconfRunnerStore";
import { useNetconfRunner } from "../../state/netconfRunnerStore";
import {
  netconfDeviceList,
  netconfDeviceGetPassword,
  netconfDeviceDelete,
} from "../../lib/tauri";

type Props = {
  tabId: string;
  state: NetconfTabState;
  onConnect: () => void;
  onDisconnect: () => void;
};

export function ConnectionPanel({ tabId, state, onConnect, onDisconnect }: Props) {
  const patch = useNetconfRunner((s) => s.patch);
  const savedDevices = useNetconfRunner((s) => s.savedDevices);
  const setSavedDevices = useNetconfRunner((s) => s.setSavedDevices);

  // Load saved devices on mount
  useEffect(() => {
    netconfDeviceList()
      .then(setSavedDevices)
      .catch((err) => console.error("Failed to load devices:", err));
  }, [setSavedDevices]);

  const onSelectDevice = async (deviceId: string) => {
    if (deviceId === "new") {
      // Clear form for new connection
      patch(tabId, {
        host: "",
        port: 830,
        username: "",
        password: "",
        device_name: "",
        selected_device_id: null,
      });
      return;
    }

    const id = parseInt(deviceId, 10);
    const device = savedDevices.find((d) => d.id === id);
    if (!device) return;

    try {
      const password = await netconfDeviceGetPassword(device.id);
      patch(tabId, {
        host: device.host,
        port: device.port,
        username: device.username,
        password,
        device_name: device.name,
        selected_device_id: id,
        connection_error: null,
      });
    } catch (err) {
      // Password not in keychain - fill in device details but leave password blank
      // User will need to enter password manually
      patch(tabId, {
        host: device.host,
        port: device.port,
        username: device.username,
        password: "",
        device_name: device.name,
        selected_device_id: id,
        connection_error: "Password not found - please enter it below",
      });
    }
  };

  const onDeleteDevice = async (deviceId: number) => {
    if (!confirm("Delete this saved device?")) return;
    try {
      await netconfDeviceDelete(deviceId);
      setSavedDevices(savedDevices.filter((d) => d.id !== deviceId));
    } catch (err) {
      console.error("Failed to delete device:", err);
    }
  };

  const isDisconnected = state.status === "disconnected" || state.status === "error";
  const isConnecting = state.status === "connecting";
  const isConnected = state.status === "connected";

  return (
    <div
      data-testid="netconf-connection-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      {/* Device picker - always visible */}
      <div
        style={{
          padding: 12,
          borderBottom: "1px solid var(--border-default)",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <label style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 500 }}>
          Saved Devices
        </label>
        <div style={{ display: "flex", gap: 4 }}>
          <select
            data-testid="netconf-device-picker"
            value={state.selected_device_id ?? "new"}
            onChange={(e) => onSelectDevice(e.target.value)}
            disabled={isConnected}
            style={{
              flex: 1,
              background: "var(--app-canvas)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: "6px 8px",
              fontFamily: "Menlo, monospace",
              fontSize: 12,
              cursor: isConnected ? "not-allowed" : "pointer",
            }}
          >
            <option value="new">New connection...</option>
            {savedDevices.map((dev) => (
              <option key={dev.id} value={dev.id}>
                {dev.name} ({dev.host})
              </option>
            ))}
          </select>
          {state.selected_device_id !== null && (
            <button
              data-testid="netconf-delete-device"
              onClick={() => onDeleteDevice(state.selected_device_id!)}
              disabled={isConnected}
              style={{
                background: "transparent",
                color: "var(--status-danger)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                padding: "6px 10px",
                cursor: isConnected ? "not-allowed" : "pointer",
                fontSize: 12,
              }}
              title="Delete selected device"
            >
              🗑️
            </button>
          )}
        </div>
      </div>

      {/* Connection form */}
      {isDisconnected && (
        <div
          style={{
            padding: 12,
            borderBottom: "1px solid var(--border-default)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
            Connect to Device
          </div>

          <Input
            testId="netconf-host"
            label="Host"
            value={state.host}
            onChange={(v) => patch(tabId, { host: v })}
            placeholder="192.168.1.1"
          />
          <Input
            testId="netconf-port"
            label="Port"
            value={String(state.port)}
            onChange={(v) => patch(tabId, { port: parseInt(v, 10) || 830 })}
            placeholder="830"
            type="number"
          />
          <Input
            testId="netconf-username"
            label="Username"
            value={state.username}
            onChange={(v) => patch(tabId, { username: v })}
            placeholder="admin"
          />
          <Input
            testId="netconf-password"
            label="Password"
            value={state.password}
            onChange={(v) => patch(tabId, { password: v })}
            placeholder="password"
            type="password"
          />

          {/* Save as device checkbox */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              color: "var(--text-primary)",
              cursor: "pointer",
            }}
          >
            <input
              data-testid="netconf-save-as-device"
              type="checkbox"
              checked={state.save_as_device}
              onChange={(e) =>
                patch(tabId, { save_as_device: e.target.checked })
              }
            />
            Save as device
          </label>

          {/* Device name (only shown if save_as_device is true) */}
          {state.save_as_device && (
            <Input
              testId="netconf-device-name"
              label="Device Name"
              value={state.device_name}
              onChange={(v) => patch(tabId, { device_name: v })}
              placeholder="Lab CSR1000v"
            />
          )}

          {state.connection_error && (
            <div
              data-testid="netconf-connection-error"
              style={{
                color: "var(--status-danger)",
                fontSize: 11,
                padding: "6px 8px",
                background: "var(--surface-2)",
                borderRadius: 4,
                border: "1px solid var(--border-default)",
              }}
            >
              {state.connection_error}
            </div>
          )}
          <button
            data-testid="netconf-connect-button"
            onClick={onConnect}
            disabled={isConnecting}
            style={{
              background: isConnecting ? "var(--surface-3)" : "var(--accent-subtle)",
              color: "var(--text-primary)",
              border: "none",
              borderRadius: 4,
              padding: "8px 12px",
              cursor: isConnecting ? "wait" : "pointer",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {isConnecting ? "Connecting..." : "Connect"}
          </button>
        </div>
      )}

      {/* Session status */}
      {isConnected && (
        <div
          style={{
            padding: 12,
            borderBottom: "1px solid var(--border-default)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--status-success)",
              }}
            />
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
              Connected
            </div>
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-secondary)",
              fontFamily: "Menlo, monospace",
            }}
          >
            {state.host}:{state.port}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-secondary)",
            }}
          >
            Session ID: {state.server_session_id}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-secondary)",
            }}
          >
            Framing: NETCONF {state.framing}
          </div>
          <button
            data-testid="netconf-disconnect-button"
            onClick={onDisconnect}
            style={{
              background: "transparent",
              color: "var(--status-danger)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: "6px 10px",
              cursor: "pointer",
              fontSize: 12,
              marginTop: 4,
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

function Input({
  testId,
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  testId: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  type?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label
        htmlFor={testId}
        style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 500 }}
      >
        {label}
      </label>
      <input
        id={testId}
        data-testid={testId}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          background: "var(--app-canvas)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-default)",
          borderRadius: 4,
          padding: "6px 8px",
          fontFamily: "Menlo, monospace",
          fontSize: 12,
        }}
      />
    </div>
  );
}
