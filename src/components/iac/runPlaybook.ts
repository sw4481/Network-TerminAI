/**
 * Helpers for running an Ansible playbook DIRECTLY (over SSH, no CI runner).
 *
 * Ansible is agentless: `ansible-playbook` opens its own SSH connection to the
 * devices from wherever it runs. So for a network target you don't need GitHub
 * + a runner to try it — you can run it right here in a terminal. These helpers
 * build the command and fire the `ccie:run-in-terminal` event that App.tsx
 * listens for (spawns a terminal in the workspace, pipes the command in).
 */

export interface RunPlaybookOpts {
  /** Playbook filename relative to the workspace (e.g. "playbook.yml"). */
  playbook: string;
  /** Inventory filename if present (e.g. "inventory.ini"); omitted when absent. */
  inventory?: string | null;
  /** Dry run (--check) shows what WOULD change without touching devices. */
  check: boolean;
}

/** Shell-quote a path only if it needs it (spaces / shell metacharacters). */
function q(path: string): string {
  return /[^A-Za-z0-9._/-]/.test(path) ? `'${path.replace(/'/g, "'\\''")}'` : path;
}

/** Build the `ansible-playbook …` command string for a direct run. */
export function buildPlaybookCommand(opts: RunPlaybookOpts): string {
  const parts = ["ansible-playbook"];
  if (opts.inventory) parts.push("-i", q(opts.inventory));
  parts.push(q(opts.playbook));
  if (opts.check) parts.push("--check");
  return parts.join(" ");
}

/** Fire the run-in-terminal event so App spawns a terminal and runs the command. */
export function runInTerminal(command: string, cwd?: string | null): void {
  window.dispatchEvent(
    new CustomEvent("ccie:run-in-terminal", {
      detail: { command, cwd: cwd ?? undefined },
    }),
  );
}

/** Convenience: build + dispatch in one call. */
export function runPlaybook(opts: RunPlaybookOpts, cwd?: string | null): void {
  runInTerminal(buildPlaybookCommand(opts), cwd);
}

/** True when a filename looks like an Ansible playbook (yaml, not a pipeline). */
export function isAnsiblePlaybook(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  const name = filePath.split("/").pop() ?? "";
  // A CI pipeline is also .yml but lives under .github/workflows or is .gitlab-ci.
  if (/\.gitlab-ci\.ya?ml$/.test(name)) return false;
  if (/\.github\/workflows\//.test(filePath)) return false;
  return /\.ya?ml$/.test(name);
}
