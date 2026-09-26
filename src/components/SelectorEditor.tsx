import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { IntentSelector } from "../lib/drift";
import { sshListConnections, type SshConnection } from "../lib/sshConnections";

interface FanoutGroupLite {
  id: string;
  name: string;
  member_count: number;
}

type Mode = "group" | "ssh";

interface Props {
  value: IntentSelector;
  onChange: (s: IntentSelector) => void;
}

/**
 * Intent selector editor. Drift runs through the fan-out executor, so a
 * template targets either a saved fan-out group (every member) or a single
 * saved SSH connection — not the old command-block tag vocabulary.
 *
 * The legacy `device_ids` / `tags` fields are preserved on the value object
 * but are no longer editable here; choosing a group or connection clears the
 * other selection so resolution stays unambiguous.
 */
export function SelectorEditor({ value, onChange }: Props) {
  const [groups, setGroups] = useState<FanoutGroupLite[]>([]);
  const [conns, setConns] = useState<SshConnection[]>([]);
  const [mode, setMode] = useState<Mode>(
    value.ssh_connection_id ? "ssh" : "group",
  );

  useEffect(() => {
    invoke<FanoutGroupLite[]>("fanout_group_list")
      .then(setGroups)
      .catch((e) => console.warn("fanout_group_list failed", e));
    sshListConnections()
      .then(setConns)
      .catch((e) => console.warn("ssh_list_connections failed", e));
  }, []);

  const pickGroup = (groupId: string) => {
    onChange({
      ...value,
      group_id: groupId || null,
      ssh_connection_id: null,
    });
  };

  const pickSsh = (connId: string) => {
    onChange({
      ...value,
      ssh_connection_id: connId || null,
      group_id: null,
    });
  };

  return (
    <div className="selector-editor" style={{ padding: 16, fontSize: 12 }}>
      <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
        Choose what this intent is checked against. Drift opens an SSH session
        to each target and compares its running-config to the intent body.
      </p>

      <label className="selector-mode-row">
        <input
          type="radio"
          name="selector-mode"
          checked={mode === "group"}
          onChange={() => setMode("group")}
          data-testid="selector-mode-group"
        />
        <span>Fan-out group</span>
      </label>
      {mode === "group" && (
        <select
          className="selector-select"
          value={value.group_id ?? ""}
          onChange={(e) => pickGroup(e.target.value)}
          data-testid="selector-group-select"
        >
          <option value="">— select a group —</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({g.member_count} devices)
            </option>
          ))}
        </select>
      )}

      <label className="selector-mode-row" style={{ marginTop: 12 }}>
        <input
          type="radio"
          name="selector-mode"
          checked={mode === "ssh"}
          onChange={() => setMode("ssh")}
          data-testid="selector-mode-ssh"
        />
        <span>Single SSH connection</span>
      </label>
      {mode === "ssh" && (
        <select
          className="selector-select"
          value={value.ssh_connection_id ?? ""}
          onChange={(e) => pickSsh(e.target.value)}
          data-testid="selector-ssh-select"
        >
          <option value="">— select a connection —</option>
          {conns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.host})
            </option>
          ))}
        </select>
      )}

      {value.tags.length > 0 && (
        <p style={{ color: "var(--text-primary)", marginTop: 12 }}>
          This template used legacy tag selection ({value.tags.join(", ")}),
          which is no longer supported. Pick a group or connection above.
        </p>
      )}
    </div>
  );
}
