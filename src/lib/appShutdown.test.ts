import { describe, expect, it, vi } from "vitest";
import {
  AppShutdownTaskRegistry,
  createAppShutdownRequestHandler,
  type AppShutdownPrepare,
} from "./appShutdown";

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
    await pending;
    expect(order).toEqual(["session", "editor", "ack"]);
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
