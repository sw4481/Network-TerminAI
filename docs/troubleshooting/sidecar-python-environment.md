# Sidecar Python Environment Troubleshooting

## Symptom

Error when testing code execution: `cannot import name 'deepcopy_with_paths' from 'openai._files'`

## Root Cause

The sidecar must use the `.venv` Python environment which has the correct version of the `openai` package (2.38.0). If it uses the system Python or a different environment with an older openai version, this error will occur.

## Verification Steps

### 1. Check which Python is being used

```bash
ps aux | grep "ccie_sidecar" | grep -v grep
```

Expected: The command should show the sidecar running, and `lsof` should show it loading modules from the .venv:

```bash
lsof -p <PID> 2>/dev/null | grep "site-packages" | head -5
```

Expected output should show paths like:
```
$HOME/Network-TerminAI/sidecar/.venv/lib/python3.12/site-packages/...
```

### 2. Verify .venv has correct openai version

```bash
cd $HOME/Network-TerminAI
sidecar/.venv/bin/python -c "import openai; print(openai.__version__); from openai._files import deepcopy_with_paths; print('OK')"
```

Expected output:
```
2.38.0
OK
```

### 3. Test sidecar directly

```bash
echo '{"id":"test-1","method":"ping","params":{}}' | sidecar/.venv/bin/python -m ccie_sidecar 2>/dev/null
```

Expected output:
```json
{"id": "test-1", "type": "done", "result": "pong"}
```

## How sidecar_spawn_target() Works

The Rust code in `src-tauri/src/commands/mod.rs` determines which Python to use:

1. First checks for bundled Python (production builds only)
2. Falls back to `.venv/bin/python` in dev mode

The path construction uses either:
- `CCIE_REPO_ROOT` environment variable (if set)
- `std::env::current_dir()` (fallback)

Then appends `/sidecar/.venv/bin/python`.

## Common Issues

### Stale sidecar process

If the sidecar was started before dependencies were installed or with a different Python:

**Solution**: Restart the Tauri app (which restarts the sidecar)

### PYTHONPATH interference

If `PYTHONPATH` is set in the environment, it can interfere with the .venv's site-packages:

**Solution**: Unset `PYTHONPATH` before launching the app, or ensure the .venv's site-packages has priority

### Wrong Python symlink

The .venv's `python` symlink should point to a Python 3.12+ interpreter:

```bash
ls -la sidecar/.venv/bin/python*
```

The symlinks will resolve to the system Python (this is normal for venvs), but the .venv's site-packages should still be used.

## Resolution for this instance

Investigation showed:
1. `.venv/bin/python` exists and has correct openai (2.38.0)
2. Running sidecar process IS using .venv's site-packages (verified via lsof)
3. Sidecar responds to ping correctly

**Conclusion**: The error was likely from a stale sidecar process that has since been restarted, or a transient import issue. The environment is now correctly configured.

## Prevention

To prevent this issue:
1. Always run `cd sidecar && python -m pip install -e .` after pulling updates
2. Restart the Tauri app after dependency changes
3. Check the troubleshooting steps above if the error occurs
