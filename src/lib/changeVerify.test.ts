import { describe, it, expect, vi } from "vitest";
import { bundleList, bundleCreate } from "./changeVerify";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: any) => {
    if (cmd === "bundle_create") return { id: "b1", commands: args.new.commands,
      name: args.new.name, description: args.new.description ?? null,
      vendor: args.new.vendor, platform: args.new.platform,
      created_at: 1, updated_at: 1 };
    if (cmd === "bundle_list") return [];
    throw new Error("unexpected command " + cmd);
  }),
}));

describe("changeVerify client", () => {
  it("bundleCreate passes payload through", async () => {
    const b = await bundleCreate({
      name: "x", description: null, vendor: "cisco", platform: "iosxe",
      commands: ["show version"],
    });
    expect(b.id).toBe("b1");
    expect(b.commands).toEqual(["show version"]);
  });
  it("bundleList returns empty", async () => {
    expect(await bundleList()).toEqual([]);
  });
});
