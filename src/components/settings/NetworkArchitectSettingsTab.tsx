import { useEffect, useState } from "react";
import {
  agentsGet,
  agentsUpdate,
  networkArchitectSoulList,
  networkArchitectSoulSave,
  type Agent,
  type NetworkArchitectSoulFile,
} from "../../lib/tauri";

const ARCHITECT_ID = "network-architect";

export default function NetworkArchitectSettingsTab() {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [persona, setPersona] = useState("");
  const [soulFiles, setSoulFiles] = useState<NetworkArchitectSoulFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [loaded, souls] = await Promise.all([agentsGet(ARCHITECT_ID), networkArchitectSoulList()]);
        setAgent(loaded);
        setPersona(loaded.systemPrompt);
        setSoulFiles(souls);
      } catch (error) {
        setStatus({ kind: "err", text: `Failed to load Network Architect: ${String(error)}` });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    if (!agent) return;
    setSaving(true);
    try {
      const updated = await agentsUpdate(ARCHITECT_ID, {
        name: agent.name,
        description: agent.description,
        systemPrompt: persona,
        modelOverride: agent.modelOverride ?? null,
        attachedSkills: agent.attachedSkills,
        attachedMcpServers: agent.attachedMcpServers,
        allowedCommands: agent.allowedCommands,
        body: agent.body,
        executionMode: agent.executionMode,
        engine: agent.engine ?? null,
      });
      setAgent(updated);
      setPersona(updated.systemPrompt);

      const savedSoulFiles: NetworkArchitectSoulFile[] = [];
      for (const file of soulFiles) {
        try {
          savedSoulFiles.push(await networkArchitectSoulSave(file.fileName, file.content));
        } catch (error) {
          setStatus({ kind: "err", text: `Persona saved, but ${file.fileName} failed: ${String(error)}` });
          return;
        }
      }
      setSoulFiles(savedSoulFiles);
      setStatus({ kind: "ok", text: "Network Architect persona and SOUL files saved." });
    } catch (error) {
      setStatus({ kind: "err", text: `Save failed: ${String(error)}` });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="tab-content"><p className="muted">Loading Network Architect…</p></div>;
  }

  return (
    <div className="tab-content">
      <h2>Network Architect Persona</h2>
      <p className="muted" style={{ marginBottom: "16px" }}>
        Edit the Network Architect system prompt and live SOUL prompt files. Changes take effect on the next agent turn.
      </p>

      <div className="form-group">
        <label htmlFor="network-architect-persona">Persona prompt</label>
        <textarea
          id="network-architect-persona"
          value={persona}
          onChange={(event) => setPersona(event.target.value)}
          rows={14}
          disabled={!agent || saving}
          style={textAreaStyle}
        />
      </div>

      {soulFiles.map((file, index) => (
        <div className="form-group" key={file.fileName}>
          <label htmlFor={`network-architect-${file.fileName}`}>{file.fileName}</label>
          <textarea
            id={`network-architect-${file.fileName}`}
            value={file.content}
            onChange={(event) => setSoulFiles((current) => current.map((item, itemIndex) => (
              itemIndex === index ? { ...item, content: event.target.value } : item
            )))}
            rows={12}
            disabled={!agent || saving}
            style={textAreaStyle}
          />
        </div>
      ))}

      <div className="form-actions">
        <button className="primary" onClick={save} disabled={!agent || saving || !persona.trim()}>
          {saving ? "Saving…" : "Save Network Architect"}
        </button>
      </div>

      {status && (
        <div
          className={status.kind === "ok" ? "success-message" : "error-message"}
          role={status.kind === "ok" ? "status" : "alert"}
          aria-live={status.kind === "ok" ? "polite" : undefined}
        >
          {status.text}
        </div>
      )}
    </div>
  );
}

const textAreaStyle = {
  width: "100%",
  padding: "10px 12px",
  background: "var(--surface-chrome)",
  border: "1px solid var(--border-default)",
  borderRadius: "4px",
  color: "var(--text-primary)",
  fontSize: "13px",
  fontFamily: "monospace",
  resize: "vertical",
} as const;
