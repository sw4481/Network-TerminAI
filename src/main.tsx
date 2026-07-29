import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ZedModeProvider } from "./components/editor/ZedModeProvider";
import "./components/editor/zed-mode.css";

async function init() {
  // Wait for xterm to load from CDN
  let attempts = 0;
  while (!(window as any).Terminal && attempts < 50) {
    await new Promise(resolve => setTimeout(resolve, 100));
    attempts++;
  }

  if (!(window as any).Terminal) {
    console.error("Failed to load xterm from CDN");
    return;
  }

  console.log("xterm loaded from CDN successfully");

  const root = document.getElementById("root");
  if (!root) {
    console.error("Root element not found");
    return;
  }

  ReactDOM.createRoot(root).render(
    <ZedModeProvider>
      <App />
    </ZedModeProvider>,
  );
}

init();
