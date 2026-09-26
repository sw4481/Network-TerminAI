import { useCallback, useState } from "react";
import type { Tab } from "../../lib/types";
import type { NetconfHistoryDetail, SavedNetconfRpc } from "../../lib/tauri";
import {
  netconfConnect,
  netconfSendRpc,
  netconfDeviceCreate,
  netconfDeviceList,
  netconfWrapCli,
} from "../../lib/tauri";
import {
  isConnectable,
  isSendable,
  useNetconfRunner,
} from "../../state/netconfRunnerStore";
import { ConnectionPanel } from "./ConnectionPanel";
import { RpcEditor } from "./RpcEditor";
import { ResponseViewer } from "./ResponseViewer";
import { HistoryPanel } from "./HistoryPanel";
import { RetrievePanel } from "./RetrievePanel";
import { SavedRpcsPanel } from "./SavedRpcsPanel";
import { YangBrowser } from "./YangBrowser";

export function NetconfTab({ tab }: { tab: Tab }) {
  const ensure = useNetconfRunner((s) => s.ensure);
  const state = useNetconfRunner((s) => s.tabs[tab.id]) ?? ensure(tab.id);
  const patch = useNetconfRunner((s) => s.patch);
  const setSavedDevices = useNetconfRunner((s) => s.setSavedDevices);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [savedRpcsOpen, setSavedRpcsOpen] = useState(false);
  const [yangBrowserOpen, setYangBrowserOpen] = useState(false);

  const onConnect = useCallback(async () => {
    if (!isConnectable(state)) return;
    patch(tab.id, { status: "connecting", connection_error: null });
    try {
      const result = await netconfConnect({
        host: state.host.trim(),
        port: state.port,
        username: state.username.trim(),
        password: state.password.trim(),
      });
      patch(tab.id, {
        session_id: result.session_id,
        server_session_id: result.server_session_id,
        capabilities: result.capabilities,
        framing: result.framing,
        status: "connected",
        connection_error: null,
      });

      // Save as device if requested
      if (state.save_as_device && state.device_name.trim()) {
        try {
          const newDevice = await netconfDeviceCreate(
            state.device_name.trim(),
            state.host.trim(),
            state.port,
            state.username.trim(),
            state.password.trim(),
            false, // verify_host_key - default to false for now
          );
          // Refresh saved devices list
          const devices = await netconfDeviceList();
          setSavedDevices(devices);
          // Update selected_device_id to the newly created device
          patch(tab.id, { selected_device_id: newDevice.id });
          console.log("Device saved successfully with password in keychain");
        } catch (saveErr) {
          const errMsg = saveErr instanceof Error ? saveErr.message : String(saveErr);
          console.error("Failed to save device:", errMsg);
          alert(`Device saved but password storage failed: ${errMsg}`);
          // Don't fail the connection if save fails
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patch(tab.id, {
        status: "error",
        connection_error: msg,
        session_id: null,
        server_session_id: null,
        capabilities: [],
        framing: null,
      });
    }
  }, [state, tab.id, patch, setSavedDevices]);

  const onDisconnect = useCallback(() => {
    // TODO: implement netconf_disconnect in Step 4
    patch(tab.id, {
      status: "disconnected",
      session_id: null,
      server_session_id: null,
      capabilities: [],
      framing: null,
      connection_error: null,
      response: null,
      rpc_error: null,
    });
  }, [tab.id, patch]);

  const onSendRpc = useCallback(async () => {
    if (!isSendable(state) || !state.session_id) return;
    patch(tab.id, { sending: true, rpc_error: null });
    try {
      // If in CLI mode, wrap the CLI text first
      let rpcXml = state.rpc_xml.trim();
      if (state.editor_mode === "cli") {
        rpcXml = await netconfWrapCli(state.cli_platform, rpcXml);
      }

      const response = await netconfSendRpc(
        tab.id,
        state.session_id,
        state.host,
        rpcXml
      );
      patch(tab.id, { response, sending: false, rpc_error: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patch(tab.id, { sending: false, rpc_error: msg, response: null });
    }
  }, [state, tab.id, patch]);

  const onLoadHistory = useCallback(
    (detail: NetconfHistoryDetail) => {
      patch(tab.id, {
        rpc_xml: detail.request_xml,
        response: detail.response_xml,
        rpc_error: detail.error_message,
      });
    },
    [tab.id, patch]
  );

  const onRetrieve = useCallback(
    (rpc: string) => {
      patch(tab.id, { rpc_xml: rpc, editor_mode: "xml" });
    },
    [tab.id, patch]
  );

  const onLoadSavedRpc = useCallback(
    (rpc: SavedNetconfRpc) => {
      patch(tab.id, { rpc_xml: rpc.rpc_xml, editor_mode: "xml" });
      setSavedRpcsOpen(false);
    },
    [tab.id, patch]
  );

  const onInsertYangXml = useCallback(
    (xml: string) => {
      patch(tab.id, { rpc_xml: xml, editor_mode: "xml" });
      setYangBrowserOpen(false);
    },
    [tab.id, patch]
  );

  return (
    <div
      className="netconf-tab"
      data-testid="netconf-tab"
      data-tab-id={tab.id}
      style={{
        display: "flex",
        flexDirection: "row",
        height: "100%",
        minHeight: 0,
      }}
    >
      {/* Left rail: connection panel + retrieve */}
      <div
        style={{
          width: 280,
          borderRight: "1px solid var(--border-default)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <ConnectionPanel
          tabId={tab.id}
          state={state}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
        />
        {state.status === "connected" && (
          <RetrievePanel tabId={tab.id} onRetrieve={onRetrieve} />
        )}

        {/* YANG Browser button */}
        <div style={{ padding: 12, borderTop: "1px solid var(--border-default)" }}>
          <button
            data-testid="netconf-yang-browser-toggle"
            onClick={() => setYangBrowserOpen(!yangBrowserOpen)}
            style={{
              background: yangBrowserOpen ? "var(--accent-subtle)" : "transparent",
              color: yangBrowserOpen ? "var(--text-primary)" : "var(--accent)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: "6px 10px",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              width: "100%",
            }}
          >
            {yangBrowserOpen ? "Close YANG Browser" : "YANG Browser"}
          </button>
        </div>
      </div>

      {/* Right: editor + response split */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          position: "relative",
        }}
      >
        <RpcEditor
          tabId={tab.id}
          state={state}
          onSend={onSendRpc}
          historyOpen={historyOpen}
          onToggleHistory={() => setHistoryOpen(!historyOpen)}
          savedRpcsOpen={savedRpcsOpen}
          onToggleSavedRpcs={() => setSavedRpcsOpen(!savedRpcsOpen)}
        />
        <div
          style={{
            borderTop: "1px solid var(--border-default)",
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <ResponseViewer tabId={tab.id} state={state} />
        </div>

        {/* History panel */}
        {historyOpen && (
          <HistoryPanel
            tabId={tab.id}
            onClose={() => setHistoryOpen(false)}
            onLoad={onLoadHistory}
          />
        )}

        {/* Saved RPCs panel */}
        {savedRpcsOpen && (
          <SavedRpcsPanel
            tabId={tab.id}
            onClose={() => setSavedRpcsOpen(false)}
            onLoad={onLoadSavedRpc}
          />
        )}

        {/* YANG Browser panel */}
        {yangBrowserOpen && (
          <YangBrowser
            tabId={tab.id}
            onClose={() => setYangBrowserOpen(false)}
            onInsertXml={onInsertYangXml}
          />
        )}
      </div>
    </div>
  );
}
