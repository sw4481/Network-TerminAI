import { memo, useCallback, useRef, Fragment } from 'react';
import { Pane } from './Pane';
import { PaneHandle } from './PaneHandle';
import { PaneNode, usePanesStore } from '../state/panesStore';
import './PaneContainer.css';

type PaneContainerProps = {
  node: PaneNode;
  shell: string;
  cwd: string;
  // Threaded down from the root call so leaves can show a close × only
  // when more than one leaf exists in the layout.
  canCloseLeaves?: boolean;
};

function countLeaves(node: PaneNode): number {
  if (node.type === 'leaf') return 1;
  return node.children.reduce((sum, child) => sum + countLeaves(child), 0);
}

export const PaneContainer = memo(function PaneContainer({
  node,
  shell,
  cwd,
  canCloseLeaves,
}: PaneContainerProps) {
  // First call (no flag yet) computes the leaf count for the whole subtree.
  // Recursive calls just forward the value.
  const effectiveCanClose =
    canCloseLeaves ?? countLeaves(node) > 1;
  // ALWAYS call hooks at the top level, before any conditional returns
  const containerRef = useRef<HTMLDivElement>(null);
  const resizePane = usePanesStore((s) => s.resizePane);

  // Define callback unconditionally (will only be used for splits)
  const handleResize = useCallback(
    (index: number, delta: number) => {
      if (!containerRef.current || node.type !== 'split') return;

      // Calculate delta as percentage of container size
      const containerSize =
        node.direction === 'horizontal'
          ? containerRef.current.offsetWidth
          : containerRef.current.offsetHeight;

      const deltaPercent = (delta / containerSize) * 100;

      // Update adjacent pane sizes
      const newSizes = node.children.map((child) => child.size);
      newSizes[index] = Math.max(20, Math.min(80, newSizes[index] + deltaPercent));
      newSizes[index + 1] = Math.max(
        20,
        Math.min(80, newSizes[index + 1] - deltaPercent)
      );

      // Normalize to sum to 100%
      const total = newSizes.reduce((sum, size) => sum + size, 0);
      const normalized = newSizes.map((size) => (size / total) * 100);

      // Call store to update
      resizePane(node.id, normalized);
    },
    [node, resizePane]
  );

  // Base case: render leaf node as Pane with Terminal
  if (node.type === 'leaf') {
    return (
      <Pane
        paneId={node.id}
        terminalId={node.terminalId}
        shell={shell}
        cwd={cwd}
        canClose={effectiveCanClose}
      />
    );
  }

  // Recursive case: render split with children and handles
  // TypeScript narrowing: node.type !== 'leaf' means it's a split
  const splitNode = node; // node is PaneSplit at this point

  return (
    <div
      ref={containerRef}
      className={`pane-container pane-container-${splitNode.direction}`}
    >
      {splitNode.children.map((child, index) => (
        <Fragment key={child.id}>
          {/* Render child pane/split */}
          <div
            className="pane-container-child"
            style={{ flex: `${child.size} 1 0%` }}
          >
            <PaneContainer
              node={child}
              shell={shell}
              cwd={cwd}
              canCloseLeaves={effectiveCanClose}
            />
          </div>

          {/* Render handle between children (except after last child) */}
          {index < splitNode.children.length - 1 && (
            <PaneHandle
              direction={splitNode.direction}
              onResize={(delta) => handleResize(index, delta)}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
});
