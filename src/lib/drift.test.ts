import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  intentCreate,
  intentList,
  intentUpdateBody,
  intentDelete,
  type IntentTemplate,
} from "./drift";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => mockInvoke.mockReset());

describe("drift intent API", () => {
  it("creates with id stripped + returns generated id", async () => {
    mockInvoke.mockResolvedValue("uuid-1");
    const id = await intentCreate({
      name: "t",
      vendor: "cisco",
      platform: "iosxe",
      kind: "golden",
      body: "",
      vars_yaml: "",
      selector: { device_ids: [], tags: [] },
      match_mode: "baseline",
    });
    expect(id).toBe("uuid-1");
    const callArgs = mockInvoke.mock.calls[0][1] as { tpl: IntentTemplate };
    expect(callArgs.tpl.id).toBe("");
  });

  it("lists with optional vendor/platform filter", async () => {
    mockInvoke.mockResolvedValue([]);
    await intentList("cisco", "iosxe");
    expect(mockInvoke).toHaveBeenCalledWith("intent_list", {
      vendor: "cisco",
      platform: "iosxe",
    });
  });

  it("update_body passes camelCase varsYaml-style key", async () => {
    mockInvoke.mockResolvedValue(undefined);
    await intentUpdateBody("id-1", "hostname x");
    expect(mockInvoke).toHaveBeenCalledWith("intent_update_body", {
      id: "id-1",
      body: "hostname x",
    });
  });

  it("delete invokes intent_delete", async () => {
    mockInvoke.mockResolvedValue(undefined);
    await intentDelete("id-1");
    expect(mockInvoke).toHaveBeenCalledWith("intent_delete", { id: "id-1" });
  });
});
