// @vitest-environment node

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createTerminaiViteConfig, monacoTestAliases } from "../vite.config";

const requireFromTest = createRequire(import.meta.url);

describe("Vite Monaco test resolver", () => {
  it("resolves Monaco package entries independent of checkout depth and keeps them out of production config", () => {
    const aliases = monacoTestAliases();

    expect(aliases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        find: "monaco-editor",
        replacement: requireFromTest.resolve("monaco-editor/esm/vs/editor/editor.main.js"),
      }),
      expect.objectContaining({
        find: "monaco-editor/esm/vs/editor/editor.api",
        replacement: requireFromTest.resolve("monaco-editor/esm/vs/editor/editor.api.js"),
      }),
    ]));
    expect(createTerminaiViteConfig({ command: "build", mode: "production" }).resolve).toBeUndefined();
    expect(createTerminaiViteConfig({ command: "serve", mode: "test" }).resolve?.alias).toEqual(aliases);
  });
});

describe("Vite development watcher", () => {
  it("ignores generated portable runtimes and nested worktrees", () => {
    const ignored = createTerminaiViteConfig({
      command: "serve",
      mode: "development",
    }).server.watch.ignored;

    expect(ignored).toEqual(expect.arrayContaining([
      "**/sidecar/dist/**",
      "**/.claude/worktrees/**",
    ]));
  });
});
