export type EditorPaneDirection = "horizontal" | "vertical";

export type EditorPaneViewState = {
  cursor_position: { line: number; column: number };
  scroll_position: number;
};

export type EditorPaneLeaf = EditorPaneViewState & {
  type: "leaf";
  id: string;
  size: number;
  bufferId: string;
  detachedWindowId: string | null;
};

export type EditorSplitNode = {
  type: "split";
  id: string;
  size: number;
  direction: EditorPaneDirection;
  children: EditorPaneNode[];
};

export type EditorPaneNode = EditorPaneLeaf | EditorSplitNode;

export type EditorBufferIdentity =
  | { kind: "file"; path: string }
  | { kind: "untitled"; id: string };

export type HydratedEditorLayout = {
  layout: EditorPaneNode;
  focusedPaneId: string;
  bufferIdentities: Record<string, EditorBufferIdentity>;
};

type PersistedEditorPane =
  | {
      type: "leaf";
      id: string;
      size: number;
      buffer: EditorBufferIdentity;
      detachedWindowId: string | null;
    }
  | {
      type: "split";
      id: string;
      size: number;
      direction: EditorPaneDirection;
      children: PersistedEditorPane[];
    };

type PersistedEditorLayout = {
  version: 1;
  focusedPaneId: string;
  root: PersistedEditorPane;
};

const DEFAULT_CURSOR = { line: 1, column: 1 };

function positiveSize(value: unknown, fallback = 100): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function normalizeChildren(children: EditorPaneNode[]): EditorPaneNode[] {
  const total = children.reduce(
    (sum, child) => sum + positiveSize(child.size, 1),
    0,
  );
  return children.map((child) => ({
    ...child,
    size: (positiveSize(child.size, 1) / total) * 100,
  }));
}

function withSize(node: EditorPaneNode, size: number): EditorPaneNode {
  return { ...node, size };
}

export function normalizeEditorFilePath(filePath: string): string {
  const slashPath = filePath.trim().replace(/\\/g, "/");
  const isAbsolute = slashPath.startsWith("/");
  const drive = slashPath.match(/^[A-Za-z]:/)?.[0] ?? "";
  const afterDrive = drive ? slashPath.slice(drive.length) : slashPath;
  const parts: string[] = [];

  for (const part of afterDrive.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!isAbsolute && !drive) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }

  const prefix = drive ? `${drive}/` : isAbsolute ? "/" : "";
  const normalized = `${prefix}${parts.join("/")}`;
  return normalized || (isAbsolute ? "/" : ".");
}

export function editorBufferIdForFile(filePath: string): string {
  return `file:${normalizeEditorFilePath(filePath)}`;
}

export function createEditorPaneLayout(
  bufferId: string,
  paneId: string,
): EditorPaneLeaf {
  return {
    type: "leaf",
    id: paneId,
    size: 100,
    bufferId,
    detachedWindowId: null,
    cursor_position: { ...DEFAULT_CURSOR },
    scroll_position: 0,
  };
}

export function getEditorPaneLeaves(node: EditorPaneNode): EditorPaneLeaf[] {
  if (node.type === "leaf") return [node];
  return node.children.flatMap(getEditorPaneLeaves);
}

export function getAttachedEditorPanes(
  node: EditorPaneNode,
): EditorPaneLeaf[] {
  return getEditorPaneLeaves(node).filter(
    (pane) => pane.detachedWindowId === null,
  );
}

export function findEditorPane(
  node: EditorPaneNode,
  id: string,
): EditorPaneNode | null {
  if (node.id === id) return node;
  if (node.type === "leaf") return null;
  for (const child of node.children) {
    const found = findEditorPane(child, id);
    if (found) return found;
  }
  return null;
}

function replaceEditorPane(
  node: EditorPaneNode,
  id: string,
  replacement: (target: EditorPaneNode) => EditorPaneNode,
): EditorPaneNode {
  if (node.id === id) return replacement(node);
  if (node.type === "leaf") return node;

  let changed = false;
  const children = node.children.map((child) => {
    const next = replaceEditorPane(child, id, replacement);
    changed ||= next !== child;
    return next;
  });
  return changed ? { ...node, children } : node;
}

