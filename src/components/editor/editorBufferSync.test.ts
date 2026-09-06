import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EditorBufferSyncClient,
  flushEditorBufferSyncClients,
  type EditorBufferSyncClientOptions,
  type EditorBufferSyncTransport,
} from "./editorBufferSync";
import type {
  EditorBufferSnapshot,
  EditorBufferUpdateResult,
} from "../../lib/tauri";
import type { CiscoPlatform } from "../../lib/ciscoLint";

function snapshot(
  revision: number,
  content: string,
  sourceId = "backend",
  ciscoPlatform: CiscoPlatform | null = null,
): EditorBufferSnapshot {
  return {
    bufferId: "file:/repo/a.ts",
    filePath: "/repo/a.ts",
    content,
    language: "typescript",
    ciscoPlatform,
    dirty: true,
    revision,
    sourceId,
  };
}

function transport(initial = snapshot(0, "initial")) {
  let eventHandler: ((value: EditorBufferSnapshot) => void) | undefined;
  const unlisten = vi.fn();
  const value: EditorBufferSyncTransport = {
    register: vi.fn().mockResolvedValue(initial),
    update: vi.fn().mockImplementation(
      async (request): Promise<EditorBufferUpdateResult> => ({
        status: "applied",
        snapshot: snapshot(
          request.baseRevision + 1,
          request.content,
          request.sourceId,
          request.ciscoPlatform,
        ),
      }),
    ),
    markSaved: vi.fn().mockImplementation(
      async (request): Promise<EditorBufferUpdateResult> => ({
        status: "applied",
        snapshot: {
          ...initial,
          dirty: false,
          revision: request.revision + 1,
          sourceId: request.sourceId,
        },
      }),
    ),
    listen: vi.fn().mockImplementation(async (handler) => {
      eventHandler = handler;
      return unlisten;
    }),
  };
  return {
    value,
    update: value.update as ReturnType<typeof vi.fn>,
    markSaved: value.markSaved as ReturnType<typeof vi.fn>,
    unlisten,
    emit(value: EditorBufferSnapshot) {
      eventHandler?.(value);
    },
  };
}

function client(
  syncTransport: EditorBufferSyncTransport,
  handlers?: Partial<
    Pick<
      EditorBufferSyncClientOptions,
      "onSnapshot" | "onRevision" | "onStatus"
    >
  >,
) {
  return new EditorBufferSyncClient({
    bufferId: "file:/repo/a.ts",
    sourceId: "main-window",
    transport: syncTransport,
    onSnapshot: handlers?.onSnapshot ?? vi.fn(),
    onRevision: handlers?.onRevision ?? vi.fn(),
    onStatus: handlers?.onStatus ?? vi.fn(),
  });
}

const seed = {
  bufferId: "file:/repo/a.ts",
  filePath: "/repo/a.ts",
  content: "initial",
  language: "typescript",
  ciscoPlatform: "iosxe" as const,
  dirty: false,
  sourceId: "main-window",
};

