import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AI_CHAT_PREFERENCES_STORAGE_KEY,
  readAiChatPreferences,
  useAiChatPreferences,
} from "./useAiChatPreferences";

describe("useAiChatPreferences", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it("defaults streaming off and persists an opt-in", () => {
    const first = renderHook(() => useAiChatPreferences());
    expect(first.result.current.preferences.streamLlmOutput).toBe(false);

    act(() => {
      first.result.current.updatePreferences({ streamLlmOutput: true });
    });

    expect(first.result.current.preferences.streamLlmOutput).toBe(true);
    expect(JSON.parse(
      window.localStorage.getItem(AI_CHAT_PREFERENCES_STORAGE_KEY) ?? "{}",
    )).toEqual({ streamLlmOutput: true });

    first.unmount();
    const second = renderHook(() => useAiChatPreferences());
    expect(second.result.current.preferences.streamLlmOutput).toBe(true);
  });

  it("falls back safely when stored data is malformed", () => {
    window.localStorage.setItem(AI_CHAT_PREFERENCES_STORAGE_KEY, "not-json");
    expect(readAiChatPreferences()).toEqual({ streamLlmOutput: false });
  });
});
