import { useState } from "react";
import {
  parseMcpConfig,
  validateMcpConfig,
  type McpServerConfig,
  type ParseResult,
} from "../lib/mcpConfigParser";

interface ImportMcpServerProps {
  onImport: (configs: McpServerConfig[]) => Promise<void>;
  onClose: () => void;
}

export function ImportMcpServer({ onImport, onClose }: ImportMcpServerProps) {
  const [jsonInput, setJsonInput] = useState("");
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [editedConfigs, setEditedConfigs] = useState<McpServerConfig[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const handleParse = () => {
    const result = parseMcpConfig(jsonInput);
    setParseResult(result);
    if (result.success) {
      setEditedConfigs(result.configs);
      setImportError(null);
    }
  };

  const handleImport = async () => {
    // Validate all configs
    for (const config of editedConfigs) {
      const error = validateMcpConfig(config);
      if (error) {
        setImportError(`${config.name}: ${error}`);
        return;
      }
    }

    setImporting(true);
    setImportError(null);

    try {
      await onImport(editedConfigs);
      onClose();
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "Failed to import");
    } finally {
      setImporting(false);
    }
  };

  const updateConfig = (index: number, field: string, value: any) => {
    const newConfigs = [...editedConfigs];
    newConfigs[index] = { ...newConfigs[index], [field]: value };
    setEditedConfigs(newConfigs);
  };

  const updateEnv = (index: number, key: string, value: string) => {
    const newConfigs = [...editedConfigs];
    const env = { ...(newConfigs[index].env || {}) };
    if (value) {
      env[key] = value;
    } else {
      delete env[key];
    }
    newConfigs[index] = { ...newConfigs[index], env };
    setEditedConfigs(newConfigs);
  };

  const addEnvVar = (index: number) => {
    const newConfigs = [...editedConfigs];
    const env = { ...(newConfigs[index].env || {}), "": "" };
    newConfigs[index] = { ...newConfigs[index], env };
    setEditedConfigs(newConfigs);
  };

  const removeConfig = (index: number) => {
    setEditedConfigs(editedConfigs.filter((_, i) => i !== index));
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content import-mcp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Import MCP Server Configuration</h2>
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          {!parseResult?.success ? (
            <div className="parse-section">
              <p className="help-text">
                Paste JSON configuration from Claude Desktop or a simple server config:
              </p>
              <textarea
                className="json-input"
                value={jsonInput}
                onChange={(e) => setJsonInput(e.target.value)}
                placeholder={`Example formats:

// Single stdio server
{
  "name": "filesystem",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
}

// Claude Desktop config.json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "$HOME/Documents"]
    }
  }
}

// SSE server
{
  "name": "remote-tools",
  "transport": "sse",
  "url": "https://mcp-server.example.com/sse"
}`}
                rows={15}
              />

              {parseResult && !parseResult.success && (
                <div className="error-message">
                  <strong>Parse Error:</strong> {parseResult.error}
                </div>
              )}

              <div className="button-row">
                <button onClick={handleParse} disabled={!jsonInput.trim()}>
                  Parse
                </button>
                <button onClick={onClose} className="secondary">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="preview-section">
              <div className="preview-header">
                <h3>Review and Edit ({editedConfigs.length} server{editedConfigs.length !== 1 ? "s" : ""})</h3>
                {parseResult.error && (
                  <div className="warning-message">
                    <strong>Warnings:</strong> {parseResult.error}
                  </div>
                )}
              </div>

              <div className="configs-list">
                {editedConfigs.map((config, i) => (
                  <div key={i} className="config-item">
                    <div className="config-header">
                      <input
                        type="text"
                        value={config.name}
                        onChange={(e) => updateConfig(i, "name", e.target.value)}
                        className="name-input"
                      />
                      <span className="transport-badge">{config.transport}</span>
                      <button
                        onClick={() => removeConfig(i)}
                        className="remove-btn"
                        title="Remove"
                      >
                        ×
                      </button>
                    </div>

                    {config.transport === "stdio" ? (
                      <>
                        <div className="field">
                          <label>Command:</label>
                          <input
                            type="text"
                            value={config.command || ""}
                            onChange={(e) => updateConfig(i, "command", e.target.value)}
                          />
                        </div>
                        <div className="field">
                          <label>Args (JSON array):</label>
                          <input
                            type="text"
                            value={JSON.stringify(config.args || [])}
                            onChange={(e) => {
                              try {
                                const args = JSON.parse(e.target.value);
                                if (Array.isArray(args)) {
                                  updateConfig(i, "args", args);
                                }
                              } catch {
                                // Ignore invalid JSON while typing
                              }
                            }}
                          />
                        </div>
                        <div className="field">
                          <label>Environment Variables:</label>
                          <div className="env-vars">
                            {Object.entries(config.env || {}).map(([key, value]) => (
                              <div key={key} className="env-var-row">
                                <input
                                  type="text"
                                  value={key}
                                  onChange={(e) => {
                                    const newKey = e.target.value;
                                    if (newKey !== key) {
                                      const newEnv = { ...(config.env || {}) };
                                      delete newEnv[key];
                                      if (newKey) {
                                        newEnv[newKey] = value;
                                      }
                                      updateConfig(i, "env", newEnv);
                                    }
                                  }}
                                  placeholder="KEY"
                                  className="env-key"
                                />
                                <input
                                  type="text"
                                  value={value}
                                  onChange={(e) => updateEnv(i, key, e.target.value)}
                                  placeholder="value"
                                  className="env-value"
                                />
                                <button
                                  onClick={() => {
                                    const newEnv = { ...(config.env || {}) };
                                    delete newEnv[key];
                                    updateConfig(i, "env", newEnv);
                                  }}
                                  className="remove-env-btn"
                                  title="Remove"
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                            <button onClick={() => addEnvVar(i)} className="add-env-btn">
                              + Add Variable
                            </button>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="field">
                        <label>URL:</label>
                        <input
                          type="text"
                          value={config.url || ""}
                          onChange={(e) => updateConfig(i, "url", e.target.value)}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {importError && (
                <div className="error-message">
                  <strong>Import Error:</strong> {importError}
                </div>
              )}

              <div className="button-row">
                <button onClick={handleImport} disabled={importing || editedConfigs.length === 0}>
                  {importing ? "Importing..." : "Import"}
                </button>
                <button onClick={() => setParseResult(null)} className="secondary">
                  Back
                </button>
                <button onClick={onClose} className="secondary">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
