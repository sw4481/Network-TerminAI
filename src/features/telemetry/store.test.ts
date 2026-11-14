import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelemetryWorkspaceStore } from "./store";
import { appPreflightGuards } from "../../lib/appShutdown";
import type { TelemetryApi } from "./api";
import type { TelemetrySnapshot } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const snapshot = (
  generation = 1,
  sequence = 0,
  running = false,
): TelemetrySnapshot => ({
  workspace_id: "one",
  generation,
  sequence,
  running,
  targets: [],
  widgets: [],
  series: [],
  diagnostics: [],
});
function fixture() {
  const api = {
    establish: vi.fn().mockResolvedValue(snapshot()),
    snapshot: vi.fn().mockResolvedValue(snapshot()),
    start: vi.fn().mockResolvedValue(snapshot(2, 0, true)),
    stop: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    widget: vi.fn(),
    apply: vi.fn(),
    select: vi.fn(),
  };
  const unregister = vi.fn();
  const register = vi.fn(() => unregister);
  const store = new TelemetryWorkspaceStore(
    api as unknown as TelemetryApi,
    register,
  );
  return { store, api, register, unregister };
}
describe("Telemetry workspace ownership", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it.each(["update", "quit"] as const)("post-approved %s authority cannot be consumed by tab close", async (purpose) => {
    const { store, api, register } = fixture(); await store.establish("one");
    const draft = { widgets_yaml: "exact invalid raw YAML", layouts_yaml: "exact layout draft", templates: { custom: "invalid template" } };
    const freeze = vi.fn(), confirm = vi.fn(() => true);
    store.registerDraft("one", { dirty: () => true, identity: () => draft, freeze }, confirm);
    const approval = await appPreflightGuards.acquire(undefined, purpose);
    try {
    if (purpose === "update") await approval!.prepareUpdate();
    const ownerSnapshot = store.state.getState().workspaces.one.snapshot;
    await expect(store.close("one")).rejects.toThrow("decision in progress");
    expect(api.close).not.toHaveBeenCalled(); expect(store.state.getState().workspaces.one.snapshot).toBe(ownerSnapshot);
    expect(draft.widgets_yaml).toBe("exact invalid raw YAML"); expect(confirm).toHaveBeenCalledOnce();
    if (purpose === "quit") {
      await expect(approval!.prepareUpdate()).rejects.toThrow("approval");
      await register.mock.calls[0][1]();
      expect(api.close).toHaveBeenCalledOnce(); expect(store.state.getState().workspaces.one).toBeUndefined();
    } else {
      await expect(register.mock.calls[0][1]()).rejects.toThrow("approval");
      expect(api.close).not.toHaveBeenCalled();
      approval!.release();
      expect(store.state.getState().workspaces.one.frozen).toBe(false);
      expect(store.state.getState().workspaces.one.snapshot).toBe(ownerSnapshot);
      expect(draft.templates.custom).toBe("invalid template");
      await store.close("one"); expect(confirm).toHaveBeenCalledTimes(2);
    }
    } finally { approval!.release(); }
  });
  it("intentional confirmed app cleanup closes an owner whose Studio never opened", async () => {
    const { store, api, register } = fixture(); await store.establish("one");
    const approval = await appPreflightGuards.acquire(undefined, "quit");
    await register.mock.calls[0][1]();
    expect(api.close).toHaveBeenCalledOnce(); expect(store.state.getState().workspaces.one).toBeUndefined(); approval!.release();
    expect(store.state.getState().workspaces.one).toBeUndefined();
  });
  it("dirty tab cancel and failed Close preserve raw draft and operational ownership", async () => {
    const { store, api } = fixture(); await store.establish("one");
    const freeze = vi.fn(), draft = { widgets_yaml: "invalid raw draft" };
    const confirm = vi.fn().mockReturnValue(false);
    store.registerDraft("one", { dirty: () => true, identity: () => draft, freeze }, confirm);
    await expect(store.close("one")).rejects.toThrow("canceled");
    expect(api.close).not.toHaveBeenCalled(); expect(store.state.getState().workspaces.one.closing).toBe(false);
    confirm.mockReturnValue(true); api.close.mockRejectedValueOnce(new Error("cleanup pending"));
    await expect(store.close("one")).rejects.toThrow("cleanup pending");
    expect(draft.widgets_yaml).toBe("invalid raw draft"); expect(freeze).toHaveBeenLastCalledWith(false);
    expect(store.state.getState().workspaces.one.frozen).toBe(false);
  });
  it("stale draft identity and concurrent close paths cannot reuse an approval", async () => {
    const { store, api } = fixture(); await store.establish("one");
    const answer = deferred<boolean>(), freeze = vi.fn(); let identity = {};
    store.registerDraft("one", { dirty: () => true, identity: () => identity, freeze }, () => answer.promise);
    const closing = store.close("one");
    await expect(appPreflightGuards.acquire()).rejects.toThrow("already in progress");
    await expect(store.close("one")).rejects.toThrow("decision in progress");
    identity = {}; answer.resolve(true);
    await expect(closing).rejects.toThrow("canceled");
    expect(api.close).not.toHaveBeenCalled(); expect(freeze).toHaveBeenLastCalledWith(false);
  });
  it("keeps controls busy until the final queued lifecycle operation settles", async () => {
    const { store, api } = fixture();
    await store.establish("one");
    const start = deferred<TelemetrySnapshot>(),
      stop = deferred<void>();
    api.start.mockReturnValueOnce(start.promise);
    api.stop.mockReturnValueOnce(stop.promise);
    const starting = store.start({
      workspace_id: "one",
      targets: [],
      local_enabled: true,
      monitored_interfaces: {},
    });
    await vi.advanceTimersByTimeAsync(0);
    const stopping = store.stop("one");
    start.resolve(snapshot(2, 0, true));
    await starting;
    expect(store.state.getState().workspaces.one.busy).toBe(true);
    stop.resolve();
    await stopping;
    expect(store.state.getState().workspaces.one.busy).toBe(false);
    await store.close("one");
  });
  it("cancels a queued control when Close starts while awaiting active work", async () => {
    const { store, api } = fixture();
    await store.establish("one");
    const start = deferred<TelemetrySnapshot>();
    api.start.mockReturnValueOnce(start.promise);
    const starting = store.start({
      workspace_id: "one",
      targets: [],
      local_enabled: true,
      monitored_interfaces: {},
    });
    await vi.advanceTimersByTimeAsync(0);
    const stopping = store.stop("one");
    const rejected = expect(stopping).rejects.toThrow(/closing/);
    const closing = store.close("one");
    start.resolve(snapshot(2, 0, true));
    await starting;
    await rejected;
    await closing;
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.close).toHaveBeenCalledOnce();
    expect(store.state.getState().workspaces.one).toBeUndefined();
  });
  it("establishes once without Start, and polls once per second without subscribers", async () => {
    const { store, api, register } = fixture();
    await Promise.all([store.establish("one"), store.establish("one")]);
    expect(api.establish).toHaveBeenCalledOnce();
    expect(api.start).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith(
      "telemetry:one",
      expect.any(Function),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(api.snapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.snapshot).toHaveBeenCalledOnce();
    await store.close("one");
  });
  it("fences a late snapshot across Start and ignores lower generation/sequence", async () => {
    const { store, api } = fixture();
    await store.establish("one");
    const old = deferred<TelemetrySnapshot>();
    api.snapshot.mockReturnValueOnce(old.promise);
    await vi.advanceTimersByTimeAsync(1000);
    await store.start({
      workspace_id: "one",
      targets: [],
      local_enabled: true,
      monitored_interfaces: {},
    });
    old.resolve(snapshot(1, 99));
    await Promise.resolve();
    expect(store.state.getState().workspaces.one.snapshot?.generation).toBe(2);
    api.snapshot.mockResolvedValue(snapshot(1, 100));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.state.getState().workspaces.one.snapshot?.running).toBe(true);
    await store.close("one");
  });
  it("awaits establishment before Close, ignores its late reply, and disposes only after acknowledgement", async () => {
    const { store, api, unregister } = fixture();
    const establishing = deferred<TelemetrySnapshot>(),
      closing = deferred<void>();
    api.establish.mockReturnValueOnce(establishing.promise);
    api.close.mockReturnValueOnce(closing.promise);
    const ready = store.establish("one");
    const close = store.close("one");
    await Promise.resolve();
    expect(api.close).not.toHaveBeenCalled();
    establishing.resolve(snapshot());
    await ready;
    await Promise.resolve();
    expect(store.state.getState().workspaces.one.snapshot).toBeNull();
    expect(unregister).not.toHaveBeenCalled();
    closing.resolve();
    await close;
    expect(store.state.getState().workspaces.one).toBeUndefined();
    expect(unregister).toHaveBeenCalledOnce();
  });
  it("retains failed Close for retry and never restarts its polling", async () => {
    const { store, api, unregister } = fixture();
    await store.establish("one");
    api.close.mockRejectedValueOnce(new Error("cleanup pending"));
    await expect(store.close("one")).rejects.toThrow("cleanup pending");
    expect(store.state.getState().workspaces.one.error).toContain(
      "cleanup pending",
    );
    expect(unregister).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.snapshot).not.toHaveBeenCalled();
    await store.close("one");
  });
  it("backs off transport failures and exposes them without claiming monitoring", async () => {
    const { store, api } = fixture();
    await store.establish("one");
    api.snapshot.mockRejectedValueOnce(new Error("transport offline"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.state.getState().workspaces.one.error).toContain(
      "transport offline",
    );
    await vi.advanceTimersByTimeAsync(1999);
    expect(api.snapshot).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.snapshot).toHaveBeenCalledTimes(2);
    await store.close("one");
  });
  it("checks native generation and revision on private replies, including late parallel reads", async () => {
    const { store } = fixture();
    await store.establish("one");
    const envelope = {
      workspace_id: "one",
      generation: 1,
      sequence: 0,
      revision: "source",
      value: ["private"],
    };
    await expect(
      store.read(
        "one",
        "series",
        async () => ({ ...envelope, generation: 2 }),
        "source",
      ),
    ).rejects.toThrow(/obsolete/);
    await expect(
      store.read("one", "series", async () => envelope, "other"),
    ).rejects.toThrow(/obsolete/);
    const old = deferred<typeof envelope>();
    const first = store.read("one", "catalog", () => old.promise);
    await store.read("one", "catalog", async () => envelope);
    old.resolve(envelope);
    await expect(first).rejects.toThrow(/obsolete/);
    await store.close("one");
  });
  it("rejects a private reply after Close begins and keeps one pending refresh across controls", async () => {
    const { store, api } = fixture();
    await store.establish("one");
    const old = deferred<TelemetrySnapshot>();
    api.snapshot.mockReturnValueOnce(old.promise);
    await vi.advanceTimersByTimeAsync(1000);
    const read = deferred<{
      workspace_id: string;
      generation: number;
      sequence: number;
      revision: string;
      value: string;
    }>();
    const privateRead = store.read("one", "catalog", () => read.promise);
    await store.start({
      workspace_id: "one",
      targets: [],
      local_enabled: true,
      monitored_interfaces: {},
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(api.snapshot).toHaveBeenCalledOnce();
    const closing = store.close("one");
    read.resolve({
      workspace_id: "one",
      generation: 1,
      sequence: 0,
      revision: "base",
      value: "private",
    });
    await expect(privateRead).rejects.toThrow(/obsolete/);
    await closing;
    old.resolve(snapshot());
    await Promise.resolve();
    expect(store.state.getState().workspaces.one).toBeUndefined();
  });
  it("keeps offset pages tied to one observed table, even when generation/revision stay equal", async () => {
    const { store, api } = fixture();
    const metadata = {
      workspace_id: "one",
      target_id: "local",
      widget_id: "cpu",
      generation: 1,
      revision: "source",
      observed_at_ms: 10,
      last_success_at_ms: 10,
      state: "fresh" as const,
      severity: "ok" as const,
      units: {},
      row_count: 2,
      diagnostics: [],
    };
    api.establish.mockResolvedValue({ ...snapshot(), widgets: [metadata] });
    await store.establish("one");
    const response = {
      workspace_id: "one",
      generation: 1,
      sequence: 0,
      revision: "source",
      value: { metadata, rows: [], next_offset: 1 },
    };
    api.widget.mockResolvedValue(response);
    const query = {
      workspace_id: "one",
      target_id: "local",
      widget_id: "cpu",
      offset: 0,
      limit: 1,
    };
    const first = await store.widget(query, "source");
    api.widget.mockResolvedValue({
      ...response,
      value: {
        ...response.value,
        metadata: { ...metadata, observed_at_ms: 11 },
      },
    });
    await expect(
      store.widget({ ...query, offset: 1 }, "source", first.value.metadata),
    ).rejects.toThrow(/table changed/);
    await store.close("one");
  });
  it.each([false, true])(
    "rejects a first page from a different retained observation, snapshot advances while pending=%s",
    async (advanceSnapshot) => {
      const { store, api } = fixture();
      const metadata = {
        workspace_id: "one",
        target_id: "local",
        widget_id: "cpu",
        generation: 1,
        revision: "source",
        observed_at_ms: 10,
        last_success_at_ms: 10,
        state: "fresh" as const,
        severity: "ok" as const,
        units: {},
        row_count: 1,
        diagnostics: [],
      };
      api.establish.mockResolvedValue({ ...snapshot(), widgets: [metadata] });
      await store.establish("one");
      const changed = {
        ...metadata,
        observed_at_ms: 11,
        last_success_at_ms: 11,
      };
      const page = deferred<{
        workspace_id: string;
        generation: number;
        sequence: number;
        revision: string;
        value: { metadata: typeof metadata; rows: []; next_offset: null };
      }>();
      api.widget.mockReturnValueOnce(page.promise);
      const pending = store.widget(
        {
          workspace_id: "one",
          target_id: "local",
          widget_id: "cpu",
          offset: 0,
          limit: 1,
        },
        "source",
      );
      if (advanceSnapshot) {
        api.snapshot.mockResolvedValue({
          ...snapshot(1, 1),
          widgets: [changed],
        });
        await vi.advanceTimersByTimeAsync(1000);
        expect(
          store.state.getState().workspaces.one.snapshot?.widgets[0]
            .observed_at_ms,
        ).toBe(11);
      }
      page.resolve({
        workspace_id: "one",
        generation: 1,
        sequence: advanceSnapshot ? 0 : 1,
        revision: "source",
        value: {
          metadata: advanceSnapshot ? metadata : changed,
          rows: [],
          next_offset: null,
        },
      });
      await expect(pending).rejects.toThrow(/table changed/);
      await store.close("one");
    },
  );
  it("preserves stopped retained frame identity separately from current owner/source authority", async () => {
    const { store, api } = fixture();
    const metadata = {
      workspace_id: "one",
      target_id: "local",
      widget_id: "cpu",
      generation: 1,
      revision: "old-source",
      observed_at_ms: 10,
      last_success_at_ms: 10,
      state: "stopped" as const,
      severity: "ok" as const,
      units: {},
      row_count: 1,
      diagnostics: [],
    };
    api.establish.mockResolvedValue({ ...snapshot(2), widgets: [metadata] });
    await store.establish("one");
    api.widget.mockResolvedValue({
      workspace_id: "one",
      generation: 2,
      sequence: 0,
      revision: "current-source",
      value: { metadata, rows: [], next_offset: null },
    });
    const page = await store.widget(
      {
        workspace_id: "one",
        target_id: "local",
        widget_id: "cpu",
        offset: 0,
        limit: 1,
      },
      "current-source",
    );
    expect(page.revision).toBe("current-source");
    expect(page.value.metadata.revision).toBe("old-source");
    expect(page.value.metadata.generation).toBe(1);
    await store.close("one");
  });
  it("fences private reads across explicit authoring selection and a generation-changing Apply", async () => {
    const { store, api } = fixture();
    await store.establish("one");
    api.select.mockResolvedValue(snapshot());
    await store.select("one", { connection_id: "device", platform: "iosxe" });
    const old = deferred<{
      workspace_id: string;
      generation: number;
      sequence: number;
      revision: string;
      value: string;
    }>();
    const pending = store.read("one", "catalog", () => old.promise);
    const draft = {
      scope: "local" as const,
      widgets_yaml: "",
      layouts_yaml: "",
      templates: {},
      expected_revision: "old-base",
    };
    const token = {
      id: "token",
      draft_hash: "draft",
      base_revision: "old-base",
      sample_hashes: {},
      expires_at_ms: 10,
    };
    api.apply.mockResolvedValue({
      workspace_id: "one",
      generation: 2,
      sequence: 0,
      revision: "new-base",
      value: {
        revision: "new-base",
        affected_targets: ["local"],
        masked_device_overrides: [],
      },
    });
    api.apply.mockResolvedValueOnce({
      workspace_id: "one",
      generation: 0,
      sequence: 0,
      revision: "new-base",
      value: {
        revision: "new-base",
        affected_targets: ["local"],
        masked_device_overrides: [],
      },
    });
    await expect(store.apply("one", draft, token)).rejects.toThrow(/obsolete/);
    api.snapshot.mockResolvedValue(snapshot(2));
    const applied = await store.apply("one", draft, token);
    expect(applied.value.revision).toBe("new-base");
    old.resolve({
      workspace_id: "one",
      generation: 1,
      sequence: 0,
      revision: "old-base",
      value: "private",
    });
    await expect(pending).rejects.toThrow(/obsolete/);
    expect(store.state.getState().workspaces.one.snapshot?.generation).toBe(2);
    await store.close("one");
  });
  it("shows the native sanitized message when Close rejects with a Diagnostic", async () => {
    const { store, api } = fixture();
    await store.establish("one");
    api.close.mockRejectedValueOnce({
      code: "cleanup_pending",
      message: "Cleanup remains owned",
    });
    await expect(store.close("one")).rejects.toEqual({
      code: "cleanup_pending",
      message: "Cleanup remains owned",
    });
    expect(store.state.getState().workspaces.one.error).toBe(
      "Cleanup remains owned",
    );
    await store.close("one");
  });
});
