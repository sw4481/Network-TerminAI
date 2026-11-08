import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const output = process.env.CANVAS_E2E_OUTPUT;
const executable = process.env.CANVAS_E2E_CHROMIUM;
if (!output || !/^\/(?:private\/)?tmp\/ccie-canvas-task7\.[A-Za-z0-9]+$/.test(output) || !existsSync(output) || !executable || !existsSync(executable)) {
  throw new Error("Canvas browser acceptance requires fresh CANVAS_E2E_OUTPUT and approved CANVAS_E2E_CHROMIUM");
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const vite = '"/opt/homebrew/bin/bun" node_modules/vite/bin/vite.js';
const options = '--config e2e/browser/vite.config.ts --configLoader runner --mode test';

export default defineConfig({
  testDir: fileURLToPath(new URL("../tests", import.meta.url)),
  testMatch: "copilot-canvas.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  outputDir: join(output, "results"),
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:1437",
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    serviceWorkers: "block",
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath: executable,
      env: { ...process.env, TMPDIR: join(output, "tmp") },
    },
  },
  webServer: {
    cwd: root,
    command: `NODE_ENV=development ${vite} build ${options} && NODE_ENV=development ${vite} preview ${options} --host 127.0.0.1 --port 1437 --strictPort`,
    url: "http://127.0.0.1:1437",
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { NODE_ENV: "development", CANVAS_E2E_OUTPUT: output, TMPDIR: join(output, "tmp") },
  },
});
