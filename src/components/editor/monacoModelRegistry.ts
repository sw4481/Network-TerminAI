import type * as Monaco from "monaco-editor";

export type MonacoModelLease = {
  bufferId: string;
  model: Monaco.editor.ITextModel;
  release: () => void;
};

type RegistryEntry = {
  model: Monaco.editor.ITextModel;
  references: number;
};

function modelUri(monaco: typeof Monaco, bufferId: string): Monaco.Uri {
  if (bufferId.startsWith("file:")) {
    return monaco.Uri.file(bufferId.slice("file:".length));
  }
  return monaco.Uri.parse(
    `inmemory://ccie-editor/${encodeURIComponent(bufferId)}`,
  );
}

export class MonacoModelRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly applyingContent = new Set<string>();

  constructor(private readonly monaco: typeof Monaco) {}

  acquire(
    bufferId: string,
    initialContent: string,
    language: string,
  ): MonacoModelLease {
    let entry = this.entries.get(bufferId);
    if (!entry) {
      const uri = modelUri(this.monaco, bufferId);
      const model =
        this.monaco.editor.getModel(uri) ??
        this.monaco.editor.createModel(initialContent, language, uri);
      entry = { model, references: 0 };
      this.entries.set(bufferId, entry);
    }

    if (entry.model.getLanguageId() !== language) {
      this.monaco.editor.setModelLanguage(entry.model, language);
    }
    entry.references += 1;
    let released = false;

    return {
      bufferId,
      model: entry.model,
      release: () => {
        if (released) return;
        released = true;
        const current = this.entries.get(bufferId);
        if (!current || current.model !== entry?.model) return;
        current.references -= 1;
        if (current.references > 0) return;
        this.entries.delete(bufferId);
        current.model.dispose();
      },
    };
  }

  referenceCount(bufferId: string): number {
    return this.entries.get(bufferId)?.references ?? 0;
  }

  applyContent(bufferId: string, content: string): boolean {
    const model = this.entries.get(bufferId)?.model;
    if (!model || model.getValue() === content) return false;
    this.applyingContent.add(bufferId);
    try {
      model.pushEditOperations(
        [],
        [
          {
            range: model.getFullModelRange(),
            text: content,
            forceMoveMarkers: true,
          },
        ],
        () => null,
      );
    } finally {
      this.applyingContent.delete(bufferId);
    }
    return true;
  }

  isApplyingContent(bufferId: string): boolean {
    return this.applyingContent.has(bufferId);
  }
}

const registries = new WeakMap<object, MonacoModelRegistry>();

export function getMonacoModelRegistry(
  monaco: typeof Monaco,
): MonacoModelRegistry {
  const key = monaco as unknown as object;
  const existing = registries.get(key);
  if (existing) return existing;
  const registry = new MonacoModelRegistry(monaco);
  registries.set(key, registry);
  return registry;
}

/**
 * Keeps view state local to one pane while that pane switches between shared
 * models. Other panes using the same model own separate controllers.
 */
export class MonacoPaneModelController {
  private readonly viewStates = new Map<
    string,
    Monaco.editor.ICodeEditorViewState
  >();
  private currentBufferId: string;

  constructor(
    private readonly editor: Monaco.editor.IStandaloneCodeEditor,
    initialBufferId: string,
  ) {
    this.currentBufferId = initialBufferId;
  }

  switchTo(bufferId: string, model: Monaco.editor.ITextModel): void {
    if (bufferId === this.currentBufferId && this.editor.getModel() === model) {
      return;
    }
    const currentView = this.editor.saveViewState();
    if (currentView) this.viewStates.set(this.currentBufferId, currentView);
    this.editor.setModel(model);
    const nextView = this.viewStates.get(bufferId);
    if (nextView) this.editor.restoreViewState(nextView);
    this.currentBufferId = bufferId;
  }

  capture(): void {
    const view = this.editor.saveViewState();
    if (view) this.viewStates.set(this.currentBufferId, view);
  }

  clear(): void {
    this.viewStates.clear();
  }
}
