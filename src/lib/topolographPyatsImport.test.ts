import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: invokeMock,
}));

import { pyatsListSupportedDevices, topolographImportLsdbFromPyats } from "./tauri";

describe("topolographImportLsdbFromPyats", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue({
      ok: true,
      message: "LSDB collected and uploaded.",
      bytes: 128,
      warnings: [],
    });
  });

  it("invokes the dedicated command with only the typed request envelope", async () => {
    const request = {
      device: "CORE1",
      protocol: "ospfv3" as const,
      description: null,
    };

    await topolographImportLsdbFromPyats(request);

    expect(invokeMock).toHaveBeenCalledWith(
      "topolograph_import_lsdb_from_pyats",
      { request },
    );
  });

  it("loads the bounded saved pyATS device catalog", async () => {
    invokeMock.mockResolvedValue([
      { name: "CORE1", os: "iosxe" },
      { name: "EDGE1", os: "nxos" },
    ]);

    await expect(pyatsListSupportedDevices()).resolves.toEqual([
      { name: "CORE1", os: "iosxe" },
      { name: "EDGE1", os: "nxos" },
    ]);

    expect(invokeMock).toHaveBeenCalledWith("pyats_list_supported_devices");
  });
});
