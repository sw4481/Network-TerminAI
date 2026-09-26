/**
 * Plan 15 Phase 4 — TreeCanvas (xyflow v12 host for the StepNode cards).
 *
 * Layout strategy: the engine writes steps into `troubleshoot_steps`
 * with a sequential `idx`; `parent_idx` is currently always NULL because
 * the Phase 2 engine doesn't track branch parents at the persistence
 * layer (the branch step itself owns the next step id). Phase 4 lays the
 * tree out as a vertical chain by `idx`, with branches that share a
 * parent_idx fanning horizontally. This is deterministic and
 * dependency-free — dagre/elk would be overkill at this size.
 *
 * The canvas is uncontrolled w.r.t. node positions: every render computes
 * positions fresh from the store. The store's idempotent `applyStepEvent`
 * means the layout is stable across re-renders (steps only ever GROW;
 * status flips don't change positions).
 */
import { ReactFlow, Background, Controls, type Edge, type Node } from "@xyflow/react";
import { useMemo } from "react";
import "@xyflow/react/dist/style.css";

import { selectActiveRun, selectOrderedSteps, useTroubleshootStore } from "./store";
import { StepNode, type StepNodeData } from "./StepNode";
import type { StoredStep } from "./api";
import "./TreeCanvas.css";

const NODE_TYPES = { step: StepNode };

const ROW_HEIGHT = 110;
const COL_WIDTH = 260;

function layoutPositions(
  steps: StoredStep[],
): Record<number, { x: number; y: number }> {
  const out: Record<number, { x: number; y: number }> = {};
  if (steps.length === 0) return out;

  // Bucket by parent_idx so we can spread siblings.
  const bucketsByParent = new Map<number | -1, StoredStep[]>();
  for (const s of steps) {
    const parent = s.parent_idx ?? -1;
    const arr = bucketsByParent.get(parent) ?? [];
    arr.push(s);
    bucketsByParent.set(parent, arr);
  }

  // For each idx (vertical row), figure out how many siblings are in
  // its parent bucket so we can compute an offset.
  for (const s of steps) {
    const parent = s.parent_idx ?? -1;
    const siblings = bucketsByParent.get(parent) ?? [s];
    const positionInBucket = siblings.findIndex((x) => x.idx === s.idx);
    const center = (siblings.length - 1) / 2;
    const x = (positionInBucket - center) * COL_WIDTH;
    const y = s.idx * ROW_HEIGHT;
    out[s.idx] = { x, y };
  }
  return out;
}

export interface TreeCanvasProps {
  /** When true, the canvas renders the empty-state copy. */
  empty?: boolean;
  /** Optional override — useful for tests. Defaults to the store's active run. */
  steps?: StoredStep[];
}

export function TreeCanvas({ empty: emptyOverride, steps: stepsOverride }: TreeCanvasProps) {
  const activeRun = useTroubleshootStore(selectActiveRun);
  const steps = stepsOverride ?? selectOrderedSteps(activeRun);
  const empty = emptyOverride ?? steps.length === 0;

  const positions = useMemo(() => layoutPositions(steps), [steps]);

  const rfNodes: Node[] = useMemo(() => {
    return steps.map((s) => ({
      id: String(s.idx),
      type: "step",
      position: positions[s.idx] ?? { x: 0, y: 0 },
      data: { step: s } as StepNodeData,
      draggable: false,
      selectable: true,
    }));
  }, [steps, positions]);

  const rfEdges: Edge[] = useMemo(() => {
    const edges: Edge[] = [];
    // Connect each step to the previous idx — this is a faithful "what
    // ran next" view of the engine's actual execution order.
    for (let i = 1; i < steps.length; i++) {
      const a = steps[i - 1];
      const b = steps[i];
      edges.push({
        id: `e-${a.idx}-${b.idx}`,
        source: String(a.idx),
        target: String(b.idx),
        type: "default",
        animated: b.status === "running",
      });
    }
    return edges;
  }, [steps]);

  if (empty) {
    return (
      <div className="tb-canvas" data-testid="tb-canvas">
        <div className="tb-canvas-empty" data-testid="tb-canvas-empty">
          No active run.
          <br />
          Select a playbook on the left and press <code>Start run</code>.
        </div>
      </div>
    );
  }

  return (
    <div className="tb-canvas" data-testid="tb-canvas">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={NODE_TYPES}
        fitView
        // Cap the zoom so a single-node run doesn't blow the card up to
        // fill (and overflow) the pane — fitView would otherwise scale a
        // lone 220px node way past 100%. Keep it at natural size or
        // smaller.
        fitViewOptions={{ maxZoom: 1, minZoom: 0.2, padding: 0.2 }}
        minZoom={0.2}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        aria-label="Troubleshoot tree"
      >
        <Controls showInteractive={false} />
        <Background />
      </ReactFlow>
    </div>
  );
}
