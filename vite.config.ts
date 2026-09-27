import { createRequire } from "node:module";
import { defineConfig, type ConfigEnv } from "vite";
import react from "@vitejs/plugin-react";

const requireFromConfig = createRequire(import.meta.url);

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/** Resolve browser-only Monaco imports from the installed package in test mode. */
export function monacoTestAliases() {
  return [
    {
      find: "monaco-editor/esm/vs/editor/common/commands/shiftCommand",
      replacement: requireFromConfig.resolve(
        "monaco-editor/esm/vs/editor/common/commands/shiftCommand.js",
      ),
    },
    {
      find: "monaco-editor/esm/vs/editor/editor.api",
      replacement: requireFromConfig.resolve(
        "monaco-editor/esm/vs/editor/editor.api.js",
      ),
    },
    {
      find: "monaco-editor",
      replacement: requireFromConfig.resolve(
        "monaco-editor/esm/vs/editor/editor.main.js",
      ),
    },
  ];
}

export function createTerminaiViteConfig({ mode }: ConfigEnv) {
  const testMode = mode === "test";

  return {
    plugins: [react()],

    // These aliases are unavailable to production builds, which retain Vite's
    // normal public-package Monaco resolution.
    ...(testMode ? { resolve: { alias: monacoTestAliases() } } : {}),

    optimizeDeps: {
      include: [
        "@xterm/xterm",
        "@xterm/addon-fit",
        "@xterm/addon-web-links",
        "monaco-editor/esm/vs/editor/editor.api",
      ],
    },
    build: {
      commonjsOptions: {
        transformMixedEsModules: true,
      },
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`.
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        ignored: [
          "**/src-tauri/**",
          "**/sidecar/dist/**",
          "**/.claude/worktrees/**",
        ],
      },
    },
    ...(testMode
      ? {
          test: {
            globals: true,
            environment: "jsdom",
            setupFiles: ["./src/test-setup.ts"],
            server: {
              deps: {
                // Monaco-vim's browser entry has extensionless Monaco imports.
                inline: ["monaco-vim"],
              },
            },
            exclude: [
              "**/node_modules/**",
              "**/dist/**",
              "**/e2e/**",
              "**/.worktrees/**",
              "**/.claude/worktrees/**",
              "**/.{idea,git,cache,output,temp}/**",
              "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
            ],
          },
        }
      : {}),
  };
}

// https://vite.dev/config/
export default defineConfig(createTerminaiViteConfig);