export function splitEditorPane(
  root: EditorPaneNode,
  paneId: string,
  direction: EditorPaneDirection,
  newPaneId: string,
  splitId: string,
): EditorPaneNode {
  const target = findEditorPane(root, paneId);
  if (
    !target ||
    target.type !== "leaf" ||
    target.detachedWindowId !== null
  ) {
    return root;
  }

  return replaceEditorPane(root, paneId, (node) => {
    if (node.type !== "leaf") return node;
    const original = { ...node, size: 50 };
    const created: EditorPaneLeaf = {
      ...node,
      id: newPaneId,
      size: 50,
      detachedWindowId: null,
      cursor_position: { ...node.cursor_position },
    };
    return {
      type: "split",
      id: splitId,
      size: node.size,
      direction,
      children: [original, created],
    };
  });
}

function removeEditorPane(
  node: EditorPaneNode,
  paneId: string,
): EditorPaneNode | null {
  if (node.type === "leaf") return node.id === paneId ? null : node;

  const children = node.children
    .map((child) => removeEditorPane(child, paneId))
    .filter((child): child is EditorPaneNode => child !== null);

  if (children.length === node.children.length) return node;
  if (children.length === 0) return null;
  if (children.length === 1) return withSize(children[0], node.size);
  return { ...node, children: normalizeChildren(children) };
}

export function closeEditorPane(
  root: EditorPaneNode,
  paneId: string,
): { changed: boolean; layout: EditorPaneNode } {
  const target = findEditorPane(root, paneId);
  if (
    !target ||
    target.type !== "leaf" ||
    target.detachedWindowId !== null ||
    getAttachedEditorPanes(root).length <= 1
  ) {
    return { changed: false, layout: root };
  }

  const layout = removeEditorPane(root, paneId);
  if (!layout) return { changed: false, layout: root };
  return { changed: true, layout: withSize(layout, 100) };
}

export function resizeEditorSplit(
  root: EditorPaneNode,
  splitId: string,
  sizes: number[],
): EditorPaneNode {
  const target = findEditorPane(root, splitId);
  if (
    !target ||
    target.type !== "split" ||
    sizes.length !== target.children.length ||
    sizes.some((size) => !Number.isFinite(size) || size <= 0)
  ) {
    return root;
  }

  const total = sizes.reduce((sum, size) => sum + size, 0);
  return replaceEditorPane(root, splitId, (node) => {
    if (node.type !== "split") return node;
    return {
      ...node,
      children: node.children.map((child, index) => ({
        ...child,
        size: (sizes[index] / total) * 100,
      })),
    };
  });
}

export function updateEditorPaneView(
  root: EditorPaneNode,
  paneId: string,
  view: Partial<EditorPaneViewState>,
): EditorPaneNode {
  return replaceEditorPane(root, paneId, (node) => {
    if (node.type !== "leaf") return node;
    const cursor = view.cursor_position ?? node.cursor_position;
    const scroll = view.scroll_position ?? node.scroll_position;
    if (
      cursor.line === node.cursor_position.line &&
      cursor.column === node.cursor_position.column &&
      scroll === node.scroll_position
    ) {
      return node;
    }
    return {
      ...node,
      cursor_position: { ...cursor },
      scroll_position: scroll,
    };
  });
}

export function setEditorPaneBuffer(
  root: EditorPaneNode,
  paneId: string,
  bufferId: string,
): EditorPaneNode {
  return replaceEditorPane(root, paneId, (node) => {
    if (node.type !== "leaf" || node.bufferId === bufferId) return node;
    return {
      ...node,
      bufferId,
      cursor_position: { ...DEFAULT_CURSOR },
      scroll_position: 0,
    };
  });
}

export function markEditorPaneDetached(
  root: EditorPaneNode,
  paneId: string,
  windowId: string,
): EditorPaneNode {
  if (!windowId) return root;
  return replaceEditorPane(root, paneId, (node) => {
    if (node.type !== "leaf" || node.detachedWindowId === windowId) return node;
    return { ...node, detachedWindowId: windowId };
  });
}

export function reattachEditorPane(
  root: EditorPaneNode,
  paneId: string,
): EditorPaneNode {
  return replaceEditorPane(root, paneId, (node) => {
    if (node.type !== "leaf" || node.detachedWindowId === null) return node;
    return { ...node, detachedWindowId: null };
  });
}

export function reconcileDetachedEditorPanes(
  root: EditorPaneNode,
  liveWindowIds: ReadonlySet<string>,
): EditorPaneNode {
  if (root.type === "leaf") {
    if (
      root.detachedWindowId &&
      !liveWindowIds.has(root.detachedWindowId)
    ) {
      return { ...root, detachedWindowId: null };
    }
    return root;
  }

  let changed = false;
  const children = root.children.map((child) => {
    const next = reconcileDetachedEditorPanes(child, liveWindowIds);
    changed ||= next !== child;
    return next;
  });
  return changed ? { ...root, children } : root;
}

