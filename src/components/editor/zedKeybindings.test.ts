import { emit } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import { installZedKeybindings } from "./zedKeybindings";

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));

const key = {
  KeyP: 1,
  KeyD: 2,
  KeyL: 3,
  KeyT: 4,
  UpArrow: 5,
  DownArrow: 6,
};
const mod = { CtrlCmd: 1 << 8, Shift: 1 << 9, Alt: 1 << 10 };
const containers: HTMLElement[] = [];
const windowKeyListeners: Array<(event: KeyboardEvent) => void> = [];

function setPlatform(value: string) {
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value,
  });
}

function listenToWindow(listener: (event: KeyboardEvent) => void) {
  window.addEventListener("keydown", listener);
  windowKeyListeners.push(listener);
}

function harness() {
  const actionDisposers: Array<ReturnType<typeof vi.fn>> = [];
  const actions: Monaco.editor.IActionDescriptor[] = [];
  const runBuiltIn = vi.fn().mockResolvedValue(undefined);
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);

  const editor = {
    addAction: vi.fn((action: Monaco.editor.IActionDescriptor) => {
      actions.push(action);
      const dispose = vi.fn();
      actionDisposers.push(dispose);
      return { dispose };
    }),
    getAction: vi.fn(() => ({ run: runBuiltIn })),
    getContainerDomNode: vi.fn(() => container),
  } as unknown as Monaco.editor.IStandaloneCodeEditor;

  const monaco = {
    KeyCode: key,
    KeyMod: mod,
  } as unknown as typeof Monaco;

  return {
    editor,
    monaco,
    container,
    actions,
    actionDisposers,
    runBuiltIn,
  };
}

function actionById(
  actions: Monaco.editor.IActionDescriptor[],
  id: string,
): Monaco.editor.IActionDescriptor {
  const action = actions.find((candidate) => candidate.id === id);
  if (!action) throw new Error(`Missing action: ${id}`);
  return action;
}

