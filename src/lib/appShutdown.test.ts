import { describe, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ listen: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: transport.listen }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: transport.invoke }));
import {
  AppShutdownTaskRegistry,
  createAppShutdownRequestHandler,
  type AppShutdownPrepare,
  AppPreflightRegistry,
  createAppPreflightHandler,
  installAppShutdownResponder,
  appPreflightGuards,
  APP_PREFLIGHT_EVENT,
  APP_PREFLIGHT_CANCEL_EVENT,
} from "./appShutdown";

describe("cancelable app preflight", () => {
  it("cleans up a partially installed native responder when listener registration fails", async () => {
    const unlisten = vi.fn();
    transport.listen.mockResolvedValueOnce(unlisten).mockRejectedValueOnce(new Error("native event unavailable"));
    await expect(installAppShutdownResponder()).rejects.toThrow("native event unavailable");
    expect(unlisten).toHaveBeenCalledOnce();
  });
  it("native preflight and timeout event callbacks release a pending real registry approval", async () => {
    const listeners = new Map<string, (event: { payload: unknown }) => void>(), unlisten = vi.fn(), decision = deferred(), release = vi.fn();
    transport.listen.mockImplementation(async (name, callback) => { listeners.set(name, callback); return unlisten; });
    transport.invoke.mockResolvedValue(true);
    const unregister = appPreflightGuards.register("event-test", () => ({ confirm: async () => { await decision.promise; return true; }, release, prepareUpdate: async () => {} }));
    const dispose = await installAppShutdownResponder();
    listeners.get(APP_PREFLIGHT_EVENT)!({ payload: { requestId: 123, reason: "main-window-close", timeoutMs: 30000 } });
    expect(appPreflightGuards.isActive()).toBe(true);
    listeners.get(APP_PREFLIGHT_CANCEL_EVENT)!({ payload: { requestId: 123 } });
    expect(release).toHaveBeenCalledOnce(); expect(appPreflightGuards.isActive()).toBe(false);
    decision.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(transport.invoke).not.toHaveBeenCalledWith("app_shutdown_preflight_decide", { requestId: 123, approved: true, failed: false });
    dispose(); unregister(); expect(unlisten).toHaveBeenCalledTimes(3);
  });
  it("freezes every owner before confirmation and releases canceled competing requests", async () => {
    const registry = new AppPreflightRegistry(), order: string[] = [];
    for (const id of ["a", "b"]) registry.register(id, () => {
      order.push(`freeze:${id}`);
      return { confirm: async () => { order.push(`confirm:${id}`); return id !== "b"; }, release: () => { order.push(`release:${id}`); }, prepareUpdate: async () => {} };
    });
    expect(await registry.acquire()).toBeNull();
    expect(order.slice(0, 2)).toEqual(["freeze:a", "freeze:b"]);
    expect(order).toContain("release:a"); expect(order).toContain("release:b");
  });
  it("native timeout releases immediately and a late approval never acknowledges true", async () => {
    const registry = new AppPreflightRegistry(), decision = deferred(), release = vi.fn();
    registry.register("telemetry", () => ({ confirm: async () => { await decision.promise; return true; }, release, prepareUpdate: async () => {} }));
    const acknowledge = vi.fn().mockResolvedValue(true);
    const handler = createAppPreflightHandler(registry, acknowledge);
    const pending = handler.prepare({ requestId: 4, reason: "main-window-close", timeoutMs: 30000 });
    handler.cancel(4);
    expect(release).toHaveBeenCalledOnce();
    decision.resolve(); await pending;
    expect(acknowledge).not.toHaveBeenCalledWith(4, true, false);
    expect(await registry.acquire(new AbortController().signal)).not.toBeUndefined();
  });
  it("failed native decision and errors release approvals without cleanup", async () => {
    const registry = new AppPreflightRegistry(), release = vi.fn(), cleanup = vi.fn();
    registry.register("telemetry", () => ({ confirm: async () => true, release, prepareUpdate: cleanup }));
    const handler = createAppPreflightHandler(registry, async () => false);
    await handler.prepare({ requestId: 7, reason: "application-quit", timeoutMs: 30000 });
    expect(release).toHaveBeenCalledOnce(); expect(cleanup).not.toHaveBeenCalled();
  });
  it("timeout during the native decision releases the lease and blocks a competing updater", async () => {
    const registry = new AppPreflightRegistry(), release = vi.fn();
    let resolve!: (approved: boolean) => void;
    const decision = new Promise<boolean>((done) => { resolve = done; });
    registry.register("telemetry", () => ({ confirm: async () => true, release, prepareUpdate: async () => {} }));
    const decide = vi.fn(() => decision), handler = createAppPreflightHandler(registry, decide);
    const pending = handler.prepare({ requestId: 8, reason: "application-quit", timeoutMs: 30000 });
    await Promise.resolve(); await Promise.resolve();
    expect(decide).toHaveBeenCalledWith(8, true, false);
    await expect(registry.acquire()).rejects.toThrow("already in progress");
    handler.cancel(8); expect(release).toHaveBeenCalledOnce();
    resolve(true); await pending;
    expect(registry.isActive()).toBe(false);
  });
  it("a confirmation error releases every frozen owner and reports failure without approving", async () => {
    const registry = new AppPreflightRegistry(), release = vi.fn(), decide = vi.fn().mockResolvedValue(true);
    registry.register("telemetry", () => ({ confirm: async () => { throw new Error("dialog unavailable"); }, release, prepareUpdate: async () => {} }));
    await createAppPreflightHandler(registry, decide).prepare({ requestId: 9, reason: "main-window-close", timeoutMs: 30000 });
    expect(decide).toHaveBeenCalledWith(9, false, true); expect(release).toHaveBeenCalledOnce();
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const request: AppShutdownPrepare = {
  requestId: 7,
  reason: "main-window-close",
  timeoutMs: 8_000,
};

describe("app shutdown preparation", () => {
  it("acknowledges only after every registered save and flush completes", async () => {
    const session = deferred();
    const editor = deferred();
    const telemetry = deferred();
    const order: string[] = [];
    const tasks = new AppShutdownTaskRegistry();
    tasks.register("session", async () => {
      await session.promise;
      order.push("session");
    });
    tasks.register("editor:tab-1", async () => {
      await editor.promise;
      order.push("editor");
    });
    tasks.register('telemetry:tab-2', async () => {
      await telemetry.promise;
      order.push('telemetry');
    });
    const handle = createAppShutdownRequestHandler(tasks, async () => {
      order.push("ack");
    });

    const pending = handle(request);
    await Promise.resolve();
    expect(order).toEqual([]);

    session.resolve();
    await Promise.resolve();
    expect(order).toEqual(["session"]);

    editor.resolve();
    await Promise.resolve();
    expect(order).toEqual(['session', 'editor']);
    telemetry.resolve();
    await pending;
    expect(order).toEqual(["session", "editor", "telemetry", "ack"]);
  });

  it("runs and acknowledges a repeated request id exactly once", async () => {
    const tasks = new AppShutdownTaskRegistry();
    const prepare = vi.fn().mockResolvedValue(undefined);
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    tasks.register("session", prepare);
    const handle = createAppShutdownRequestHandler(tasks, acknowledge);

    const first = handle(request);
    const repeated = handle(request);

    expect(repeated).toBe(first);
    await first;
    expect(prepare).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it("reports preparation failures and still acknowledges the request", async () => {
    const tasks = new AppShutdownTaskRegistry();
    tasks.register("session", async () => {
      throw new Error("database unavailable");
    });
    tasks.register("editor:tab-1", async () => {});
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    const handle = createAppShutdownRequestHandler(tasks, acknowledge);

    await handle(request);

    expect(acknowledge).toHaveBeenCalledWith(7, [
      "session: database unavailable",
    ]);
  });

  it("unregisters only the exact task instance", async () => {
    const tasks = new AppShutdownTaskRegistry();
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = tasks.register("editor:tab-1", first);
    const unregisterSecond = tasks.register("editor:tab-1", second);

    unregisterFirst();
    await tasks.prepareAll();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();

    unregisterSecond();
    await tasks.prepareAll();
    expect(second).toHaveBeenCalledOnce();
  });
});
