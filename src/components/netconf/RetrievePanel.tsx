import { useState } from "react";
import { useNetconfRunner } from "../../state/netconfRunnerStore";

type Props = {
  tabId: string;
  onRetrieve: (rpc: string) => void;
};

export function RetrievePanel({ tabId, onRetrieve }: Props) {
  const state = useNetconfRunner((s) => s.tabs[tabId]);
  const [schemaName, setSchemaName] = useState("");
  const [filterXPath, setFilterXPath] = useState("");

  const isConnected = state?.status === "connected";

  const retrieveRunning = () => {
    onRetrieve(`<get-config>
  <source>
    <running/>
  </source>
</get-config>`);
  };

  const retrieveStartup = () => {
    onRetrieve(`<get-config>
  <source>
    <startup/>
  </source>
</get-config>`);
  };

  const retrieveCandidate = () => {
    onRetrieve(`<get-config>
  <source>
    <candidate/>
  </source>
</get-config>`);
  };

  const retrieveOperational = () => {
    const rpc = filterXPath.trim()
      ? `<get>
  <filter type="xpath" select="${filterXPath.trim()}"/>
</get>`
      : `<get/>`;
    onRetrieve(rpc);
  };

  const retrieveCapabilities = () => {
    if (!state?.capabilities || state.capabilities.length === 0) {
      alert("No capabilities available. Connect to a device first.");
      return;
    }
    // Display capabilities in response viewer
    const capabilitiesXml = `<capabilities>\n${state.capabilities
      .map((c) => `  <capability>${c}</capability>`)
      .join("\n")}\n</capabilities>`;
    onRetrieve(`<!-- Capabilities list -->\n${capabilitiesXml}`);
  };

  const retrieveSchema = () => {
    const name = schemaName.trim();
    if (!name) {
      alert("Enter a YANG module name");
      return;
    }
    onRetrieve(`<get-schema xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring">
  <identifier>${name}</identifier>
  <format>yang</format>
</get-schema>`);
  };

  return (
    <div
      data-testid="netconf-retrieve-panel"
      style={{
        padding: 12,
        borderBottom: "1px solid var(--border-default)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)" }}>
        Quick Retrieve
      </div>

      {/* Config datastores */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        <RetrieveButton
          label="Running"
          onClick={retrieveRunning}
          disabled={!isConnected}
          testId="retrieve-running"
        />
        <RetrieveButton
          label="Startup"
          onClick={retrieveStartup}
          disabled={!isConnected}
          testId="retrieve-startup"
        />
        <RetrieveButton
          label="Candidate"
          onClick={retrieveCandidate}
          disabled={!isConnected}
          testId="retrieve-candidate"
        />
      </div>

      {/* Operational + capabilities */}
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input
          data-testid="retrieve-filter-xpath"
          type="text"
          value={filterXPath}
          onChange={(e) => setFilterXPath(e.target.value)}
          placeholder="XPath filter (optional)"
          disabled={!isConnected}
          style={{
            flex: 1,
            background: "var(--app-canvas)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-default)",
            borderRadius: 4,
            padding: "4px 8px",
            fontSize: 11,
            fontFamily: "Menlo, monospace",
          }}
        />
        <RetrieveButton
          label="Get"
          onClick={retrieveOperational}
          disabled={!isConnected}
          testId="retrieve-get"
        />
      </div>

      <RetrieveButton
        label="Capabilities"
        onClick={retrieveCapabilities}
        disabled={!isConnected}
        testId="retrieve-capabilities"
        fullWidth
      />

      {/* Get-schema */}
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input
          data-testid="retrieve-schema-name"
          type="text"
          value={schemaName}
          onChange={(e) => setSchemaName(e.target.value)}
          placeholder="YANG module name"
          disabled={!isConnected}
          style={{
            flex: 1,
            background: "var(--app-canvas)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-default)",
            borderRadius: 4,
            padding: "4px 8px",
            fontSize: 11,
            fontFamily: "Menlo, monospace",
          }}
        />
        <RetrieveButton
          label="Get Schema"
          onClick={retrieveSchema}
          disabled={!isConnected}
          testId="retrieve-schema"
        />
      </div>
    </div>
  );
}

function RetrieveButton({
  label,
  onClick,
  disabled,
  testId,
  fullWidth = false,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  testId: string;
  fullWidth?: boolean;
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      style={{
        background: "transparent",
        color: disabled ? "var(--text-muted)" : "var(--accent)",
        border: "1px dashed var(--border-default)",
        borderRadius: 4,
        padding: "4px 10px",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 11,
        flex: fullWidth ? 1 : undefined,
      }}
    >
      {label}
    </button>
  );
}
