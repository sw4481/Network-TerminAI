# Configuration

TerminAI is configured from **Settings**. Use files and environment variables only for source builds, tests, or automation.

## Start here

1. Open **Settings** with `Cmd+,` or the gear button.
2. Select **General**.
3. Choose a provider:
   - Anthropic
   - OpenAI
   - Google Gemini
   - NVIDIA
   - vLLM
   - Ollama
4. Pick a model.
5. Enter the API key or local base URL when that provider needs one.
6. Click **Save Configuration**.
7. Click **Test Connection** before using AI features.

Cloud providers use an API key. Local providers use a base URL.

| Provider | Needs | Default or source |
| --- | --- | --- |
| Anthropic | API key | `console.anthropic.com` |
| OpenAI | API key | `platform.openai.com` |
| Google Gemini | API key | `makersuite.google.com` |
| NVIDIA | API key | `build.nvidia.com` |
| vLLM | Base URL | `http://localhost:8000` |
| Ollama | Base URL | `http://localhost:11434` |

TerminAI saves the selected provider, model, API key, and local base URL through the `ai_save_config`, `ai_get_config`, and `ai_test_connection` Tauri commands used by the Settings UI.

## Settings tabs

Settings is grouped so common app settings are first and integrations are easy to find.

| Category | Tabs |
| --- | --- |
| General | General |
| AI & Agents | Agent Computers, Agents, Network Architect, RAG, Skills, Vendor Keywords |
| Application | Appearance, Browser, Editor, Terminal, Updates |
| Cisco | ACI, Catalyst Center, Cisco XDR, CML, FMC, ISE, Meraki, Secure Endpoint, Stealthwatch, ThousandEyes |
| Network Data | gNMI, Juniper Mist, NetBox, pyATS, Topolograph |
| Observability | Grafana, Prometheus, Splunk, Zabbix |
| Services | FTP Server, Git / CI, MCP Servers, Proxmox, Sketchfab, TFTP Server, WhatsApp |

Save and test each integration before asking an agent to use it.

## Environment variable fallbacks

Settings is the normal path. These variables are fallbacks for development, tests, or headless automation.

```bash
VLLM_ENDPOINT=http://localhost:8000
OLLAMA_HOST=http://localhost:11434
TERMINAI_WHISPER_MODEL=/path/to/ggml-model.bin
```

Notes:

- Do not commit real values.
- `VLLM_API_KEY` is only needed if your vLLM-compatible endpoint requires one.
- `TERMINAI_WHISPER_MODEL` is optional. Packaged builds include the default local Whisper model.
- Older docs may mention `~/.config/ccie-terminal/config.toml` and `.env`. The current app is Settings-first; use `.env.example` only as a placeholder template.

## Local data locations

TerminAI keeps the historical `ccie-terminal` roots so existing installs keep their data during upgrades.

| Platform | Configuration and app data |
| --- | --- |
| macOS | `~/Library/Application Support/ccie-terminal` |
| Windows | `%APPDATA%\\ccie-terminal` |
| Linux | `~/.config/ccie-terminal` and `~/.local/share/ccie-terminal` |

These locations can contain sessions, scrollback, local indexes, saved settings, vault metadata, recordings, logs, and integration state. Do not copy them into a public repository.

## Development setup

From a clean checkout:

```bash
bun install
cd sidecar
uv sync --frozen --extra dev
cd ..
./run.sh
```

`run.sh` also:

- creates or reuses `sidecar/.venv`;
- installs the sidecar and the tracked `pyats_cli` wrapper when missing;
- downloads the local Whisper model required by the Tauri resource manifest;
- forces dev mode to use the live virtual environment instead of stale bundled Python output.

## Build and test

Use the same gates as CI where possible:

```bash
bun run build
bun test
cd src-tauri && cargo test
cd ../sidecar && uv run --frozen --extra dev pytest
```

Release builds also run `scripts/release_preflight.py`, which checks the package version, Tauri manifest, updater endpoint, macOS minimum version, changelog, and related release contract.

## Troubleshooting

- **AI fails immediately:** open **Settings → General**, re-enter the key or base URL, save, then test.
- **Local model is unreachable:** confirm Ollama or vLLM is running and that the base URL is reachable from the TerminAI machine.
- **An integration agent fails:** open that integration's Settings tab and run its test action before retrying.
- **Sidecar behaves like old code:** stop the app, remove stale bundled sidecar output if present, and rerun `./run.sh`.
- **Do not know where logs are:** open **Settings → Terminal → Diagnostic logs**.
