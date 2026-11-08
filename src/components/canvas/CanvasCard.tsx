import { useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { Controls, ReactFlow, useReactFlow, useStore } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { JsonValue, ResolvedCanvasCard } from "../../lib/copilotCanvas";
import { CanvasChart } from "./CanvasChart";

const valueText = (value: JsonValue) => typeof value === "string" ? value : JSON.stringify(value, null, 2);

function FitGraphToContainer() {
  const width = useStore(state => state.width);
  const height = useStore(state => state.height);
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (width > 0 && height > 0) void fitView();
  }, [width, height, fitView]);
  return null;
}

export function CanvasCard({ card }: { card: ResolvedCanvasCard }) {
  switch (card.type) {
    case "text":
      return typeof card.metadata.body === "string"
        ? <ReactMarkdown skipHtml disallowedElements={["img"]}>{card.metadata.body}</ReactMarkdown>
        : <pre>{valueText(card.metadata.body)}</pre>;
    case "key_value":
      return <dl className="canvas-facts">{card.metadata.fields.map((field, index) => <div key={index}><dt>{field.label}</dt><dd>{valueText(field.value)}</dd></div>)}</dl>;
    case "table":
      return <div className="canvas-overflow" role="region" aria-label={`${card.title} source table`} tabIndex={0}><table><thead><tr><th scope="col">Row</th>{card.metadata.columns.map(column => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead><tbody>{card.metadata.rows.map((row, index) => <tr key={index}><th scope="row">Row {index + 1}</th>{card.metadata.columns.map(column => <td key={column.key}><pre>{valueText(row.cells[column.key])}</pre></td>)}</tr>)}</tbody></table></div>;
    case "chart":
      return <><CanvasChart card={card} /><div className="canvas-overflow" role="region" aria-label={`${card.title} source values`} tabIndex={0}><table><thead><tr><th scope="col">{card.metadata.x_label}</th><th scope="col">{card.metadata.y_label}</th></tr></thead><tbody>{card.metadata.points.map((point, index) => <tr key={index}><th scope="row">{point.label}</th><td>{point.value}</td></tr>)}</tbody></table></div></>;
    case "topology": {
      const columns = Math.ceil(Math.sqrt(card.metadata.nodes.length));
      const ids = new Map(card.metadata.nodes.map((node, index) => [JSON.stringify(node.id), `node-${index}`]));
      const nodes = card.metadata.nodes.map((node, index) => ({
        id: ids.get(JSON.stringify(node.id))!,
        data: { label: <span title={JSON.stringify(node.id)}>{JSON.stringify(node.id)}</span> },
        position: { x: (index % columns) * 230, y: Math.floor(index / columns) * 140 },
        ariaLabel: JSON.stringify(node.id),
      }));
      const edges = card.metadata.links.map((link, index) => ({
        id: `edge-${index}`, source: ids.get(JSON.stringify(link.from))!, target: ids.get(JSON.stringify(link.to))!,
        ariaLabel: `${JSON.stringify(link.from)} to ${JSON.stringify(link.to)}`,
      }));
      return <><p role="note">Supplied relationships only. Layout is illustrative, not physical topology. No discovery was run.</p>
        <div className="canvas-relationship-graph" role="region" aria-label={`${card.title} relationship graph`}>
          <ReactFlow nodes={nodes} edges={edges} fitView minZoom={0} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} preventScrolling={false} proOptions={{ hideAttribution: true }}>
            <FitGraphToContainer />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <div className="canvas-overflow" role="region" aria-label={card.agent_authored ? "Agent-authored relationships" : "Observed relationships"} tabIndex={0}><table><thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Relationship source</th></tr></thead><tbody>{card.metadata.links.map((link, index) => <tr key={index}><th scope="row">{JSON.stringify(link.from)}</th><td>{JSON.stringify(link.to)}</td><td>{link.relationship.evidence_id}{link.relationship.path}</td></tr>)}</tbody></table></div><p>Supplied endpoints: {card.metadata.nodes.map(node => JSON.stringify(node.id)).join(", ")}</p></>;
    }
    case "assessment":
      return <><p className="canvas-muted">Agent interpretation — not an observation</p><ReactMarkdown skipHtml disallowedElements={["img"]}>{card.metadata.narrative}</ReactMarkdown><h3>Unknowns</h3><ul>{card.metadata.unknowns.map((text, i) => <li key={i}>{text}</li>)}</ul><h3>Recommendation — not executed</h3><ul>{card.metadata.remediation_considerations.map((text, i) => <li key={i}>{text}</li>)}</ul></>;
    case "findings":
      return <p>{card.metadata.findings.length} interpreted findings — inspect the grouped findings for source evidence.</p>;
  }
}
