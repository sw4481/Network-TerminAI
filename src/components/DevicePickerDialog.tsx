import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { sshListConnections } from "../lib/sshConnections";
import type { DeviceKind } from "../lib/fanout";
import { useFanoutStore } from "../state/fanoutStore";
import "./DevicePickerDialog.css";

interface NetconfDev {
  id: number;
  name: string;
  host: string;
}

type Row = {
  key: string;
  deviceId: string;
  deviceKind: DeviceKind;
  name: string;
  host: string;
};

interface Props {
  groupId: string;
  alreadyMember: string[]; // ["ssh:abc...", "netconf:42"]
  remainingCapacity: number;
  onClose: () => void;
}

export function DevicePickerDialog({
  groupId,
  alreadyMember,
  remainingCapacity,
  onClose,
}: Props) {
  const { addMembersBulk, importCsv } = useFanoutStore();
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | DeviceKind>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [csvText, setCsvText] = useState("");
  const [csvWarnings, setCsvWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [ssh, nc] = await Promise.all([
          sshListConnections(),
          invoke<NetconfDev[]>("netconf_device_list"),
        ]);
        const built: Row[] = [
          ...ssh.map((s) => ({
            key: `ssh:${s.id}`,
            deviceId: s.id,
            deviceKind: "ssh" as const,
            name: s.name,
            host: s.host,
          })),
          ...nc.map((n) => ({
            key: `netconf:${n.id}`,
            deviceId: String(n.id),
            deviceKind: "netconf" as const,
            name: n.name,
            host: n.host,
          })),
        ];
        built.sort((a, b) => a.name.localeCompare(b.name));
        setRows(built);
      } catch (e) {
        console.error("device picker load failed", e);
      }
    })();
  }, []);

  const memberSet = useMemo(() => new Set(alreadyMember), [alreadyMember]);

  const filtered = rows.filter((r) => {
    if (kindFilter !== "all" && r.deviceKind !== kindFilter) return false;
    if (!filter) return true;
    const f = filter.toLowerCase();
    return r.name.toLowerCase().includes(f) || r.host.toLowerCase().includes(f);
  });

  const toggle = (row: Row) => {
    if (memberSet.has(row.key)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      return next;
    });
  };

  const handleSelectAllFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of filtered) {
        if (!memberSet.has(r.key)) next.add(r.key);
      }
      return next;
    });
  };

  const overCap = selected.size > remainingCapacity;

  const handleAdd = async () => {
    if (overCap) return;
    setBusy(true);
    try {
      const members = filtered
        .filter((r) => selected.has(r.key))
        .map((r) => ({ deviceId: r.deviceId, kind: r.deviceKind }));
      // Selection may include rows from before filter changed:
      const all = rows
        .filter((r) => selected.has(r.key))
        .map((r) => ({ deviceId: r.deviceId, kind: r.deviceKind }));
      await addMembersBulk(groupId, all.length ? all : members);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const handleCsvImport = async () => {
    setBusy(true);
    try {
      const result = await importCsv(groupId, csvText);
      setCsvWarnings(result.warnings);
      if (result.warnings.length === 0) {
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="device-picker-overlay" onClick={onClose}>
      <div
        className="device-picker-dialog"
        onClick={(e) => e.stopPropagation()}
        data-testid="device-picker-dialog"
      >
        <div className="device-picker-header">
          <h3>Add Devices</h3>
          <button className="device-picker-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="device-picker-toolbar">
          <input
            type="text"
            placeholder="Filter by name or host…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            data-testid="device-picker-filter"
          />
          <select
            value={kindFilter}
            onChange={(e) =>
              setKindFilter(e.target.value as "all" | DeviceKind)
            }
            data-testid="device-picker-kind"
          >
            <option value="all">All kinds</option>
            <option value="ssh">SSH</option>
            <option value="netconf">NETCONF</option>
          </select>
          <button
            onClick={handleSelectAllFiltered}
            data-testid="device-picker-select-all"
          >
            Select all filtered
          </button>
        </div>

        {overCap && (
          <div className="device-picker-warn">
            You selected {selected.size} devices but the group has only{" "}
            {remainingCapacity} remaining slots ({50}-device cap).
          </div>
        )}

        <div className="device-picker-list">
          {filtered.length === 0 ? (
            <div className="device-picker-status" style={{ padding: 14 }}>
              No saved devices match. Save SSH/NETCONF devices first, or use
              CSV import below.
            </div>
          ) : (
            filtered.map((row) => {
              const isMember = memberSet.has(row.key);
              return (
                <div
                  key={row.key}
                  className={`device-picker-row ${isMember ? "is-member" : ""}`}
                  onClick={() => toggle(row)}
                  data-testid={`device-picker-row-${row.key}`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(row.key) || isMember}
                    disabled={isMember}
                    readOnly
                  />
                  <span className={`fanout-kind-badge ${row.deviceKind}`}>
                    {row.deviceKind.toUpperCase()}
                  </span>
                  <span>{row.name}</span>
                  <span style={{ color: "var(--text-secondary)" }}>{row.host}</span>
                </div>
              );
            })
          )}
        </div>

        <div className="csv-import-area">
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
            Or paste CSV:
            <code style={{ marginLeft: 6 }}>device_kind,identifier</code>
          </span>
          <textarea
            placeholder="device_kind,identifier&#10;ssh,r1-atl&#10;netconf,xe1"
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            data-testid="device-picker-csv"
          />
          <div className="row">
            <button
              onClick={handleCsvImport}
              disabled={!csvText.trim() || busy}
              data-testid="device-picker-csv-import"
            >
              Import CSV
            </button>
            {csvWarnings.length > 0 && (
              <div className="csv-warnings">
                {csvWarnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="device-picker-footer">
          <span className="device-picker-status">
            {selected.size} selected · {remainingCapacity} slots remaining
          </span>
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={handleAdd}
            disabled={selected.size === 0 || overCap || busy}
            data-testid="device-picker-add"
          >
            Add {selected.size > 0 ? `(${selected.size})` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