describe("EditorBufferSyncClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces local writes for 120ms and sends only the newest text", async () => {
    const fake = transport();
    const sync = client(fake.value);
    await sync.start(seed);

    expect(fake.value.register).toHaveBeenCalledWith(
      expect.objectContaining({ ciscoPlatform: "iosxe" }),
    );

    sync.queueLocal("one", "cisco-iosxe", "iosxe", true);
    sync.queueLocal("two", "cisco-iosxe", "iosxe", true);
    await vi.advanceTimersByTimeAsync(119);
    expect(fake.update).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.update).toHaveBeenCalledOnce();
    expect(fake.update).toHaveBeenCalledWith({
      bufferId: seed.bufferId,
      baseRevision: 0,
      content: "two",
      language: "cisco-iosxe",
      ciscoPlatform: "iosxe",
      dirty: true,
      sourceId: "main-window",
    });
  });

  it("allows only one request in flight and publishes a newer pending write later", async () => {
    let resolveFirst: ((result: EditorBufferUpdateResult) => void) | undefined;
    const fake = transport();
    fake.update.mockImplementationOnce(
      () =>
        new Promise<EditorBufferUpdateResult>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const sync = client(fake.value);
    await sync.start(seed);

    sync.queueLocal("one", "typescript", null, true);
    await vi.advanceTimersByTimeAsync(120);
    sync.queueLocal("two", "typescript", null, true);
    await vi.advanceTimersByTimeAsync(120);
    expect(fake.update).toHaveBeenCalledOnce();

    resolveFirst?.({
      status: "applied",
      snapshot: snapshot(1, "one", "main-window"),
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(120);

    expect(fake.update).toHaveBeenCalledTimes(2);
    expect(fake.update.mock.calls[1][0]).toMatchObject({
      baseRevision: 1,
      content: "two",
    });
  });

  it("ignores stale events and applies only a newer authoritative snapshot", async () => {
    const fake = transport(snapshot(3, "current"));
    const onSnapshot = vi.fn();
    const sync = client(fake.value, { onSnapshot });
    await sync.start(seed);
    onSnapshot.mockClear();

    fake.emit(snapshot(2, "stale"));
    fake.emit(snapshot(3, "duplicate"));
    fake.emit(snapshot(4, "new"));

    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(onSnapshot).toHaveBeenCalledWith(snapshot(4, "new"));
    expect(sync.revision).toBe(4);
  });

  it("advances its base revision after an applied response", async () => {
    const fake = transport();
    const sync = client(fake.value);
    await sync.start(seed);

    sync.queueLocal("one", "typescript", null, true);
    await vi.advanceTimersByTimeAsync(120);
    sync.queueLocal("two", "typescript", null, true);
    await vi.advanceTimersByTimeAsync(120);

    expect(fake.update.mock.calls[1][0].baseRevision).toBe(1);
  });

  it("flushes to and returns the exact authoritative snapshot", async () => {
    const fake = transport();
    const sync = client(fake.value);
    await sync.start(seed);
    sync.queueLocal("save this", "typescript", null, true);

    const flushed = await sync.flushNow();

    expect(flushed).toEqual(snapshot(1, "save this", "main-window"));
  });

  it("flushes every live editor client before shutdown preparation resolves", async () => {
    let resolveFirst: ((result: EditorBufferUpdateResult) => void) | undefined;
    const firstTransport = transport();
    firstTransport.update.mockImplementationOnce(
      () =>
        new Promise<EditorBufferUpdateResult>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const secondTransport = transport();
    const first = client(firstTransport.value);
    const second = client(secondTransport.value);
    await first.start(seed);
    await second.start(seed);
    first.queueLocal("first pending", "typescript", null, true);
    second.queueLocal("second pending", "typescript", null, true);

    let completed = false;
    const pending = flushEditorBufferSyncClients([first, second]).then(() => {
      completed = true;
    });
    await Promise.resolve();

    expect(firstTransport.update).toHaveBeenCalledOnce();
    expect(secondTransport.update).toHaveBeenCalledOnce();
    expect(completed).toBe(false);

    resolveFirst?.({
      status: "applied",
      snapshot: snapshot(1, "first pending", "main-window"),
    });
    await pending;
    expect(completed).toBe(true);
  });

  it("rejects a flush when pending local text cannot be synchronized", async () => {
    const fake = transport();
    fake.update.mockRejectedValueOnce(new Error("transport down"));
    const sync = client(fake.value);
    await sync.start(seed);
    sync.queueLocal("must not be lost", "typescript", null, true);

    await expect(sync.flushNow()).rejects.toThrow(
      "failed to synchronize editor buffer",
    );
  });

  it("retries a conflict only when newer local content is still pending", async () => {
    let resolveFirst: ((result: EditorBufferUpdateResult) => void) | undefined;
    const fake = transport();
    fake.update.mockImplementationOnce(
      () =>
        new Promise<EditorBufferUpdateResult>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const onSnapshot = vi.fn();
    const onRevision = vi.fn();
    const sync = client(fake.value, { onSnapshot, onRevision });
    await sync.start(seed);
    onSnapshot.mockClear();

    sync.queueLocal("first", "typescript", null, true);
    await vi.advanceTimersByTimeAsync(120);
    sync.queueLocal("newer", "typescript", null, true);
    resolveFirst?.({
      status: "conflict",
      snapshot: snapshot(8, "remote"),
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(120);

    expect(onSnapshot).not.toHaveBeenCalledWith(snapshot(8, "remote"));
    expect(onRevision).toHaveBeenCalledWith(snapshot(8, "remote"));
    expect(fake.update).toHaveBeenCalledTimes(2);
    expect(fake.update.mock.calls[1][0]).toMatchObject({
      baseRevision: 8,
      content: "newer",
    });
    expect(onSnapshot).toHaveBeenCalledWith(
      snapshot(9, "newer", "main-window"),
    );
  });

  it("adopts a conflict without retry when there is no newer local write", async () => {
    const fake = transport();
    fake.update.mockResolvedValueOnce({
      status: "conflict",
      snapshot: snapshot(4, "remote"),
    });
    const onSnapshot = vi.fn();
    const sync = client(fake.value, { onSnapshot });
    await sync.start(seed);
    onSnapshot.mockClear();

    sync.queueLocal("loses", "typescript", null, true);
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(500);

    expect(fake.update).toHaveBeenCalledOnce();
    expect(onSnapshot).toHaveBeenCalledWith(snapshot(4, "remote"));
  });

  it("adopts an event-first conflict after its command response arrives", async () => {
    let resolveUpdate: ((result: EditorBufferUpdateResult) => void) | undefined;
    const fake = transport();
    fake.update.mockImplementationOnce(
      () =>
        new Promise<EditorBufferUpdateResult>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const onSnapshot = vi.fn();
    const sync = client(fake.value, { onSnapshot });
    await sync.start(seed);
    onSnapshot.mockClear();

    sync.queueLocal("loses", "typescript", null, true);
    await vi.advanceTimersByTimeAsync(120);
    const remote = snapshot(4, "remote");
    fake.emit(remote);
    resolveUpdate?.({ status: "conflict", snapshot: remote });
    await Promise.resolve();

    expect(fake.update).toHaveBeenCalledOnce();
    expect(onSnapshot).toHaveBeenCalledWith(remote);
  });

  it("converges on a newer event that arrives before an applied response", async () => {
    let resolveUpdate: ((result: EditorBufferUpdateResult) => void) | undefined;
    const fake = transport();
    fake.update.mockImplementationOnce(
      () =>
        new Promise<EditorBufferUpdateResult>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const onSnapshot = vi.fn();
    const sync = client(fake.value, { onSnapshot });
    await sync.start(seed);
    onSnapshot.mockClear();

    sync.queueLocal("accepted-first", "typescript", null, true);
    await vi.advanceTimersByTimeAsync(120);
    const newerRemote = snapshot(2, "newer-remote");
    fake.emit(newerRemote);
    resolveUpdate?.({
      status: "applied",
      snapshot: snapshot(1, "accepted-first", "main-window"),
    });
    await Promise.resolve();

    expect(onSnapshot).toHaveBeenCalledWith(newerRemote);
    expect(sync.revision).toBe(2);
  });

  it("marks only the current revision saved and applies the result", async () => {
    const fake = transport(snapshot(5, "current"));
    const onSnapshot = vi.fn();
    const sync = client(fake.value, { onSnapshot });
    await sync.start({ ...seed, content: "current" });
    onSnapshot.mockClear();

    const saved = await sync.markSaved();

    expect(fake.markSaved).toHaveBeenCalledWith({
      bufferId: seed.bufferId,
      revision: 5,
      sourceId: "main-window",
    });
    expect(saved.revision).toBe(6);
    expect(saved.dirty).toBe(false);
    expect(onSnapshot).toHaveBeenCalledWith(saved);
  });

  it("cancels timers and listeners and ignores late responses on teardown", async () => {
    let resolveUpdate: ((result: EditorBufferUpdateResult) => void) | undefined;
    const fake = transport();
    fake.update.mockImplementationOnce(
      () =>
        new Promise<EditorBufferUpdateResult>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const onSnapshot = vi.fn();
    const sync = client(fake.value, { onSnapshot });
    await sync.start(seed);
    onSnapshot.mockClear();
    sync.queueLocal("pending", "typescript", null, true);
    await vi.advanceTimersByTimeAsync(120);

    sync.dispose();
    resolveUpdate?.({
      status: "applied",
      snapshot: snapshot(1, "pending"),
    });
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(fake.unlisten).toHaveBeenCalledOnce();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(fake.update).toHaveBeenCalledOnce();
  });
});
