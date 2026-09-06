import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  editorBufferMarkSaved,
  editorBufferRegister,
  editorBufferUpdate,
  type EditorBufferMarkSavedRequest,
  type EditorBufferSeed,
  type EditorBufferSnapshot,
  type EditorBufferUpdateRequest,
  type EditorBufferUpdateResult,
} from "../../lib/tauri";
import type { EditorBufferSyncStatus } from "../../state/editorStore";

export const EDITOR_BUFFER_CHANGED_EVENT = "editor-buffer-changed";
export const EDITOR_BUFFER_COALESCE_MS = 120;

export type EditorBufferSyncTransport = {
  register: (seed: EditorBufferSeed) => Promise<EditorBufferSnapshot>;
  update: (
    request: EditorBufferUpdateRequest,
  ) => Promise<EditorBufferUpdateResult>;
  markSaved: (
    request: EditorBufferMarkSavedRequest,
  ) => Promise<EditorBufferUpdateResult>;
  listen: (
    handler: (snapshot: EditorBufferSnapshot) => void,
  ) => Promise<UnlistenFn>;
};

export const tauriEditorBufferSyncTransport: EditorBufferSyncTransport = {
  register: editorBufferRegister,
  update: editorBufferUpdate,
  markSaved: editorBufferMarkSaved,
  listen: (handler) =>
    listen<EditorBufferSnapshot>(EDITOR_BUFFER_CHANGED_EVENT, (event) =>
      handler(event.payload),
    ),
};

type LocalBufferVersion = {
  sequence: number;
  content: string;
  language: string;
  ciscoPlatform: EditorBufferSeed["ciscoPlatform"];
  dirty: boolean;
};

export type EditorBufferSyncClientOptions = {
  bufferId: string;
  sourceId: string;
  transport?: EditorBufferSyncTransport;
  coalesceMs?: number;
  onSnapshot: (snapshot: EditorBufferSnapshot) => void;
  /** Revision metadata changed while newer local text must be preserved. */
  onRevision: (snapshot: EditorBufferSnapshot) => void;
  onStatus: (status: EditorBufferSyncStatus, error?: string) => void;
};

export class EditorBufferSyncClient {
  private readonly bufferId: string;
  private readonly sourceId: string;
  private readonly transport: EditorBufferSyncTransport;
  private readonly coalesceMs: number;
  private readonly onSnapshot: (snapshot: EditorBufferSnapshot) => void;
  private readonly onRevision: (snapshot: EditorBufferSnapshot) => void;
  private readonly onStatus: (
    status: EditorBufferSyncStatus,
    error?: string,
  ) => void;
  private baseRevision = -1;
  private localSequence = 0;
  private acknowledgedSequence = 0;
  private latestLocal: LocalBufferVersion | null = null;
  private started = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unlisten: UnlistenFn | null = null;
  private startPromise: Promise<void> | null = null;
  private inFlight: Promise<boolean> | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private latestAuthoritative: EditorBufferSnapshot | null = null;

  constructor(options: EditorBufferSyncClientOptions) {
    this.bufferId = options.bufferId;
    this.sourceId = options.sourceId;
    this.transport = options.transport ?? tauriEditorBufferSyncTransport;
    this.coalesceMs = options.coalesceMs ?? EDITOR_BUFFER_COALESCE_MS;
    this.onSnapshot = options.onSnapshot;
    this.onRevision = options.onRevision;
    this.onStatus = options.onStatus;
  }

  get revision(): number {
    return Math.max(0, this.baseRevision);
  }

