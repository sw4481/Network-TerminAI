# terminai-pyats

Cisco pyATS/Genie network device automation as a CLI, Python client, and TerminAI agent.

## Quick Start

```bash
pip install terminai-pyats

# Run a show command
pyats-cli run-show-command --device CORE1 --command "show version"

# Learn OSPF state
pyats-cli learn --device CORE1 --feature ospf
```

## Features

- **15 curated verbs**: read device state, configure, health checks, neighbors
- **Typed envelopes**: `{ok, data/error, meta}` for reliable parsing
- **Blast-radius classification**: low/medium/high/destructive with approval gating
- **Genie parsing**: structured JSON output for show commands when available
- **Testbed.yaml + .env**: GUI-managed credentials via TerminAI Settings → pyATS

## Documentation

See `docs/PYATS_CLI.md` for full verb catalog and examples.
