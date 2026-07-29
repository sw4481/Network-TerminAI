import { useEffect, useState } from "react";
import {
  configSnapshotsList,
  configSnapshotsDiff,
  configSnapshotSetLabel,
  type ConfigSnapshot,
  type DriftPatch,
} from "../lib/drift";

interface Props {
  deviceId: string;
  deviceKind: string;
  onClose: () => void;
}

export function ConfigArchiveModal({ deviceId, deviceKind, onClose }: Props) {
  const [snaps, setSnaps] = useState<ConfigSnapshot[]>([]);
  const [aId, setAId] = useState<string | null>(null);
  const [bId, setBId] = useState<string | null>(null);
  const [patch, setPatch] = useState<DriftPatch | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setSnaps(await configSnapshotsList(deviceId, deviceKind, 15));
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, deviceKind]);

  const doDiff = async (a: string, b: string) => {
    try {
      setPatch(await configSnapshotsDiff(a, b));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const diffLatestVsPrev = () => {
    if (snaps.length >= 2) {
      setAId(snaps[1].id);
      setBId(snaps[0].id);
      void doDiff(snaps[1].id, snaps[0].id);
    }
  };

  return (
    <div className="ssh-modal-overlay" onClick={onClose}>
      <div className="ssh-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ssh-modal-header">
          <h2>Config Archive — {deviceId}</h2>
          <button className="ssh-modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="ssh-modal-content">
          {error && <div className="ssh-modal-error">{error}</div>}
          <button onClick={diffLatestVsPrev} disabled={snaps.length < 2}>
            Diff latest vs previous
          </button>
          <ul className="archive-list">
            {snaps.map((s) => (
              <li key={s.id}>
                <input
                  type="radio"
                  name="a"
                  checked={aId === s.id}
                  onChange={() => setAId(s.id)}
                />
                <input
                  type="radio"
                  name="b"
                  checked={bId === s.id}
                  onChange={() => setBId(s.id)}
                />
                <span>{new Date(s.captured_at * 1000).toLocaleString()}</span>
                <span>{s.source}</span>
                <input
                  type="text"
                  placeholder="label"
                  defaultValue={s.label ?? ""}
                  onBlur={async (e) => {
                    await configSnapshotSetLabel(s.id, e.target.value || null);
                    void load();
                  }}
                />
              </li>
            ))}
          </ul>
          <button
            disabled={!aId || !bId}
            onClick={() => aId && bId && doDiff(aId, bId)}
          >
            Diff selected
          </button>
          {patch && (
            <pre className="archive-diff">
              {patch.blocks
                .flatMap((b) =>
                  b.changes.map(
                    (c) =>
                      `${c.tag === "insert" ? "+" : c.tag === "delete" ? "-" : " "} ${c.line}`,
                  ),
                )
                .join("\n")}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
