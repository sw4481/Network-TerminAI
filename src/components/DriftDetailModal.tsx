import { useIacStateStore } from "../state/iacStateStore";
import { buildImportCommand } from "../lib/iacState";
import type { DriftAnalysisEntry } from "../lib/iacState";
import "./DriftDetailModal.css";

export function DriftDetailModal() {
  const { drift, exceptions, addException } = useIacStateStore();
  if (!drift || !drift.hasDrift) return null;

  const analysisFor = (address: string): DriftAnalysisEntry | undefined =>
    drift.analysis.analyses.find((a) => a.resource === address);

  const visible = drift.drifted.filter((d) => !exceptions.includes(d.address));
  const suppressed = drift.drifted.filter((d) => exceptions.includes(d.address));

  return (
    <div className="iac-drift-modal" role="dialog" aria-label="Drift Analysis">
      <h3>Drift Analysis — {visible.length} resource(s) changed outside Terraform</h3>

      {drift.analysis.unavailable && (
        <p className="iac-drift-modal__unavailable">AI analysis unavailable.</p>
      )}

      {visible.map((d) => {
        const a = analysisFor(d.address);
        // The id needed for `terraform import` isn't in the drift event; the
        // engineer copies the command skeleton and fills the id from state.
        const importCmd = buildImportCommand(d.address, "<RESOURCE_ID>");
        return (
          <section key={d.address} className="iac-drift-modal__resource">
            <code>{d.address}</code>
            {a ? (
              <div className="iac-drift-modal__analysis">
                <p>{a.explanation}</p>
                <p><strong>Cause:</strong> {a.cause}</p>
                <p><strong>Impact:</strong> {a.impact}</p>
                <p><strong>Recommended:</strong> {a.recommendation}</p>
              </div>
            ) : (
              <p className="iac-drift-modal__nodetail">{d.detectedChanges}</p>
            )}
            <div className="iac-drift-modal__actions">
              <button onClick={() => navigator.clipboard.writeText(importCmd)}>
                Generate Import Command
              </button>
              <button onClick={() => addException(d.address)}>Mark as Exception</button>
            </div>
          </section>
        );
      })}

      {suppressed.length > 0 && (
        <details className="iac-drift-modal__suppressed">
          <summary>Suppressed ({suppressed.length})</summary>
          {suppressed.map((d) => <code key={d.address}>{d.address}</code>)}
        </details>
      )}
    </div>
  );
}