function keyboardEvent(
  init: KeyboardEventInit & { key: string; code?: string },
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

describe("installZedKeybindings", () => {
  beforeEach(() => {
    vi.mocked(emit).mockReset().mockResolvedValue(undefined);
    setPlatform("MacIntel");
  });

  afterEach(() => {
    for (const listener of windowKeyListeners.splice(0)) {
      window.removeEventListener("keydown", listener);
    }
    for (const container of containers.splice(0)) {
      container.remove();
    }
  });

  it("registers exactly the approved actions and bindings", () => {
    const h = harness();
    installZedKeybindings(h.editor, h.monaco);

    expect(
      Object.fromEntries(
        h.actions.map((action) => [action.id, action.keybindings]),
      ),
    ).toEqual({
      "ccie.zed.commandPalette": [mod.CtrlCmd | mod.Shift | key.KeyP],
      "ccie.zed.workspaceSymbols": [mod.CtrlCmd | key.KeyT],
      "ccie.zed.addSelectionNext": [mod.CtrlCmd | key.KeyD],
      "ccie.zed.cursorAbove": [mod.CtrlCmd | mod.Alt | key.UpArrow],
      "ccie.zed.cursorBelow": [mod.CtrlCmd | mod.Alt | key.DownArrow],
      "ccie.zed.moveLineUp": [mod.Alt | key.UpArrow],
      "ccie.zed.moveLineDown": [mod.Alt | key.DownArrow],
      "ccie.zed.duplicateLineUp": [mod.Alt | mod.Shift | key.UpArrow],
      "ccie.zed.duplicateLineDown": [mod.Alt | mod.Shift | key.DownArrow],
    });
  });

  it("does not register Cmd+Shift+L", () => {
    const h = harness();
    installZedKeybindings(h.editor, h.monaco);

    const forbidden = mod.CtrlCmd | mod.Shift | key.KeyL;
    const allBindings = h.actions.flatMap((action) => action.keybindings ?? []);
    expect(allBindings).not.toContain(forbidden);
  });

  it("bridges the command palette and preserves a rejected emit", async () => {
    const h = harness();
    installZedKeybindings(h.editor, h.monaco);
    const palette = actionById(h.actions, "ccie.zed.commandPalette");

    await palette.run(h.editor);
    expect(emit).toHaveBeenCalledWith("menu:open_palette");

    const failure = new Error("palette unavailable");
    vi.mocked(emit).mockRejectedValueOnce(failure);
    await expect(palette.run(h.editor)).rejects.toBe(failure);
  });

  it("bridges the project-symbol shortcut to the editor workspace", async () => {
    const h = harness();
    const listener = vi.fn();
    window.addEventListener("ccie:open-workspace-symbol-search", listener);
    installZedKeybindings(h.editor, h.monaco);

    await actionById(h.actions, "ccie.zed.workspaceSymbols").run(h.editor);
    expect(listener).toHaveBeenCalledOnce();

    window.removeEventListener("ccie:open-workspace-symbol-search", listener);
  });

  it.each([
    ["ccie.zed.addSelectionNext", "editor.action.addSelectionToNextFindMatch"],
    ["ccie.zed.cursorAbove", "editor.action.insertCursorAbove"],
    ["ccie.zed.cursorBelow", "editor.action.insertCursorBelow"],
    ["ccie.zed.moveLineUp", "editor.action.moveLinesUpAction"],
    ["ccie.zed.moveLineDown", "editor.action.moveLinesDownAction"],
    ["ccie.zed.duplicateLineUp", "editor.action.copyLinesUpAction"],
    ["ccie.zed.duplicateLineDown", "editor.action.copyLinesDownAction"],
  ])("runs %s through Monaco action %s", async (zedId, monacoId) => {
    const h = harness();
    installZedKeybindings(h.editor, h.monaco);

    await actionById(h.actions, zedId).run(h.editor);

    expect(h.editor.getAction).toHaveBeenCalledWith(monacoId);
    expect(h.runBuiltIn).toHaveBeenCalledOnce();
  });

  it("treats a missing Monaco action as a no-op", async () => {
    const h = harness();
    vi.mocked(h.editor.getAction).mockReturnValue(null);
    installZedKeybindings(h.editor, h.monaco);

    await expect(
      actionById(h.actions, "ccie.zed.addSelectionNext").run(h.editor),
    ).resolves.toBeUndefined();
  });

  it("lets Monaco dispatch an owned action before stopping window handlers", () => {
    const h = harness();
    const order: string[] = [];
    const preventedAtMonaco: boolean[] = [];
    h.container.addEventListener("keydown", (event) => {
      order.push("monaco");
      preventedAtMonaco.push(event.defaultPrevented);
      void actionById(h.actions, "ccie.zed.addSelectionNext").run(h.editor);
    });
    installZedKeybindings(h.editor, h.monaco);
    const onWindowKeyDown = vi.fn(() => order.push("window"));
    listenToWindow(onWindowKeyDown);
    const event = keyboardEvent({
      key: "d",
      code: "KeyD",
      metaKey: true,
    });

    h.container.dispatchEvent(event);

    expect(order).toEqual(["monaco"]);
    expect(preventedAtMonaco).toEqual([false]);
    expect(h.runBuiltIn).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(onWindowKeyDown).not.toHaveBeenCalled();
  });

  it.each([
    [
      "physical KeyP code",
      { key: "Unidentified", code: "KeyP", metaKey: true, shiftKey: true },
    ],
    ["P key fallback", { key: "P", code: "", metaKey: true, shiftKey: true }],
    [
      "physical KeyD code",
      { key: "Unidentified", code: "KeyD", metaKey: true },
    ],
    ["D key fallback", { key: "d", code: "", metaKey: true }],
    ["T key fallback", { key: "t", code: "", metaKey: true }],
    [
      "physical ArrowUp code",
      { key: "Unidentified", code: "ArrowUp", altKey: true },
    ],
    ["ArrowDown key fallback", { key: "ArrowDown", code: "", altKey: true }],
  ])("recognizes an owned chord from its %s", (_name, init) => {
    const h = harness();
    installZedKeybindings(h.editor, h.monaco);
    const event = keyboardEvent(init);

    h.container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    ["Cmd+Shift+P", { key: "P", code: "KeyP", metaKey: true, shiftKey: true }],
    ["Cmd+D", { key: "d", code: "KeyD", metaKey: true }],
    ["Cmd+T", { key: "t", code: "KeyT", metaKey: true }],
    [
      "Cmd+Alt+Up",
      { key: "ArrowUp", code: "ArrowUp", metaKey: true, altKey: true },
    ],
    [
      "Cmd+Alt+Down",
      { key: "ArrowDown", code: "ArrowDown", metaKey: true, altKey: true },
    ],
    ["Alt+Up", { key: "ArrowUp", code: "ArrowUp", altKey: true }],
    ["Alt+Down", { key: "ArrowDown", code: "ArrowDown", altKey: true }],
    [
      "Alt+Shift+Up",
      { key: "ArrowUp", code: "ArrowUp", altKey: true, shiftKey: true },
    ],
    [
      "Alt+Shift+Down",
      { key: "ArrowDown", code: "ArrowDown", altKey: true, shiftKey: true },
    ],
  ])("consumes the exact owned macOS chord %s", (_name, init) => {
    const h = harness();
    installZedKeybindings(h.editor, h.monaco);
    const event = keyboardEvent(init);

    h.container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    ["Ctrl+Shift+P", { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }],
    ["Ctrl+D", { key: "d", code: "KeyD", ctrlKey: true }],
    ["Ctrl+T", { key: "t", code: "KeyT", ctrlKey: true }],
    [
      "Ctrl+Alt+Up",
      { key: "ArrowUp", code: "ArrowUp", ctrlKey: true, altKey: true },
    ],
    [
      "Ctrl+Alt+Down",
      { key: "ArrowDown", code: "ArrowDown", ctrlKey: true, altKey: true },
    ],
    ["Alt+Up", { key: "ArrowUp", code: "ArrowUp", altKey: true }],
    ["Alt+Down", { key: "ArrowDown", code: "ArrowDown", altKey: true }],
    [
      "Alt+Shift+Up",
      { key: "ArrowUp", code: "ArrowUp", altKey: true, shiftKey: true },
    ],
    [
      "Alt+Shift+Down",
      { key: "ArrowDown", code: "ArrowDown", altKey: true, shiftKey: true },
    ],
  ])("consumes the exact owned non-macOS chord %s", (_name, init) => {
    setPlatform("Win32");
    const h = harness();
    installZedKeybindings(h.editor, h.monaco);
    const event = keyboardEvent(init);

    h.container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    ["Cmd+Shift+L", { key: "L", code: "KeyL", metaKey: true, shiftKey: true }],
    ["Cmd+Up", { key: "ArrowUp", code: "ArrowUp", metaKey: true }],
    [
      "Cmd+Alt+Shift+Up",
      {
        key: "ArrowUp",
        code: "ArrowUp",
        metaKey: true,
        altKey: true,
        shiftKey: true,
      },
    ],
    ["Ctrl+Cmd+D", { key: "d", code: "KeyD", metaKey: true, ctrlKey: true }],
  ])("does not consume the unowned macOS chord %s", (_name, init) => {
    const h = harness();
    installZedKeybindings(h.editor, h.monaco);
    const event = keyboardEvent(init);

    h.container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("allows a non-owned chord to bubble to window", () => {
    const h = harness();
    installZedKeybindings(h.editor, h.monaco);
    const onWindowKeyDown = vi.fn();
    listenToWindow(onWindowKeyDown);
    const event = keyboardEvent({
      key: "L",
      code: "KeyL",
      metaKey: true,
      shiftKey: true,
    });

    h.container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onWindowKeyDown).toHaveBeenCalledOnce();
  });

  it("removes container consumption and disposes every action", () => {
    const h = harness();
    const installed = installZedKeybindings(h.editor, h.monaco);
    const onWindowKeyDown = vi.fn();
    listenToWindow(onWindowKeyDown);

    installed.dispose();
    const event = keyboardEvent({
      key: "d",
      code: "KeyD",
      metaKey: true,
    });
    h.container.dispatchEvent(event);

    expect(h.actions).toHaveLength(9);
    expect(event.defaultPrevented).toBe(false);
    expect(onWindowKeyDown).toHaveBeenCalledOnce();
    for (const dispose of h.actionDisposers) {
      expect(dispose).toHaveBeenCalledOnce();
    }
  });
});
