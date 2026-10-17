import { spawnSync } from "node:child_process";

class MacResourceSigningHook {
  run() {
    if (process.platform !== "darwin") return;

    const result = spawnSync("bash", ["ci/sign-sidecar-macos.sh"], {
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}

new MacResourceSigningHook().run();
