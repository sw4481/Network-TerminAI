# CCIE Sidecar

Python AI backend for TerminAI. Spawned by the Rust core over stdio.

## Overview

The sidecar provides:
- **LLM Integration**: Streaming chat with Anthropic, OpenAI, Google, Ollama, vLLM
- **Skills System**: Reusable AI workflows with helper scripts
- **RAG Library**: Vendor documentation search and citation
- **ReACT Agents**: Tool-using agents with natural language interfaces
- **Meraki CLI**: Full-coverage Cisco Meraki Dashboard API integration (933 endpoints)
- **Command Intelligence**: Natural language to shell command translation
- **Parsing Engines**: Network device output parsers (TextFSM, TTP, Genie)
- **Topology Discovery**: CDP/LLDP/BGP/OSPF/IS-IS neighbor extraction
- **Troubleshooting**: Guided troubleshooting workflows
- **Security**: Vault management, secrets redaction, session recording

## Dev

```bash
cd sidecar
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
pytest
```

## Protocol

NDJSON (newline-delimited JSON) over stdin/stdout. One JSON object per line.

## Modules

### Core Modules

- **agent.py**: ReACT loop orchestration and streaming events
- **agents/**: ReACT agent implementations (react.py, react_approval.py, react_context.py, react_resolve.py)
- **command_intelligence.py**: Natural language to CLI translation
- **mcp_tools.py**: Model Context Protocol tool management
- **server.py**: Main NDJSON protocol handler
- **skills.py**: Skills loader and executor

### Domain Modules

- **approvals/**: Blast-radius gating and audit logging (approval_logic.py, audit.py)
- **parsers/**: Network output parsers (textfsm, ttp, genie, pyats)
- **providers/**: LLM provider integrations (anthropic, openai, google, ollama, vllm)
- **rag/**: RAG library for vendor documentation (embeddings, search, chunking)
- **topology/**: Network topology discovery and graph building
- **troubleshoot/**: Guided troubleshooting workflows

### External Packages

- **meraki_cli/**: Cisco Meraki Dashboard API CLI (see [meraki_cli/README.md](../meraki_cli/README.md))

## Testing

```bash
# Run all tests
pytest

# With coverage
pytest --cov=ccie_sidecar --cov-report=html

# Specific test suite
pytest tests/test_react_loop.py
pytest tests/test_approval_logic.py

# Meraki CLI tests
cd ../meraki_cli
pytest
```
