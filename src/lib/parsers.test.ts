import { describe, it, expect, vi } from "vitest";
import { parseShow } from "./parsers";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({ parser: "genie", data: { version: "17.09.04" }, from_cache: false })),
}));

describe("parseShow", () => {
  it("invokes the parse_show Tauri command and returns typed data", async () => {
    const r = await parseShow({ vendor: "cisco", platform: "iosxe", command: "show version", raw: "..." });
    expect(r.parser).toBe("genie");
    expect(r.data.version).toBe("17.09.04");
  });
});
