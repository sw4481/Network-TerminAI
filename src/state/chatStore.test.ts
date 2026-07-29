/**
 * Plan 12 Phase 5 — chatStore tests for the RAG sources flow.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useChatStore } from "./chatStore";
import type { RetrievedChunk } from "../lib/rag";

vi.mock("../lib/tauri", () => ({
  saveAiMessage: vi.fn(async () => {}),
}));

function resetStore() {
  useChatStore.setState({
    messages: {},
    streaming: {},
    error: {},
    pendingSources: {},
  });
}

function chunk(id: number): RetrievedChunk {
  return {
    chunk_id: id,
    document_id: 100 + id,
    document_title: `Doc ${id}`,
    chunk_idx: id,
    text: `text ${id}`,
    distance: 0.1,
    tags: ["generic"],
  };
}

describe("chatStore — sources flow (Plan 12 Phase 5)", () => {
  beforeEach(() => {
    resetStore();
  });

  it("attaches sources to the latest assistant message synchronously", () => {
    const key = "tab-1::general";
    useChatStore.getState().addMessage(key, {
      id: "u1",
      role: "user",
      content: "Hi",
      timestamp: 1,
    });
    useChatStore.getState().addMessage(key, {
      id: "a1",
      role: "assistant",
      content: "",
      timestamp: 2,
    });
    useChatStore
      .getState()
      .attachSourcesToInProgress(key, [chunk(1), chunk(2)]);
    const msgs = useChatStore.getState().messages[key];
    expect(msgs).toHaveLength(2);
    expect(msgs[1].sources).toHaveLength(2);
    expect(msgs[1].sources?.[0].document_title).toBe("Doc 1");
    // No pending stash should exist after immediate attach.
    expect(useChatStore.getState().pendingSources[key]).toBeUndefined();
  });

  it("stashes sources in pendingSources when no assistant message exists", () => {
    const key = "tab-1::general";
    useChatStore.getState().attachSourcesToInProgress(key, [chunk(1)]);
    expect(useChatStore.getState().pendingSources[key]).toHaveLength(1);
    expect(useChatStore.getState().messages[key]).toBeUndefined();
  });

  it("drains pendingSources and attaches them on first appendToken", () => {
    const key = "tab-1::general";
    // Sources event arrives first (race condition the store guards against).
    useChatStore.getState().attachSourcesToInProgress(key, [chunk(7)]);
    // Then the empty assistant bubble is appended.
    useChatStore.getState().addMessage(key, {
      id: "a1",
      role: "assistant",
      content: "",
      timestamp: 1,
    });
    // First token streams in.
    useChatStore.getState().appendToken(key, "Hello ");
    const msg = useChatStore.getState().messages[key][0];
    expect(msg.content).toBe("Hello ");
    expect(msg.sources).toHaveLength(1);
    expect(msg.sources?.[0].chunk_id).toBe(7);
    expect(useChatStore.getState().pendingSources[key]).toBeUndefined();
  });

  it("does NOT clobber existing sources when a token arrives after attach", () => {
    const key = "tab-1::general";
    useChatStore.getState().addMessage(key, {
      id: "a1",
      role: "assistant",
      content: "",
      timestamp: 1,
    });
    useChatStore.getState().attachSourcesToInProgress(key, [chunk(1)]);
    // Subsequent token must not overwrite the sources field.
    useChatStore.getState().appendToken(key, "tok");
    const msg = useChatStore.getState().messages[key][0];
    expect(msg.sources).toHaveLength(1);
    expect(msg.content).toBe("tok");
  });

  it("dropByTabPrefix clears pendingSources for that tab", () => {
    const key = "tab-1::general";
    useChatStore.getState().attachSourcesToInProgress(key, [chunk(1)]);
    useChatStore.getState().dropByTabPrefix("tab-1");
    expect(useChatStore.getState().pendingSources[key]).toBeUndefined();
  });

  it("clears pendingSources when the turn errors before any token", () => {
    const key = "tab-1::general";
    // Sources retrieved, then the sidecar fails before the assistant
    // bubble is created or any token streams.
    useChatStore.getState().attachSourcesToInProgress(key, [chunk(42)]);
    expect(useChatStore.getState().pendingSources[key]).toHaveLength(1);

    useChatStore.getState().setError(key, "boom");
    expect(useChatStore.getState().pendingSources[key]).toBeUndefined();

    // The user retries; a new assistant message must NOT inherit the
    // stale chunks from the failed turn.
    useChatStore.getState().addMessage(key, {
      id: "a-retry",
      role: "assistant",
      content: "",
      timestamp: 10,
    });
    useChatStore.getState().appendToken(key, "hi");
    const msg = useChatStore.getState().messages[key].at(-1)!;
    expect(msg.content).toBe("hi");
    expect(msg.sources).toBeUndefined();
  });

  it("clears pendingSources when a new user turn starts", () => {
    const key = "tab-1::general";
    useChatStore.getState().attachSourcesToInProgress(key, [chunk(13)]);
    expect(useChatStore.getState().pendingSources[key]).toHaveLength(1);

    useChatStore.getState().addMessage(key, {
      id: "u-new",
      role: "user",
      content: "new question",
      timestamp: 5,
    });
    expect(useChatStore.getState().pendingSources[key]).toBeUndefined();
  });

  it("clearError(key) does NOT touch pendingSources", () => {
    // setError(key, null) is the clearError path — it should be a
    // no-op for pendingSources, since clearing the error doesn't
    // imply the sources are stale.
    const key = "tab-1::general";
    useChatStore.getState().attachSourcesToInProgress(key, [chunk(99)]);
    useChatStore.getState().setError(key, null);
    expect(useChatStore.getState().pendingSources[key]).toHaveLength(1);
  });

  it("appendToken with no pending sources leaves the message sources untouched", () => {
    const key = "tab-1::general";
    useChatStore.getState().addMessage(key, {
      id: "a1",
      role: "assistant",
      content: "",
      timestamp: 1,
    });
    useChatStore.getState().appendToken(key, "hi");
    const msg = useChatStore.getState().messages[key][0];
    expect(msg.sources).toBeUndefined();
  });
});
