import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class<T> {
    onmessage?: (message: T) => void;
  },
}));

import { agentReactContinue } from "./tauri";

describe("agentReactContinue", () => {
  beforeEach(() => mocks.invoke.mockReset());

  it("continues the opaque checkpoint thread without resending a prompt", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    const onEvent = vi.fn();

    await agentReactContinue({
      threadId: "architect-run-1",
      streamOutput: true,
      onEvent,
    });

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "agent_react_resume",
      expect.objectContaining({
        threadId: "architect-run-1",
        decision: "continue",
        streamOutput: true,
      }),
    );
    const payload = mocks.invoke.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("message");
  });
});
