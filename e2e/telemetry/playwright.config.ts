import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const output = process.env.TELEMETRY_E2E_OUTPUT;
const executable = process.env.TELEMETRY_E2E_CHROMIUM;
if (
  !output ||
  !/^\/(?:private\/)?tmp\/ccie-telemetry-task10\.[A-Za-z0-9]+$/.test(output) ||
  !existsSync(output) ||
  !executable ||
  !existsSync(executable)
) {
  throw new Error(
    "Telemetry browser acceptance requires fresh TELEMETRY_E2E_OUTPUT and approved TELEMETRY_E2E_CHROMIUM",
  );
}
if (
  lstatSync(output).isSymbolicLink() ||
  !existsSync(join(output, "tmp")) ||
  lstatSync(join(output, "tmp")).isSymbolicLink() ||
  (process.env.TEST_WORKER_INDEX === undefined &&
    readdirSync(output).some((name) => name !== "tmp"))
)
  throw new Error(
    "Telemetry artifacts must start in a fresh task-owned directory containing only tmp",
  );
const root = fileURLToPath(new URL("../../", import.meta.url));
const vite = '"/opt/homebrew/bin/bun" node_modules/vite/bin/vite.js';
const options =
  "--config e2e/telemetry/vite.config.ts --configLoader runner --mode test";

export default defineConfig({
  testDir: fileURLToPath(new URL("../tests", import.meta.url)),
  testMatch: "telemetry.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  outputDir: join(output, "results"),
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:1438",
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
    command: `NODE_ENV=development ${vite} build ${options} && NODE_ENV=development ${vite} preview ${options} --host 127.0.0.1 --port 1438 --strictPort`,
    url: "http://127.0.0.1:1438",
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NODE_ENV: "development",
      TELEMETRY_E2E_OUTPUT: output,
      TMPDIR: join(output, "tmp"),
    },
  },
});
