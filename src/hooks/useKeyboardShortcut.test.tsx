import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useKeyboardShortcut } from "./useKeyboardShortcut";

function Harness({ onHit }: { onHit: () => void }) {
  useKeyboardShortcut("d", onHit, { cmd: true });
  return null;
}

describe("useKeyboardShortcut", () => {
  it("ignores a key event already consumed by a focused editor", () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    const onHit = vi.fn();
    render(<Harness onHit={onHit} />);

    const event = new KeyboardEvent("keydown", {
      key: "d",
      metaKey: true,
      cancelable: true,
    });
    event.preventDefault();
    window.dispatchEvent(event);

    expect(onHit).not.toHaveBeenCalled();
  });
});