function inferBufferIdentity(bufferId: string): EditorBufferIdentity {
  if (bufferId.startsWith("file:")) {
    return {
      kind: "file",
      path: normalizeEditorFilePath(bufferId.slice("file:".length)),
    };
  }
  return { kind: "untitled", id: bufferId };
}

function persistNode(
  node: EditorPaneNode,
  identities: Readonly<Record<string, EditorBufferIdentity>>,
): PersistedEditorPane {
  if (node.type === "leaf") {
    return {
      type: "leaf",
      id: node.id,
      size: node.size,
      buffer: identities[node.bufferId] ?? inferBufferIdentity(node.bufferId),
      detachedWindowId: node.detachedWindowId,
    };
  }
  return {
    type: "split",
    id: node.id,
    size: node.size,
    direction: node.direction,
    children: node.children.map((child) => persistNode(child, identities)),
  };
}

export function serializeEditorLayout(
  root: EditorPaneNode,
  focusedPaneId: string,
  identities: Readonly<Record<string, EditorBufferIdentity>>,
): string {
  const document: PersistedEditorLayout = {
    version: 1,
    focusedPaneId,
    root: persistNode(root, identities),
  };
  return JSON.stringify(document);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIdentity(
  value: unknown,
  createId: (kind?: string) => string,
): { id: string; identity: EditorBufferIdentity } {
  if (isRecord(value) && value.kind === "file" && typeof value.path === "string") {
    const path = normalizeEditorFilePath(value.path);
    return {
      id: editorBufferIdForFile(path),
      identity: { kind: "file", path },
    };
  }
  if (
    isRecord(value) &&
    value.kind === "untitled" &&
    typeof value.id === "string" &&
    value.id.length > 0
  ) {
    return {
      id: value.id,
      identity: { kind: "untitled", id: value.id },
    };
  }
  const id = `untitled:${createId("buffer")}`;
  return { id, identity: { kind: "untitled", id } };
}

export function deserializeEditorLayout(
  json: string,
  createId: (kind?: string) => string,
): HydratedEditorLayout | null {
  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch {
    return null;
  }
  if (
    !isRecord(document) ||
    document.version !== 1 ||
    !isRecord(document.root)
  ) {
    return null;
  }

  const identities: Record<string, EditorBufferIdentity> = {};
  const seenPaneIds = new Set<string>();

  const parseNode = (value: unknown): EditorPaneNode | null => {
    if (!isRecord(value)) return null;
    const rawId =
      typeof value.id === "string" && value.id.length > 0
        ? value.id
        : `pane-${createId("pane")}`;
    const id = seenPaneIds.has(rawId)
      ? `pane-${createId("pane")}`
      : rawId;
    seenPaneIds.add(id);
    const size = positiveSize(value.size);

    if (value.type === "leaf") {
      const buffer = parseIdentity(value.buffer, createId);
      identities[buffer.id] = buffer.identity;
      return {
        type: "leaf",
        id,
        size,
        bufferId: buffer.id,
        detachedWindowId:
          typeof value.detachedWindowId === "string" &&
          value.detachedWindowId.length > 0
            ? value.detachedWindowId
            : null,
        cursor_position: { ...DEFAULT_CURSOR },
        scroll_position: 0,
      };
    }

    if (
      value.type === "split" &&
      (value.direction === "horizontal" || value.direction === "vertical") &&
      Array.isArray(value.children)
    ) {
      const children = value.children
        .map(parseNode)
        .filter((child): child is EditorPaneNode => child !== null);
      if (children.length === 0) return null;
      if (children.length === 1) return withSize(children[0], size);
      return {
        type: "split",
        id,
        size,
        direction: value.direction,
        children: normalizeChildren(children),
      };
    }

    return null;
  };

  const parsed = parseNode(document.root);
  if (!parsed) return null;
  const layout = withSize(parsed, 100);
  const leaves = getEditorPaneLeaves(layout);
  if (leaves.length === 0) return null;
  const requestedFocus =
    typeof document.focusedPaneId === "string"
      ? document.focusedPaneId
      : "";
  const focusedPaneId = leaves.some((pane) => pane.id === requestedFocus)
    ? requestedFocus
    : leaves[0].id;

  return {
    layout,
    focusedPaneId,
    bufferIdentities: identities,
  };
}
