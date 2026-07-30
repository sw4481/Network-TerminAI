import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const testMode = mode === "test";

  return {
  plugins: [react()],

  ...(testMode
    ? {
        resolve: {
          alias: [
            {
              find: "monaco-editor/esm/vs/editor/common/commands/shiftCommand",
              replacement: fileURLToPath(
                new URL("../../node_modules/monaco-editor/esm/vs/editor/common/commands/shiftCommand.js", import.meta.url),
              ),
            },
            {
              find: "monaco-editor/esm/vs/editor/editor.api",
              replacement: fileURLToPath(
                new URL("../../node_modules/monaco-editor/esm/vs/editor/editor.api.js", import.meta.url),
              ),
            },
            {
              // Test-only: production retains the public package import and
              // Vite's normal browser resolver.
              find: "monaco-editor",
              replacement: fileURLToPath(
                new URL("../../node_modules/monaco-editor/esm/vs/editor/editor.main.js", import.meta.url),
              ),
            },
          ],
        },
      }
    : {}),

  optimizeDeps: {
    include: [
      '@xterm/xterm',
      '@xterm/addon-fit',
      '@xterm/addon-web-links',
      'monaco-editor/esm/vs/editor/editor.api',
    ],
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
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
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
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
              // Monaco-vim's published browser entry must be transformed for
              // its extensionless Monaco imports to use these test aliases.
              inline: ["monaco-vim"],
            },
          },
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "**/e2e/**",
            "**/.{idea,git,cache,output,temp}/**",
            "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
          ],
        },
      }
    : {}),
  };
});
