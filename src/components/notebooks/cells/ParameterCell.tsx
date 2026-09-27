import type { ParameterSpec } from "../../../lib/runnableNotebook";

interface Props {
  params: ParameterSpec[];
  values: Record<string, string>;
}

export function ParameterCell({ params, values }: Props) {
  return (
    <div className="notebook-cell parameter-cell" data-testid="cell-parameter">
      <div className="cell-row-header">
        <span className="cell-type-tag">parameters</span>
      </div>
      <div className="parameter-grid">
        {params.map((p) => (
          <div key={p.name} className="parameter-row">
            <span className="parameter-name">{p.name}</span>
            <span className="parameter-value">
              {values[p.name] ?? p.default ?? <em>(not set)</em>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
