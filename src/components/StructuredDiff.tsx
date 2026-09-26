import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  listSnapshots,
  type ParsedSnapshot,
} from "../lib/structured";
import { diffSnapshots, type CellDiff, type DiffStatus } from "../lib/diff";
import "./StructuredDiff.css";

interface Props {
  blockId: string;
  tabId: string;
  command: string;
}

const STATUS_LABEL: Record<DiffStatus, string> = {
  added: "+",
  removed: "−",
  changed: "~",
  unchanged: "",
};

export function StructuredDiff({ blockId: _blockId, tabId, command }: Props) {
  const [snapshots, setSnapshots] = useState<ParsedSnapshot[]>([]);
  const [a, setA] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);
  const [diff, setDiff] = useState<CellDiff[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listSnapshots(tabId)
      .then((all) => {
        const filtered = all.filter((s) => s.command === command);
        setSnapshots(filtered);
        if (filtered.length >= 2) {
          setA(filtered[1].id); // older
          setB(filtered[0].id); // newer
        }
      })
      .catch((e) => setError(String(e)));
  }, [tabId, command]);

  useEffect(() => {
    if (a == null || b == null) {
      setDiff(null);
      return;
    }
    setLoading(true);
    setError(null);
    diffSnapshots(a, b)
      .then((d) => {
        setDiff(d);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, [a, b]);

  // Group by row_key.
  const grouped = useMemo(() => {
    if (!diff) return [];
    const map = new Map<string, CellDiff[]>();
    for (const c of diff) {
      if (!map.has(c.row_key)) map.set(c.row_key, []);
      map.get(c.row_key)!.push(c);
    }
    return Array.from(map.entries());
  }, [diff]);

  const columns = useMemo(() => {
    if (!diff) return [] as string[];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of diff) {
      if (!seen.has(c.column)) {
        seen.add(c.column);
        out.push(c.column);
      }
    }
    return out;
  }, [diff]);

  if (snapshots.length < 2) {
    return (
      <div className="structured-diff" data-testid="structured-diff">
        <div className="structured-empty">
          <div className="structured-empty-title">Need two snapshots</div>
          <div className="structured-empty-sub">
            Pin at least two snapshots of <code>{command}</code> on this tab to
            view a diff. Use the “Pin Snapshot” button on the Structured tab.
          </div>
        </div>
      </div>
    );
  }

  // Re-export invoke to keep the import-graph honest in tests; not strictly used.
  void invoke;

  return (
    <div className="structured-diff" data-testid="structured-diff">
      <div className="structured-diff-toolbar">
        <label>
          A:&nbsp;
          <select
            value={a ?? ""}
            onChange={(e) => setA(Number(e.target.value))}
            data-testid="structured-diff-a"
          >
            {snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({new Date(s.capturedAt * 1000).toLocaleString()})
              </option>
            ))}
          </select>
        </label>
        <label>
          B:&nbsp;
          <select
            value={b ?? ""}
            onChange={(e) => setB(Number(e.target.value))}
            data-testid="structured-diff-b"
          >
            {snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({new Date(s.capturedAt * 1000).toLocaleString()})
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading && <div className="structured-empty">Computing diff…</div>}
      {error && <div className="structured-empty error">{error}</div>}

      {diff && diff.length > 0 && diff.every((c) => c.status === "unchanged") && (
        <div className="structured-empty">No changes between A and B.</div>
      )}

      {diff && diff.some((c) => c.status !== "unchanged") && (
        <div className="structured-table-wrap">
          <table className="structured-table" data-testid="structured-diff-table">
            <thead>
              <tr>
                <th>row</th>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grouped.map(([rowKey, cells]) => (
                <tr key={rowKey}>
                  <th scope="row">{rowKey}</th>
                  {columns.map((col) => {
                    const cell = cells.find((c) => c.column === col);
                    if (!cell) return <td key={col}></td>;
                    return (
                      <td key={col} className={`diff-${cell.status}`}>
                        <span className="diff-marker">
                          {STATUS_LABEL[cell.status]}
                        </span>
                        {cell.status === "changed" ? (
                          <>
                            <span className="diff-old">{format(cell.a)}</span>
                            <span className="diff-arrow">→</span>
                            <span className="diff-new">{format(cell.b)}</span>
                          </>
                        ) : cell.status === "removed" ? (
                          <span className="diff-old">{format(cell.a)}</span>
                        ) : cell.status === "added" ? (
                          <span className="diff-new">{format(cell.b)}</span>
                        ) : (
                          <span>{format(cell.a)}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function format(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
