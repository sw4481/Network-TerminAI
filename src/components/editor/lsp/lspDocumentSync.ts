import type * as Monaco from "monaco-editor";
import type { LspClient } from "../../../hooks/useLspClient";

type DocumentTransport = Pick<
  LspClient,
  "clientId" | "openDocument" | "changeDocument" | "closeDocument"
>;

type Owner = {
  references: number;
  transport: DocumentTransport;
  ready: Promise<void>;
};

type DocumentEntry = {
  model: Monaco.editor.ITextModel;
  uri: string;
  languageId: string;
  owners: Map<string, Owner>;
  lastQueuedText: string;
  changeTimer: ReturnType<typeof setTimeout> | null;
  changeListener: Monaco.IDisposable;
  queue: Promise<void>;
};

export type LspDocumentLease = {
  ready: Promise<void>;
  dispose: () => void;
};

const registries = new WeakMap<object, Map<string, DocumentEntry>>();

function registryFor(monaco: typeof Monaco): Map<string, DocumentEntry> {
  const key = monaco as unknown as object;
  let registry = registries.get(key);
  if (!registry) {
    registry = new Map();
    registries.set(key, registry);
  }
  return registry;
}

function firstOwner(entry: DocumentEntry): Owner | null {
  return entry.owners.values().next().value ?? null;
}

function appendChange(entry: DocumentEntry, text: string): void {
  if (entry.lastQueuedText === text) return;
  entry.lastQueuedText = text;
  entry.queue = entry.queue
    .catch(() => undefined)
    .then(async () => {
      const owner = firstOwner(entry);
      if (!owner) return;
      await owner.ready;
      await owner.transport.changeDocument(entry.uri, text);
    })
    .catch((error) => {
      console.error(`Failed to synchronize LSP document ${entry.uri}:`, error);
    });
}

function currentModelText(entry: DocumentEntry): string {
  if (entry.model.isDisposed()) return entry.lastQueuedText;
  try {
    return entry.model.getValue();
  } catch {
    // Monaco can dispose its final model lease before React runs this passive
    // LSP cleanup. The last queued snapshot is already authoritative then.
    return entry.lastQueuedText;
  }
}

function scheduleChange(entry: DocumentEntry, debounceMs: number): void {
  if (entry.changeTimer) clearTimeout(entry.changeTimer);
  entry.changeTimer = setTimeout(() => {
    entry.changeTimer = null;
    appendChange(entry, currentModelText(entry));
  }, debounceMs);
}

export function acquireLspDocument({
  monaco,
  model,
  sessionKey,
  languageId,
  transport,
  debounceMs = 120,
}: {
  monaco: typeof Monaco;
  model: Monaco.editor.ITextModel;
  sessionKey: string;
  languageId: string;
  transport: DocumentTransport;
  debounceMs?: number;
}): LspDocumentLease {
  const uri = model.uri.toString();
  const registry = registryFor(monaco);
  const key = `${sessionKey}\u0000${uri}`;
  let entry = registry.get(key);

  if (!entry) {
    const placeholder = {} as DocumentEntry;
    const changeListener = model.onDidChangeContent(() =>
      scheduleChange(placeholder, debounceMs),
    );
    entry = Object.assign(placeholder, {
      model,
      uri,
      languageId,
      owners: new Map<string, Owner>(),
      lastQueuedText: model.getValue(),
      changeTimer: null,
      changeListener,
      queue: Promise.resolve(),
    });
    registry.set(key, entry);
  }

  let owner = entry.owners.get(transport.clientId);
  if (owner) {
    owner.references += 1;
  } else {
    const ready = transport.openDocument(uri, languageId, model.getValue());
    owner = { references: 1, transport, ready };
    entry.owners.set(transport.clientId, owner);
  }

  let disposed = false;
  return {
    ready: owner.ready,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const currentEntry = registry.get(key);
      const currentOwner = currentEntry?.owners.get(transport.clientId);
      if (!currentEntry || !currentOwner) return;
      currentOwner.references -= 1;
      if (currentOwner.references > 0) return;

      currentEntry.owners.delete(transport.clientId);
      if (currentEntry.owners.size > 0) {
        void currentOwner.ready
          .then(() => currentOwner.transport.closeDocument(uri))
          .catch(() => undefined);
        return;
      }

      if (currentEntry.changeTimer) {
        clearTimeout(currentEntry.changeTimer);
        currentEntry.changeTimer = null;
      }
      appendChange(currentEntry, currentModelText(currentEntry));
      currentEntry.changeListener.dispose();
      registry.delete(key);
      currentEntry.queue = currentEntry.queue
        .then(() => currentOwner.ready)
        .then(() => currentOwner.transport.closeDocument(uri))
        .catch(() => undefined);
    },
  };
}
