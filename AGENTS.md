Always use graphify 
Always be surgical, ground your plan in fact using graphify
Always write the minimal code needed to acheieve the goal

Any time you make a mistake - ALWAYS write it out to Plans/Mistakes.MD - if the file doesnt exist - create it. When you store a new mistake please make sure to include
- what the issue was
- Root Cause analysis of the issue
- How you addressed the issue

Always use the mistakes file when planning to make sure you do NOT plan a mistake we have already had
# TerminAI Repository Guardrails

## Sidecar health is a release invariant

- Do not treat a change as complete while the TerminAI sidecar is down or unverified.
- Launch development validation through `./run.sh` so `CCIE_REPO_ROOT`,
  `CCIE_FORCE_VENV`, and `sidecar/.venv` are configured consistently.
- After changes that can restart or affect the app, Tauri commands, packaging,
  dependencies, or the sidecar, verify all of the following:
  - `target/debug/TerminAI` is running.
  - A child `python -m ccie_sidecar` process is running from `sidecar/.venv`.
  - The sidecar warmup ping succeeds.
  - `sidecar_status.last_seen` receives fresh heartbeat timestamps.
  - The footer chip leaves `starting` and shows the sidecar version.
- Preserve `sidecar/.venv` and the app data under
  `~/Library/Application Support/ccie-terminal`; do not delete or replace them
  as incidental cleanup.
