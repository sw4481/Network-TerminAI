import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  getStructured,
  autoParseBlock,
  createSnapshot,
  listSnapshots,
  renameSnapshot,
  deleteSnapshot,
  runAndParseOverSsh,
} from "./structured";

describe("structured.ts", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("getStructured returns the parsed payload", async () => {
    invokeMock.mockResolvedValue({
      blockId: "b1",
      parser: "textfsm",
      command: "show ip int br",
      vendor: "cisco",
      platform: "iosxe",
      data: [{ interface: "Gi1", ip: "10.0.0.1", status: "up" }],
      createdAt: 1747000000,
    });
    const r = await getStructured("b1");
    expect(invokeMock).toHaveBeenCalledWith("structured_get", { blockId: "b1" });
    expect(r?.parser).toBe("textfsm");
    expect(Array.isArray(r?.data)).toBe(true);
  });

  it("getStructured returns null for unparsed blocks", async () => {
    invokeMock.mockResolvedValue(null);
    const r = await getStructured("nope");
    expect(r).toBeNull();
  });

  it("autoParseBlock invokes structured_auto_parse with vendor/platform", async () => {
    invokeMock.mockResolvedValue(undefined);
    await autoParseBlock("b1", "cisco", "iosxe");
    expect(invokeMock).toHaveBeenCalledWith("structured_auto_parse", {
      blockId: "b1",
      vendor: "cisco",
      platform: "iosxe",
    });
  });

  it("runAndParseOverSsh forwards connection + command and returns block id", async () => {
    invokeMock.mockResolvedValue("ssh-adhoc-123");
    const blockId = await runAndParseOverSsh(
      "tab1",
      "conn1",
      "show version",
      "cisco",
      "iosxe",
      "password1",
    );
    expect(invokeMock).toHaveBeenCalledWith("structured_run_and_parse", {
      tabId: "tab1",
      connectionId: "conn1",
      command: "show version",
      vendor: "cisco",
      platform: "iosxe",
      password: "password1",
    });
    expect(blockId).toBe("ssh-adhoc-123");
  });

  it("runAndParseOverSsh works without a password (uses saved cred)", async () => {
    invokeMock.mockResolvedValue("ssh-adhoc-456");
    await runAndParseOverSsh("tab1", "conn1", "show ip int br", "cisco", "iosxe");
    expect(invokeMock).toHaveBeenCalledWith("structured_run_and_parse", {
      tabId: "tab1",
      connectionId: "conn1",
      command: "show ip int br",
      vendor: "cisco",
      platform: "iosxe",
      password: undefined,
    });
  });

  it("createSnapshot returns the new id", async () => {
    invokeMock.mockResolvedValue(42);
    const id = await createSnapshot("b1", "before-change");
    expect(invokeMock).toHaveBeenCalledWith("structured_snapshot_create", {
      blockId: "b1",
      name: "before-change",
    });
    expect(id).toBe(42);
  });

  it("listSnapshots returns the list", async () => {
    invokeMock.mockResolvedValue([
      {
        id: 1,
        tabId: "t1",
        name: "snap-1",
        parsedOutputId: 10,
        capturedAt: 0,
        command: "show ip int br",
        parser: "textfsm",
        vendor: "cisco",
        platform: "iosxe",
      },
    ]);
    const r = await listSnapshots("t1");
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("snap-1");
  });

  it("renameSnapshot invokes correct command", async () => {
    invokeMock.mockResolvedValue(undefined);
    await renameSnapshot(1, "new-name");
    expect(invokeMock).toHaveBeenCalledWith("structured_snapshot_rename", {
      id: 1,
      name: "new-name",
    });
  });

  it("deleteSnapshot invokes correct command", async () => {
    invokeMock.mockResolvedValue(undefined);
    await deleteSnapshot(1);
    expect(invokeMock).toHaveBeenCalledWith("structured_snapshot_delete", { id: 1 });
  });
});
