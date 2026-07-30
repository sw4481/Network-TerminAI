import { useEffect, useState } from "react";
import { useFanoutStore } from "../state/fanoutStore";
import type { FanoutGroup } from "../lib/fanout";
import { DevicePickerDialog } from "./DevicePickerDialog";
import "./FanoutGroupsPanel.css";

const FANOUT_CAP = 50;

export function FanoutGroupsPanel() {
  const {
    groups,
    membersByGroup,
    loading,
    error,
    refreshGroups,
    refreshMembers,
    createGroup,
    deleteGroup,
    removeMember,
  } = useFanoutStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    refreshGroups();
  }, [refreshGroups]);

  useEffect(() => {
    if (selectedId) refreshMembers(selectedId);
  }, [selectedId, refreshMembers]);

  const selected: FanoutGroup | undefined = groups.find((g) => g.id === selectedId);
  const members = selectedId ? (membersByGroup[selectedId] ?? []) : [];

  // window.prompt is blocked in the Tauri webview (returns null), so group
  // creation uses an inline input instead of a native dialog.
  const handleSubmitNewGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const g = await createGroup(name, null);
    setNewName("");
    setCreating(false);
    setSelectedId(g.id);
  };

  const cancelNewGroup = () => {
    setNewName("");
    setCreating(false);
  };

  const handleDelete = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete group "${selected.name}"?`)) return;
    await deleteGroup(selected.id);
    setSelectedId(null);
  };

  return (
    <div className="fanout-groups-panel" data-testid="fanout-groups-panel">
      <div className="fanout-groups-list">
        <div className="fanout-groups-list-header">
          <span>GROUPS ({groups.length})</span>
          <button
            onClick={() => setCreating((c) => !c)}
            data-testid="fanout-new-group"
          >
            + New
          </button>
        </div>
        {creating && (
          <form
            className="fanout-new-group-form"
            onSubmit={handleSubmitNewGroup}
          >
            <input
              autoFocus
              type="text"
              placeholder="Group name…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") cancelNewGroup();
              }}
              data-testid="fanout-new-group-input"
            />
            <button type="submit" data-testid="fanout-new-group-save">
              Create
            </button>
            <button type="button" onClick={cancelNewGroup}>
              Cancel
            </button>
          </form>
        )}
        {loading && groups.length === 0 ? (
          <div className="fanout-groups-empty">Loading…</div>
        ) : groups.length === 0 ? (
          <div className="fanout-groups-empty">
            No groups yet. Create one to fan out commands across devices.
          </div>
        ) : (
          groups.map((g) => (
            <div
              key={g.id}
              className={`fanout-group-item ${
                selectedId === g.id ? "selected" : ""
              }`}
              onClick={() => setSelectedId(g.id)}
              data-testid={`fanout-group-${g.id}`}
            >
              <div className="fanout-group-name">{g.name}</div>
              <div className="fanout-group-meta">
                <span>{g.member_count} devices</span>
                {g.description && <span>· {g.description}</span>}
              </div>
            </div>
          ))
        )}
        {error && (
          <div className="fanout-groups-empty" style={{ color: "var(--text-primary)" }}>
            {error}
          </div>
        )}
      </div>

      <div className="fanout-group-detail">
        {!selected ? (
          <div className="fanout-groups-empty">
            Select a group to view its devices.
          </div>
        ) : (
          <>
            <div className="fanout-detail-header">
              <span className="fanout-detail-name">{selected.name}</span>
              <span className="fanout-group-meta">
                {members.length}/{FANOUT_CAP} devices
              </span>
              <div className="fanout-detail-actions">
                <button
                  onClick={() => setPickerOpen(true)}
                  data-testid="fanout-add-devices"
                >
                  Add Devices
                </button>
                <button
                  className="danger"
                  onClick={handleDelete}
                  data-testid="fanout-delete-group"
                >
                  Delete Group
                </button>
              </div>
            </div>

            {members.length >= FANOUT_CAP && (
              <div className="fanout-cap-banner">
                You have reached the {FANOUT_CAP}-device fan-out cap. Remove a
                device before adding more.
              </div>
            )}

            <div className="fanout-members-list">
              {members.length === 0 ? (
                <div className="fanout-groups-empty">
                  No devices yet. Click "Add Devices" or import a CSV.
                </div>
              ) : (
                members.map((m) => (
                  <div
                    key={`${m.device_kind}:${m.device_id}`}
                    className="fanout-member-row"
                    data-testid={`fanout-member-${m.device_kind}-${m.device_id}`}
                  >
                    <span className={`fanout-kind-badge ${m.device_kind}`}>
                      {m.device_kind.toUpperCase()}
                    </span>
                    <span>{m.display_name}</span>
                    <span style={{ color: "var(--text-secondary)" }}>{m.host}</span>
                    <button
                      className="fanout-member-remove"
                      onClick={() =>
                        removeMember(selected.id, m.device_id, m.device_kind)
                      }
                      title="Remove"
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      {pickerOpen && selected && (
        <DevicePickerDialog
          groupId={selected.id}
          alreadyMember={members.map(
            (m) => `${m.device_kind}:${m.device_id}`,
          )}
          remainingCapacity={FANOUT_CAP - members.length}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
