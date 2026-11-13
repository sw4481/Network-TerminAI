import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the Tauri plugins before importing the store.
const checkMock = vi.fn();
const relaunchMock = vi.fn(async () => {});
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: () => checkMock(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: () => relaunchMock(),
}));

import { useUpdateStore } from "./updateStore";
import { appPreflightGuards, type AppCloseLease } from "../lib/appShutdown";
const acquire = appPreflightGuards.acquire.bind(appPreflightGuards);
let approval: AppCloseLease | null = null;

const resetStore = () =>
  useUpdateStore.setState({
    available: null,
    checking: false,
    downloading: false,
    dismissed: false,
    error: null,
    lastCheckedAt: null,
    _handle: null,
  });

describe("updateStore", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    vi.spyOn(appPreflightGuards, "acquire").mockImplementation(async (...args) => { approval = await acquire(...args); return approval; });
  });
  afterEach(() => { approval?.release(); approval = null; vi.restoreAllMocks(); });

  it("populates `available` when an update is found", async () => {
    checkMock.mockResolvedValueOnce({
      version: "1.1.0",
      currentVersion: "1.0.0",
      date: "2026-07-22",
      body: "Bug fixes",
      downloadAndInstall: vi.fn(async () => {}),
    });

    await useUpdateStore.getState().checkForUpdate(false);

    const s = useUpdateStore.getState();
    expect(s.available).toEqual({
      version: "1.1.0",
      currentVersion: "1.0.0",
      date: "2026-07-22",
      body: "Bug fixes",
    });
    expect(s.checking).toBe(false);
    expect(s.lastCheckedAt).not.toBeNull();
  });

  it("leaves `available` null when up to date", async () => {
    checkMock.mockResolvedValueOnce(null);

    await useUpdateStore.getState().checkForUpdate(false);

    const s = useUpdateStore.getState();
    expect(s.available).toBeNull();
    expect(s.lastCheckedAt).not.toBeNull();
  });

  it("swallows check errors for automatic checks but surfaces them for manual", async () => {
    checkMock.mockRejectedValueOnce(new Error("network down"));
    await useUpdateStore.getState().checkForUpdate(false);
    expect(useUpdateStore.getState().error).toBeNull();

    checkMock.mockRejectedValueOnce(new Error("network down"));
    await useUpdateStore.getState().checkForUpdate(true);
    expect(useUpdateStore.getState().error).toBe("network down");
  });

  it("downloads, installs, and relaunches using the held handle", async () => {
    const downloadAndInstall = vi.fn(async () => {});
    checkMock.mockResolvedValueOnce({
      version: "1.1.0",
      currentVersion: "1.0.0",
      downloadAndInstall,
    });

    await useUpdateStore.getState().checkForUpdate(false);
    await useUpdateStore.getState().downloadAndInstall();

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
    // check() called once (during checkForUpdate); install reused the handle.
    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it("dismiss() hides the toast without clearing availability", async () => {
    checkMock.mockResolvedValueOnce({
      version: "1.1.0",
      currentVersion: "1.0.0",
      downloadAndInstall: vi.fn(),
    });
    await useUpdateStore.getState().checkForUpdate(false);

    useUpdateStore.getState().dismiss();

    expect(useUpdateStore.getState().dismissed).toBe(true);
    expect(useUpdateStore.getState().available).not.toBeNull();
  });

  it("canceled update preserves owners and never reaches installer or relaunch", async () => {
    const install = vi.fn(), cleanup = vi.fn(), release = vi.fn();
    const unregister = appPreflightGuards.register("cancel-test", () => ({ confirm: async () => false, release, prepareUpdate: cleanup }));
    useUpdateStore.setState({ _handle: { downloadAndInstall: install } as never });
    await useUpdateStore.getState().downloadAndInstall();
    expect(install).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled(); expect(relaunchMock).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
    expect(useUpdateStore.getState().error).toBeNull(); unregister();
  });
  it("awaits actual cleanup before install and releases stopped recoverable ownership on failure", async () => {
    const order: string[] = [], release = vi.fn();
    const unregister = appPreflightGuards.register("failure-test", () => ({ confirm: async () => true, release, prepareUpdate: async () => { order.push("stopped"); } }));
    useUpdateStore.setState({ _handle: { downloadAndInstall: async () => { order.push("install"); throw new Error("install failed"); } } as never });
    await useUpdateStore.getState().downloadAndInstall();
    expect(order).toEqual(["stopped", "install"]); expect(release).toHaveBeenCalledOnce(); expect(relaunchMock).not.toHaveBeenCalled(); unregister();
  });
  it("aborts installation when actual Telemetry cleanup fails", async () => {
    const release = vi.fn(), install = vi.fn();
    const unregister = appPreflightGuards.register("cleanup-failure-test", () => ({ confirm: async () => true, release, prepareUpdate: async () => { throw new Error("Telemetry cleanup pending"); } }));
    useUpdateStore.setState({ _handle: { downloadAndInstall: install } as never });
    await useUpdateStore.getState().downloadAndInstall();
    expect(install).not.toHaveBeenCalled(); expect(relaunchMock).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
    expect(useUpdateStore.getState().error).toBe("Telemetry cleanup pending"); unregister();
  });
});
