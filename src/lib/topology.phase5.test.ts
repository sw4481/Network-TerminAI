import { expect, it, vi } from "vitest";
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
import { openNeighbor } from "./topology";

it("does not resolve, open or offer to save a scoped logical routing identifier through the shared inline opener", async () => {
  const handlers = { onOpenSshTab: vi.fn(), onOpenNetconfTab: vi.fn(), onUnknownNeighbor: vi.fn() };
  invokeMock.mockResolvedValue(null);
  await openNeighbor({ graph_id: "lab", device_ref: "routing:" + "a".repeat(64), device_kind: "discovered", label: "Logical peer" }, handlers);
  expect(invokeMock).not.toHaveBeenCalled();
  expect(handlers.onOpenSshTab).not.toHaveBeenCalled();
  expect(handlers.onOpenNetconfTab).not.toHaveBeenCalled();
  expect(handlers.onUnknownNeighbor).not.toHaveBeenCalled();
});
