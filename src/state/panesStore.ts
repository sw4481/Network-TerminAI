import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export type PaneDirection = 'horizontal' | 'vertical';

/**
 * Decide whether a pane should adopt the backend-spawned PTY id reported by
 * its Terminal's `onRegistered` callback.
 *
 * PTYs are keyed in the backend by the id `pty_spawn` returns. A pane must
 * hold that id (not the frontend tab id) so features that resolve a PTY by
 * pane — recording, pane-close kill — target the real session. We reconcile
 * whenever the registered id differs from what the pane currently holds:
 *   - root panes start as `terminalId = tabId` (≠ spawned id),
 *   - freshly split panes start as `pending-<uuid>`,
 *   - reloaded panes hold a stale (dead) persisted id.
 * All three must update. A no-op (already equal) or an empty registered id is
 * ignored.
 */
export function shouldReconcileTerminalId(
  current: string,
  registered: string,
): boolean {
  if (!registered) return false;
  return current !== registered;
}

export type PaneLeaf = {
  type: 'leaf';
  id: string;
  terminalId: string; // Maps to a tab_id with its own PTY
  size: number; // Percentage (0-100)
};

export type PaneSplit = {
  type: 'split';
  id: string;
  direction: PaneDirection;
  children: PaneNode[];
  size: number; // Percentage (0-100) - used when this split is a child of another split
};

export type PaneNode = PaneLeaf | PaneSplit;

interface PanesState {
  // Map of tabId -> PaneNode (layout tree)
  layoutsByTab: Map<string, PaneNode>;

  // Currently focused pane ID
  focusedPaneId: string | null;

  // Actions
  initializeLayout: (tabId: string) => PaneNode;
  splitPane: (paneId: string, direction: PaneDirection, newTerminalId: string) => PaneNode;
  closePane: (paneId: string) => PaneNode | null;
  resizePane: (splitId: string, sizes: number[]) => PaneNode;
  setFocusedPane: (paneId: string) => void;
  navigateFocus: (direction: 'up' | 'down' | 'left' | 'right') => void;
  updatePaneTerminalId: (paneId: string, newTerminalId: string) => void;
  /**
   * Resolve the backend PTY/terminal id to record for `tabId`. PTYs are keyed
   * by their per-pane spawn id, NOT the frontend tab id, so recording must
   * target the focused pane's `terminalId`. Falls back to the layout's first
   * leaf, then to `tabId` itself (single-pane tabs where the two are equal).
   */
  resolveRecordingTerminalId: (tabId: string) => string;

  // Persistence
  loadLayoutForTab: (tabId: string) => Promise<void>;
  saveLayout: (tabId: string, layout: PaneNode) => Promise<void>;
}

// Helper: Generate unique pane ID
function generatePaneId(): string {
  return `pane-${crypto.randomUUID()}`;
}

// Helper: Find pane node by ID in tree
function findPaneById(node: PaneNode, paneId: string): PaneNode | null {
  if (node.id === paneId) return node;

  if (node.type === 'split') {
    for (const child of node.children) {
      const found = findPaneById(child, paneId);
      if (found) return found;
    }
  }

  return null;
}

// Helper: leftmost leaf of a layout tree (deterministic first pane).
function firstLeaf(node: PaneNode): PaneLeaf | null {
  if (node.type === 'leaf') return node;
  for (const child of node.children) {
    const leaf = firstLeaf(child);
    if (leaf) return leaf;
  }
  return null;
}

// Helper: Replace pane node in tree
function replacePaneInTree(
  node: PaneNode,
  targetId: string,
  replacement: PaneNode
): PaneNode {
  if (node.id === targetId) return replacement;

  if (node.type === 'split') {
    return {
      ...node,
      children: node.children.map(child =>
        replacePaneInTree(child, targetId, replacement)
      ),
    };
  }

  return node;
}

// Helper: Remove pane from tree and rebalance
function removePaneFromTree(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === 'leaf') {
    return node.id === paneId ? null : node;
  }

  // It's a split - check if target is one of the children
  const newChildren = node.children
    .map(child => removePaneFromTree(child, paneId))
    .filter((child): child is PaneNode => child !== null);

  // If only one child remains, collapse the split
  if (newChildren.length === 1) {
    return newChildren[0];
  }

  // If no children remain, this split disappears
  if (newChildren.length === 0) {
    return null;
  }

  // Rebalance sizes to sum to 100
  const totalSize = newChildren.reduce((sum, child) => sum + child.size, 0);
  const balanced = newChildren.map(child => ({
    ...child,
    size: (child.size / totalSize) * 100,
  }));

  return {
    ...node,
    children: balanced,
  };
}

