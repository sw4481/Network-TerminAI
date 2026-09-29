import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { SearchAddon } from "@xterm/addon-search";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DetachedEditorWindow } from "./components/editor/DetachedEditorWindow";
import { DetachedTerminalWindow } from "./components/DetachedTerminalWindow";
import { ZedModeProvider } from "./components/editor/ZedModeProvider";
import "./components/editor/zed-mode.css";
import {
  AppearanceProvider,
  applyMirroredThemeBeforeRender,
} from "./theme/AppearanceProvider";

// Restore the tiny theme-id mirror before rendering. The
// provider reconciles this first-paint hint against app_flags after mounting.
applyMirroredThemeBeforeRender();

Object.assign(window, {
  Terminal,
  FitAddon: { FitAddon },
  WebLinksAddon: { WebLinksAddon },
  ClipboardAddon: { ClipboardAddon },
  SearchAddon: { SearchAddon },
});

async function init() {
  const detachedEditor =
    new URLSearchParams(window.location.search).get("view") ===
    "editor-detached";
  const detachedTerminal =
    new URLSearchParams(window.location.search).get("view") ===
    "terminal-detached";

  if (!detachedEditor) {
    console.log("xterm loaded locally");
  }
  const root = document.getElementById("root");
  if (!root) {
    console.error("Root element not found");
    return;
  }

  ReactDOM.createRoot(root).render(
    <AppearanceProvider>
      <ZedModeProvider>
        {detachedEditor ? (
          <DetachedEditorWindow />
        ) : detachedTerminal ? (
          <DetachedTerminalWindow />
        ) : (
          <App />
        )}
      </ZedModeProvider>
    </AppearanceProvider>,
  );
}

init();
