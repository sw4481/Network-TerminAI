import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

// Browser-only surrogate. This module never imports or changes application stores.
type BrowserHarness = Window & {
  __telemetryInvoke: (command: string, args: unknown) => Promise<unknown>;
  __TAURI_INTERNALS__?: {
    invoke: (
      command: string,
      args?: unknown,
      options?: unknown,
    ) => Promise<unknown>;
  };
  Terminal?: typeof Terminal;
};
const browser = window as BrowserHarness;
if (
  browser.__TAURI_INTERNALS__ ||
  typeof browser.__telemetryInvoke !== "function"
) {
  throw new Error(
    "Telemetry acceptance requires a fresh browser and synthetic IPC binding",
  );
}
const serializable = (args: unknown) => JSON.parse(JSON.stringify(args ?? {}));
mockWindows("main");
mockIPC(
  (command, args) => browser.__telemetryInvoke(command, serializable(args)),
  {
    shouldMockEvents: true,
  },
);
const internals = (window as BrowserHarness).__TAURI_INTERNALS__!;
const mockedInvoke = internals.invoke;
internals.invoke = async (command, args, options) => {
  if (command.startsWith("plugin:event|")) {
    // Record/authorize even commands that the installed event mock would swallow.
    await browser.__telemetryInvoke(command, serializable(args));
  }
  return mockedInvoke(command, args, options);
};
browser.Terminal = Terminal;
await import("../../src/main");