// Helper: Get all leaf panes in layout order
export function getAllLeafPanes(node: PaneNode): PaneLeaf[] {
  if (node.type === 'leaf') return [node];
  return node.children.flatMap(getAllLeafPanes);
}

export const usePanesStore = create<PanesState>((set, get) => ({
  layoutsByTab: new Map(),
  focusedPaneId: null,

  initializeLayout: (tabId: string) => {
    console.log('[panesStore] initializeLayout called for tabId:', tabId);
    const rootPane: PaneLeaf = {
      type: 'leaf',
      id: generatePaneId(),
      terminalId: tabId,
      size: 100,
    };

    set(state => {
      const newMap = new Map(state.layoutsByTab);
      newMap.set(tabId, rootPane);
      console.log('[panesStore] Setting focusedPaneId to:', rootPane.id);
      return {
        layoutsByTab: newMap,
        focusedPaneId: rootPane.id,
      };
    });

    return rootPane;
  },

  splitPane: (paneId: string, direction: PaneDirection, newTerminalId: string) => {
    const state = get();
    let newLayout: PaneNode | null = null;

    // Find which tab contains this pane
    for (const [tabId, layout] of state.layoutsByTab.entries()) {
      const targetPane = findPaneById(layout, paneId);

      if (targetPane && targetPane.type === 'leaf') {
        // Create two new panes
        const pane1: PaneLeaf = {
          type: 'leaf',
          id: generatePaneId(),
          terminalId: targetPane.terminalId,
          size: 50,
        };

        const pane2: PaneLeaf = {
          type: 'leaf',
          id: generatePaneId(),
          terminalId: newTerminalId, // Real PTY session ID
          size: 50,
        };

        const split: PaneSplit = {
          type: 'split',
          id: generatePaneId(),
          direction,
          children: [pane1, pane2],
          size: targetPane.size, // Inherit size from the pane being split
        };

        newLayout = replacePaneInTree(layout, paneId, split);

        set(state => {
          const newMap = new Map(state.layoutsByTab);
          newMap.set(tabId, newLayout!);
          return {
            layoutsByTab: newMap,
            focusedPaneId: pane2.id, // Focus new pane
          };
        });

        // Persist to DB
        get().saveLayout(tabId, newLayout);

        break;
      }
    }

    return newLayout!;
  },

  closePane: (paneId: string) => {
    const state = get();
    let newLayout: PaneNode | null = null;

    for (const [tabId, layout] of state.layoutsByTab.entries()) {
      const targetPane = findPaneById(layout, paneId);

      if (targetPane) {
        newLayout = removePaneFromTree(layout, paneId);

        if (newLayout) {
          set(state => {
            const newMap = new Map(state.layoutsByTab);
            newMap.set(tabId, newLayout!);

            // If closed pane was focused, focus first remaining pane
            let newFocusedId = state.focusedPaneId;
            if (newFocusedId === paneId) {
              const leaves = getAllLeafPanes(newLayout!);
              newFocusedId = leaves[0]?.id || null;
            }

            return {
              layoutsByTab: newMap,
              focusedPaneId: newFocusedId,
            };
          });

          // Persist to DB
          get().saveLayout(tabId, newLayout);
        } else {
          // Last pane closed - remove layout
          set(state => {
            const newMap = new Map(state.layoutsByTab);
            newMap.delete(tabId);
            return {
              layoutsByTab: newMap,
              focusedPaneId: null,
            };
          });

          // Delete from DB
          invoke('panes_delete_layout', { tabId }).catch(console.error);
        }

        break;
      }
    }

    return newLayout;
  },

  resizePane: (splitId: string, sizes: number[]) => {
    const state = get();
    let newLayout: PaneNode | null = null;

    for (const [tabId, layout] of state.layoutsByTab.entries()) {
      const targetSplit = findPaneById(layout, splitId);

      if (targetSplit && targetSplit.type === 'split') {
        const updatedSplit: PaneSplit = {
          ...targetSplit,
          children: targetSplit.children.map((child, index) => ({
            ...child,
            size: sizes[index] || child.size,
          })),
        };

        newLayout = replacePaneInTree(layout, splitId, updatedSplit);

        set(state => {
          const newMap = new Map(state.layoutsByTab);
          newMap.set(tabId, newLayout!);
          return { layoutsByTab: newMap };
        });

        // Persist to DB
        get().saveLayout(tabId, newLayout);

        break;
      }
    }

    return newLayout!;
  },

  setFocusedPane: (paneId: string) => {
    set({ focusedPaneId: paneId });
  },

  resolveRecordingTerminalId: (tabId: string) => {
    const state = get();
    const layout = state.layoutsByTab.get(tabId);
    if (!layout) return tabId; // no layout tracked → tab id is the PTY key

    // Prefer the focused pane if it belongs to this tab's layout.
    if (state.focusedPaneId) {
      const focused = findPaneById(layout, state.focusedPaneId);
      if (focused && focused.type === 'leaf') return focused.terminalId;
    }
    // Otherwise the layout's first leaf.
    const leaf = firstLeaf(layout);
    return leaf ? leaf.terminalId : tabId;
  },

  navigateFocus: (direction: 'up' | 'down' | 'left' | 'right') => {
    const state = get();
    if (!state.focusedPaneId) return;

    // Find current focused pane and navigate in direction
    // This is a simplified version - full implementation would need
    // spatial awareness of pane positions
    for (const layout of state.layoutsByTab.values()) {
      const leaves = getAllLeafPanes(layout);
      const currentIndex = leaves.findIndex(p => p.id === state.focusedPaneId);

      if (currentIndex !== -1) {
        let newIndex = currentIndex;

        if (direction === 'right' || direction === 'down') {
          newIndex = (currentIndex + 1) % leaves.length;
        } else if (direction === 'left' || direction === 'up') {
          newIndex = (currentIndex - 1 + leaves.length) % leaves.length;
        }

        set({ focusedPaneId: leaves[newIndex].id });
        break;
      }
    }
  },

  loadLayoutForTab: async (tabId: string) => {
    console.log('[panesStore] loadLayoutForTab called for tabId:', tabId);
    try {
      const layoutJson = await invoke<string | null>('panes_get_layout', { tabId });
      console.log('[panesStore] Loaded layout from DB:', layoutJson);

      if (!layoutJson) {
        // No saved layout - initialize default
        console.log('[panesStore] No saved layout (null), initializing default for tabId:', tabId);
        get().initializeLayout(tabId);
        return;
      }

      const layout: PaneNode = JSON.parse(layoutJson);

      set(state => {
        const newMap = new Map(state.layoutsByTab);
        newMap.set(tabId, layout);

        // Focus first pane
        const leaves = getAllLeafPanes(layout);

        return {
          layoutsByTab: newMap,
          focusedPaneId: leaves[0]?.id || null,
        };
      });
    } catch (error) {
      // No saved layout - initialize default
      console.log('[panesStore] Error loading layout, initializing default for tabId:', tabId, 'Error:', error);
      get().initializeLayout(tabId);
    }
  },

  saveLayout: async (tabId: string, layout: PaneNode) => {
    try {
      const layoutJson = JSON.stringify(layout);
      await invoke('panes_save_layout', { tabId, layoutJson });
    } catch (error) {
      console.error('Failed to save pane layout:', error);
    }
  },

  updatePaneTerminalId: (paneId: string, newTerminalId: string) => {
    console.log('[panesStore] updatePaneTerminalId - paneId:', paneId, 'newTerminalId:', newTerminalId);
    const state = get();

    for (const [tabId, layout] of state.layoutsByTab.entries()) {
      const targetPane = findPaneById(layout, paneId);

      if (targetPane && targetPane.type === 'leaf') {
        // Update the terminal ID in the tree
        const updateTerminalIdInTree = (node: PaneNode): PaneNode => {
          if (node.type === 'leaf' && node.id === paneId) {
            return { ...node, terminalId: newTerminalId };
          }
          if (node.type === 'split') {
            return {
              ...node,
              children: node.children.map(updateTerminalIdInTree),
            };
          }
          return node;
        };

        const newLayout = updateTerminalIdInTree(layout);

        set(state => {
          const newMap = new Map(state.layoutsByTab);
          newMap.set(tabId, newLayout);
          return { layoutsByTab: newMap };
        });

        // Persist to DB
        get().saveLayout(tabId, newLayout);
        break;
      }
    }
  },
}));