  start(seed: EditorBufferSeed): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal(seed);
    return this.startPromise;
  }

  private async startInternal(seed: EditorBufferSeed): Promise<void> {
    try {
      const unlisten = await this.transport.listen((snapshot) => {
        this.receiveEvent(snapshot);
      });
      if (this.disposed) {
        unlisten();
        return;
      }
      this.unlisten = unlisten;

      const registered = await this.transport.register(seed);
      if (this.disposed) return;
      this.started = true;
      this.acceptAuthoritative(registered);
      if (this.hasPendingLocal()) this.schedulePublish(this.coalesceMs);
    } catch (error) {
      if (!this.disposed) {
        this.onStatus("error", String(error));
      }
      throw error;
    }
  }

  queueLocal(
    content: string,
    language: string,
    ciscoPlatform: EditorBufferSeed["ciscoPlatform"],
    dirty: boolean,
  ): void {
    if (this.disposed) return;
    if (
      this.hasPendingLocal() &&
      this.latestLocal &&
      this.latestLocal.content === content &&
      this.latestLocal.language === language &&
      this.latestLocal.ciscoPlatform === ciscoPlatform &&
      this.latestLocal.dirty === dirty
    ) {
      return;
    }
    this.localSequence += 1;
    this.latestLocal = {
      sequence: this.localSequence,
      content,
      language,
      ciscoPlatform,
      dirty,
    };
    this.onStatus("local");
    this.schedulePublish(this.coalesceMs, true);
  }

  async flushNow(): Promise<EditorBufferSnapshot> {
    await this.startPromise;
    this.clearTimer();
    while (!this.disposed && this.hasPendingLocal()) {
      if (this.inFlight) {
        const succeeded = await this.inFlight;
        if (!succeeded) {
          throw new Error(
            "failed to synchronize editor buffer before continuing",
          );
        }
      } else {
        const succeeded = await this.publishLatest();
        if (!succeeded) {
          throw new Error(
            "failed to synchronize editor buffer before continuing",
          );
        }
      }
    }
    if (!this.latestAuthoritative) {
      throw new Error("editor buffer has no authoritative snapshot");
    }
    return this.latestAuthoritative;
  }

  async markSaved(revision = this.revision): Promise<EditorBufferSnapshot> {
    await this.startPromise;
    if (this.disposed) {
      throw new Error("editor buffer sync client is disposed");
    }
    const result = await this.transport.markSaved({
      bufferId: this.bufferId,
      revision,
      sourceId: this.sourceId,
    });
    if (this.disposed) return result.snapshot;

    const previousRevision = this.baseRevision;
    const authoritative = this.rememberAuthoritative(result.snapshot);
    if (this.hasPendingLocal()) {
      if (authoritative.revision > previousRevision) {
        this.onRevision(authoritative);
      }
    } else {
      this.onSnapshot(authoritative);
    }
    this.onStatus(result.status === "applied" ? "synced" : "conflict");
    return result.snapshot;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    this.unlisten?.();
    this.unlisten = null;
  }

  private receiveEvent(snapshot: EditorBufferSnapshot): void {
    if (
      this.disposed ||
      snapshot.bufferId !== this.bufferId ||
      snapshot.revision <= this.baseRevision
    ) {
      return;
    }
    const authoritative = this.rememberAuthoritative(snapshot);
    if (this.hasPendingLocal()) {
      this.onRevision(authoritative);
      this.onStatus("local");
    } else {
      this.onSnapshot(authoritative);
      this.onStatus("synced");
    }
  }

  private acceptAuthoritative(snapshot: EditorBufferSnapshot): void {
    if (
      snapshot.bufferId !== this.bufferId ||
      snapshot.revision <= this.baseRevision
    ) {
      return;
    }
    const authoritative = this.rememberAuthoritative(snapshot);
    if (this.hasPendingLocal()) this.onRevision(authoritative);
    else this.onSnapshot(authoritative);
    this.onStatus(this.hasPendingLocal() ? "local" : "synced");
  }

  private rememberAuthoritative(
    snapshot: EditorBufferSnapshot,
  ): EditorBufferSnapshot {
    if (
      snapshot.bufferId === this.bufferId &&
      (!this.latestAuthoritative ||
        snapshot.revision > this.latestAuthoritative.revision)
    ) {
      this.latestAuthoritative = snapshot;
    }
    this.baseRevision = Math.max(this.baseRevision, snapshot.revision);
    return this.latestAuthoritative ?? snapshot;
  }

  private hasPendingLocal(): boolean {
    return (
      this.latestLocal !== null &&
      this.localSequence > this.acknowledgedSequence
    );
  }

  private schedulePublish(delay: number, reset = false): void {
    if (this.disposed) return;
    if (reset) this.clearTimer();
    if (this.timer !== null) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        if (!this.started || this.inFlight || !this.hasPendingLocal()) return;
        void this.publishLatest();
      },
      Math.max(0, delay),
    );
  }

  private publishLatest(): Promise<boolean> {
    if (this.disposed || !this.started || this.inFlight || !this.latestLocal) {
      return this.inFlight ?? Promise.resolve(true);
    }

    const sent = this.latestLocal;
    this.lastSentAt = Date.now();
    this.onStatus("syncing");
    const request = this.transport
      .update({
        bufferId: this.bufferId,
        baseRevision: this.revision,
        content: sent.content,
        language: sent.language,
        ciscoPlatform: sent.ciscoPlatform,
        dirty: sent.dirty,
        sourceId: this.sourceId,
      })
      .then((result) => {
        if (this.disposed) return true;
        this.handleUpdateResult(result, sent.sequence);
        return true;
      })
      .catch((error) => {
        if (!this.disposed) {
          this.onStatus("error", String(error));
        }
        return false;
      })
      .finally(() => {
        if (this.inFlight === request) this.inFlight = null;
        if (!this.disposed && this.hasPendingLocal()) {
          const elapsed = Date.now() - this.lastSentAt;
          this.schedulePublish(Math.max(0, this.coalesceMs - elapsed));
        }
      });
    this.inFlight = request;
    return request;
  }

  private handleUpdateResult(
    result: EditorBufferUpdateResult,
    sentSequence: number,
  ): void {
    const authoritative = this.rememberAuthoritative(result.snapshot);

    if (result.status === "applied") {
      this.acknowledgedSequence = Math.max(
        this.acknowledgedSequence,
        sentSequence,
      );
      if (this.localSequence > sentSequence) {
        this.onRevision(authoritative);
        this.onStatus("local");
      } else {
        this.onSnapshot(authoritative);
        this.onStatus("synced");
      }
      return;
    }

    if (this.localSequence > sentSequence) {
      this.onRevision(authoritative);
      this.acknowledgedSequence = Math.max(
        this.acknowledgedSequence,
        sentSequence,
      );
      this.onStatus("conflict");
      return;
    }

    this.acknowledgedSequence = this.localSequence;
    this.onSnapshot(authoritative);
    this.onStatus("conflict");
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

export async function flushEditorBufferSyncClients(
  clients: Iterable<EditorBufferSyncClient>,
): Promise<void> {
  await Promise.all([...clients].map((client) => client.flushNow()));
}
