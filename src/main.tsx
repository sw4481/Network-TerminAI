import ReactDOM from "react-dom/client";
import App from "./App";
import { DetachedEditorWindow } from "./components/editor/DetachedEditorWindow";
import { ZedModeProvider } from "./components/editor/ZedModeProvider";
import "./components/editor/zed-mode.css";

async function init() {
  const detachedEditor =
    new URLSearchParams(window.location.search).get("view") ===
    "editor-detached";

  if (!detachedEditor) {
    // The main app owns terminal panes and waits for xterm's CDN bundle.
    // Detached editor windows do not need xterm and render immediately.
    let attempts = 0;
    while (!(window as any).Terminal && attempts < 50) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      attempts++;
    }

    if (!(window as any).Terminal) {
      console.error("Failed to load xterm from CDN");
      return;
    }

    console.log("xterm loaded from CDN successfully");
  }
  const root = document.getElementById("root");
  if (!root) {
    console.error("Root element not found");
    return;
  }

  ReactDOM.createRoot(root).render(
    <ZedModeProvider>
      {detachedEditor ? <DetachedEditorWindow /> : <App />}
    </ZedModeProvider>,
  );
}

init();
