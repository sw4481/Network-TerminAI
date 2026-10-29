import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { createTerminaiViteConfig } from "../../vite.config";

const output = process.env.CANVAS_E2E_OUTPUT;
if (!output || !/^\/(?:private\/)?tmp\/ccie-canvas-task7\.[A-Za-z0-9]+$/.test(output) || !existsSync(output)) {
  throw new Error("Set CANVAS_E2E_OUTPUT to a fresh existing /tmp/ccie-canvas-task7.* directory");
}
if (process.env.NODE_ENV !== "development") {
  throw new Error("The browser surrogate requires NODE_ENV=development to preserve real App DEV guards");
}

export default defineConfig(() => {
  const base = createTerminaiViteConfig({ command: "build", mode: "test" });
  return {
    ...base,
    root: fileURLToPath(new URL("../../", import.meta.url)),
    logLevel: "warn",
    envDir: false,
    cacheDir: join(output, "vite-cache"),
    plugins: [...base.plugins, {
      name: "canvas-browser-entry",
      transformIndexHtml: {
        order: "pre" as const,
        handler(html: string) {
          let removed = 0;
          const local = html.replace(/<link\b[^>]*href="https:\/\/cdn\.jsdelivr\.net\/npm\/@xterm\/[^\"]+"[^>]*>|<script\b[^>]*src="https:\/\/cdn\.jsdelivr\.net\/npm\/@xterm\/[^\"]+"[^>]*><\/script>/g, () => {
            removed++;
            return "";
          });
          if (removed !== 0 || (local.match(/src="\/src\/main\.tsx"/g) ?? []).length !== 1 || /(?:src|href)=["']https?:\/\//.test(local)) {
            throw new Error("Production HTML resources changed; re-review browser isolation");
          }
          return local.replace('src="/src/main.tsx"', 'src="/e2e/browser/transport.ts"');
        },
      },
    }],
    build: {
      ...base.build,
      outDir: join(output, "bundle"),
      emptyOutDir: false,
      watch: null,
    },
    server: { host: "127.0.0.1", port: 1437, strictPort: true, hmr: false, watch: null },
    preview: { host: "127.0.0.1", port: 1437, strictPort: true, open: false, proxy: {} },
  };
});
