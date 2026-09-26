import { useEffect, useState } from "react";
import { driftExceptionsList, driftExceptionDelete, type DriftException } from "../lib/drift";

interface Props { templateId: string; onClose: () => void; }

export function DriftExceptionsModal({ templateId, onClose }: Props) {
  const [rows, setRows] = useState<DriftException[]>([]);
  const load = async () => setRows(await driftExceptionsList(templateId));
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [templateId]);
  return (
    <div className="ssh-modal-overlay" onClick={onClose}>
      <div className="ssh-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ssh-modal-header">
          <h2>Acknowledged drift ({rows.length})</h2>
          <button className="ssh-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="ssh-modal-content">
          {rows.length === 0 && <p>No acknowledged deltas.</p>}
          <ul className="exception-list">
            {rows.map((r) => (
              <li key={r.id}>
                <code>{r.line}</code>
                {r.note && <em> — {r.note}</em>}
                <button onClick={async () => {
                  try {
                    await driftExceptionDelete(r.id);
                    await load();
                  } catch (e) {
                    alert(`Failed to remove exception: ${e}`);
                  }
                }}>
                  Un-acknowledge
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
