"""Agent handler for CCIE Terminal AI interactions."""
from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterator

from ccie_sidecar.providers import anthropic, google, nvidia, ollama, openai, vllm


def get_saved_config() -> dict[str, Any] | None:
    """Read the saved AI config from the app's SQLite database."""
    try:
        # Find the database in the standard config location
        if os.name == 'nt':
            config_dir = Path(os.environ.get('APPDATA', '')) / 'ccie-terminal'
        elif os.uname().sysname == 'Darwin':
            config_dir = Path.home() / 'Library' / 'Application Support' / 'ccie-terminal'
        else:
            config_dir = Path.home() / '.config' / 'ccie-terminal'

        db_path = config_dir / 'sessions.db'
        if not db_path.exists():
            return None

        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        cursor.execute("SELECT provider, model, api_key, base_url FROM ai_config WHERE id = 1")
        row = cursor.fetchone()
        conn.close()

        if row:
            return {
                "provider": row[0],
                "model": row[1],
                "api_key": row[2],
                "base_url": row[3],
            }
        return None
    except Exception as e:
        print(f"Failed to read AI config: {e}")
        return None

# Phase 4: MCP tool integration
try:
    from ccie_sidecar import mcp_tools
    MCP_AVAILABLE = True
except ImportError:
    MCP_AVAILABLE = False


# ===========================================================================
# Agents: Warp-style specialized personas
# ===========================================================================

def _agents_dir() -> Path:
    return Path.home() / ".ccie-terminal" / "agents"


def _bundled_agents_dir() -> Path:
    """Get bundled agents directory (shipped with TerminAI)."""
    # Find the bundled-agents directory relative to this file
    # sidecar/src/ccie_sidecar/agent.py -> ../../../bundled-agents
    return Path(__file__).parent.parent.parent.parent / "bundled-agents"


# Per-file cap for soul files, mirroring netclaw's 20k-char limit, so a verbose
# expertise reference can't blow up the prompt.
_SOUL_FILE_CHAR_CAP = 20_000


def _append_soul_files(agent_dir: Path, system_prompt: str) -> str:
    """Append any SOUL*.md files in the agent dir to the system prompt.

    netclaw splits a persona across SOUL.md / SOUL-EXPERTISE.md / SOUL-SKILLS.md /
    etc. We support that pattern opt-in: an agent that ships SOUL*.md files gets
    them concatenated (alphabetical, each capped) onto its frontmatter
    system-prompt. Agents with no SOUL files are returned unchanged — so this is
    safe for every existing agent and only activates for ones built this way.
    """
    try:
        # SOUL.md (identity + rules) leads; the rest follow alphabetically. ASCII
        # would otherwise sort 'SOUL-EXPERTISE.md' before 'SOUL.md' ('-' < '.').
        soul_files = sorted(
            agent_dir.glob("SOUL*.md"),
            key=lambda p: (p.name != "SOUL.md", p.name),
        )
    except Exception:
        return system_prompt
    if not soul_files:
        return system_prompt
    parts = [system_prompt] if system_prompt else []
    for f in soul_files:
        try:
            text = f.read_text(encoding="utf-8").strip()
        except Exception:
            continue
        if not text:
            continue
        if len(text) > _SOUL_FILE_CHAR_CAP:
            text = text[:_SOUL_FILE_CHAR_CAP] + "\n…(truncated)"
        parts.append(text)
    return "\n\n".join(parts)


def load_agent(agent_id: str) -> dict[str, Any] | None:
    """
    Load an agent definition from user or bundled agents directory.

    Search order:
    1. ~/.ccie-terminal/agents/<id>/AGENT.md (user agents)
    2. bundled-agents/<id>/AGENT.md (shipped with TerminAI)
    """
    if not agent_id or agent_id == "general":
        return None

    # Try user agents first
    path = _agents_dir() / agent_id / "AGENT.md"
    if not path.exists():
        # Try bundled agents
        path = _bundled_agents_dir() / agent_id / "AGENT.md"
        if not path.exists():
            return None
    try:
        content = path.read_text(encoding="utf-8").strip()
        if not content.startswith("---"):
            return None
        rest = content[3:]
        idx = rest.find("\n---")
        if idx < 0:
            return None
        fm_str = rest[:idx].strip()
        body = rest[idx + 4:].strip()
        # Minimal YAML-ish parse: we only handle the fields we emit.
        import yaml  # pyyaml is already a dep of skills module
        fm = yaml.safe_load(fm_str) or {}
        # Load attached tools and resolve catalog paths
        attached_tools_raw = fm.get("attached-tools") or fm.get("attached_tools") or []
        attached_tools = []
        for tool_def in attached_tools_raw:
            catalog_path = tool_def.get("catalog")
            if catalog_path:
                # Resolve relative paths relative to agent directory
                if not Path(catalog_path).is_absolute():
                    catalog_path = (path.parent / catalog_path).resolve()
                    # Read and inline the catalog
                    try:
                        with open(catalog_path, encoding="utf-8") as f:
                            catalog_json = f.read()
                            tool_def_resolved = {
                                "id": tool_def.get("id"),
                                "catalog": catalog_json,
                                "vault_entry": tool_def.get("vault-entry") or tool_def.get("vault_entry"),
                                "default_blast_radius_allowed": (
                                    tool_def.get("default-blast-radius-allowed") or
                                    tool_def.get("default_blast_radius_allowed")
                                ),
                            }
                            attached_tools.append(tool_def_resolved)
                    except Exception as e:
                        print(f"Warning: Failed to load catalog {catalog_path}: {e}")
                        # Keep original with key normalization
                        tool_def_normalized = {
                            "id": tool_def.get("id"),
                            "catalog": tool_def.get("catalog"),
                            "vault_entry": tool_def.get("vault-entry") or tool_def.get("vault_entry"),
                            "default_blast_radius_allowed": (
                                tool_def.get("default-blast-radius-allowed") or
                                tool_def.get("default_blast_radius_allowed")
                            ),
                        }
                        attached_tools.append(tool_def_normalized)
                else:
                    # Normalize keys for absolute paths too
                    tool_def_normalized = {
                        "id": tool_def.get("id"),
                        "catalog": tool_def.get("catalog"),
                        "vault_entry": tool_def.get("vault-entry") or tool_def.get("vault_entry"),
                        "default_blast_radius_allowed": (
                            tool_def.get("default-blast-radius-allowed") or
                            tool_def.get("default_blast_radius_allowed")
                        ),
                    }
                    attached_tools.append(tool_def_normalized)
            else:
                # No catalog path - normalize keys anyway
                tool_def_normalized = {
                    "id": tool_def.get("id"),
                    "catalog": tool_def.get("catalog"),
                    "vault_entry": tool_def.get("vault-entry") or tool_def.get("vault_entry"),
                    "default_blast_radius_allowed": (
                        tool_def.get("default-blast-radius-allowed") or
                        tool_def.get("default_blast_radius_allowed")
                    ),
                }
                attached_tools.append(tool_def_normalized)

        system_prompt = fm.get("system-prompt") or fm.get("system_prompt") or ""
        # Opt-in netclaw-style "soul": if the agent dir contains SOUL*.md files,
        # append them unless the agent explicitly keeps those files as offline
        # references. Network Architect uses the latter mode: its large routing/
        # protocol references duplicated and contradicted the compact live prompt.
        # Older installs may have a user-level copy of the bundled Network
        # Architect definition from before this flag existed. Default that one
        # agent to compact mode too, so stale app data cannot silently restore
        # the 20K+ duplicated prompt after an upgrade.
        append_soul_default = agent_id != "network-architect"
        append_soul = fm.get(
            "append-soul-files",
            fm.get("append_soul_files", append_soul_default),
        )
        if append_soul:
            system_prompt = _append_soul_files(path.parent, system_prompt)

        agent = {
            "id": agent_id,
            "name": fm.get("name") or agent_id,
            "description": fm.get("description") or "",
            "system_prompt": system_prompt,
            "model_override": fm.get("model-override") or fm.get("model_override"),
            "attached_skills": fm.get("attached-skills")
                or fm.get("attached_skills") or [],
            "attached_mcp_servers": fm.get("attached-mcp-servers")
                or fm.get("attached_mcp_servers") or [],
            "attached_tools": attached_tools,
            "allowed_commands": fm.get("allowed-commands")
                or fm.get("allowed_commands") or [],
            "body": body,
        }
        return agent
    except Exception as e:
        print(f"Failed to load agent '{agent_id}': {e}")
        return None


def build_agent_system_prompt(agent: dict[str, Any]) -> str:
    """Compose the system prompt from agent + attached skills' playbooks + tool catalog."""
    parts: list[str] = []

    # 1. TOOL USE PROTOCOL — first, because many models ignore it if it's buried.
    allowed = agent.get("allowed_commands") or []
    allowed_blurb = (
        "Allowed command patterns (regex): "
        + ", ".join(f"`{p}`" for p in allowed)
        if allowed
        else "No command allowlist configured."
    )
    mcp_list = agent.get("attached_mcp_servers") or []
    mcp_blurb = (
        "Attached MCP servers: " + ", ".join(f"`{s}`" for s in mcp_list)
        if mcp_list
        else "No MCP tools attached."
    )

    parts.append(
        "# ⚠️ CRITICAL: TOOL USE PROTOCOL\n\n"
        "You are an AGENT, not a help-desk chatbot. You have access to the user's\n"
        "terminal via tool calls. When a question needs data from the system you MUST\n"
        "propose tool calls instead of telling the user to run commands themselves.\n\n"
        "## Emit a tool call using THIS EXACT format (on its own line, nothing else):\n\n"
        "<<TOOL_CALL shell>>\n"
        '{"cmd": "show ip bgp summary", "reason": "check BGP session state"}\n'
        "<</TOOL_CALL>>\n\n"
        "For MCP:\n"
        "<<TOOL_CALL mcp>>\n"
        '{"server": "netbox", "tool": "get_device", "args": {"name": "r1"}}\n'
        "<</TOOL_CALL>>\n\n"
        "## Rules (read carefully — violations break the app):\n\n"
        "1. **NEVER** tell the user to run commands themselves. Never write\n"
        "   `Command:` / `Try running:` / \"Use this command:\" / 'Copy this'.\n"
        "2. **NEVER** emit fenced code blocks containing commands for the user to\n"
        "   copy. If you want a command run, use a <<TOOL_CALL>> block.\n"
        "3. Emit **ONE** tool call per turn, then STOP. Do not keep writing.\n"
        "4. After you emit <</TOOL_CALL>>, do not continue — wait for the result.\n"
        "5. When the result arrives as a `TOOL_RESULT for tc-...` user message,\n"
        "   analyze it and either emit your NEXT tool call or give your final answer.\n"
        "6. Keep running tool calls one-at-a-time until you have enough data, THEN\n"
        "   write the final analysis for the user.\n"
        "7. Never fabricate output. If a command is rejected, pivot to another.\n\n"
        "## Example of a CORRECT turn:\n\n"
        "User: Can you check why this port shows MAB instead of dot1x?\n\n"
        "Assistant (your turn, stops after the tool call):\n"
        "> I need the detailed session info to see why 802.1x isn't being chosen.\n"
        ">\n"
        "> <<TOOL_CALL shell>>\n"
        '> {"cmd": "show access-session interface Gi1/0/2 details", "reason": "see which auth method was attempted first and any failures"}\n'
        "> <</TOOL_CALL>>\n\n"
        "(Then you STOP generating. The system runs the command and replies with\n"
        "a TOOL_RESULT user message. Your next turn analyzes that output and either\n"
        "proposes the next command or concludes.)\n\n"
        "## Example of an INCORRECT turn (do NOT do this):\n\n"
        "> You should run `show access-session interface Gi1/0/2 details` to see…\n"
        "(Wrong — that's telling the user to copy/paste. Use a tool call instead.)\n\n"
        f"{allowed_blurb}\n{mcp_blurb}"
    )

    # 2. Agent persona
    sp = agent.get("system_prompt", "").strip()
    if sp:
        parts.append("# Persona\n\n" + sp)

    # 3. Attached skill playbooks (reuse skills loader)
    from ccie_sidecar import skills as _skills
    attached = agent.get("attached_skills") or []
    if attached:
        skill_blocks: list[str] = []
        for sid in attached:
            s = _skills.get_skill(sid)
            if not s:
                continue
            playbook = s.get("playbook") or s.get("body") or ""
            name = s.get("name") or sid
            when = s.get("when-to-use") or s.get("when_to_use") or ""
            skill_blocks.append(
                f"### Skill: {name}\n"
                f"{('Trigger: ' + when + chr(10)) if when else ''}"
                f"\n{playbook}\n"
            )
        if skill_blocks:
            parts.append(
                "# Attached Skills\n\n"
                "You have access to the following specialized skill playbooks. "
                "Reference them when their triggers match the user's query. "
                "When a playbook says to run a command, emit it as a <<TOOL_CALL>> — "
                "do not write it in prose for the user.\n\n"
                + "\n---\n".join(skill_blocks)
            )

    # 4. Final reminder at the end (where it's most likely to stick in the context window)
    parts.append(
        "# Reminder\n\n"
        "Emit <<TOOL_CALL>> blocks to run commands. Do NOT write commands in prose "
        "for the user to copy. One tool call per turn, then stop."
    )

    return "\n\n".join(parts)


# Regex for parsing tool-call markers in streamed LLM output
TOOL_CALL_RE = re.compile(
    r"<<TOOL_CALL\s+(shell|mcp)>>\s*(\{.*?\})\s*<</TOOL_CALL>>",
    re.DOTALL,
)


def parse_tool_calls(text: str) -> list[dict[str, Any]]:
    """Extract all tool call markers from text. Returns list of {kind, payload, span}."""
    import json as _json
    results: list[dict[str, Any]] = []
    for m in TOOL_CALL_RE.finditer(text):
        kind = m.group(1)
        try:
            payload = _json.loads(m.group(2))
        except Exception:
            continue
        results.append({"kind": kind, "payload": payload, "span": m.span()})
    return results


def chat_stream_with_agent(
    session_id: str,
    messages: list[dict[str, Any]],
    agent_id: str,
) -> Iterator[dict[str, Any]]:
    """Stream a chat completion routed through a specific agent's persona.

    Same event shape as chat_stream, but additionally emits synthetic
    {"type": "tool_call", "kind": "shell"|"mcp", "payload": {...}} events when
    the LLM output contains a TOOL_CALL marker. The token stream still includes
    the literal marker text so the orchestrator can slice it out if desired.
    """
    agent = load_agent(agent_id)
    if agent is None:
        yield {"type": "error", "message": f"Agent '{agent_id}' not found"}
        return

    system_prompt = build_agent_system_prompt(agent)

    # Resolve provider + model + credentials
    override = agent.get("model_override")
    saved = get_saved_config()
    if override and isinstance(override, dict):
        provider = override.get("provider") or (saved or {}).get("provider") or "anthropic"
        model = override.get("model") or (saved or {}).get("model") or ""
        api_key = (saved or {}).get("api_key")
        base_url = (saved or {}).get("base_url")
    elif saved:
        provider = saved["provider"]
        model = saved["model"]
        api_key = saved.get("api_key")
        base_url = saved.get("base_url")
    else:
        provider, model = PROFILE_TO_PROVIDER_MODEL["default"]
        api_key = None
        base_url = None

    # Dispatch to provider, streaming with system prompt
    buffered = ""
    emitted_tool_ids: set[tuple[int, int]] = set()

    def _provider_stream():
        if provider == "anthropic":
            key = api_key or os.getenv("ANTHROPIC_API_KEY")
            if not key:
                yield {"type": "error", "message": "Anthropic API key not configured"}
                return
            yield from anthropic.stream_chat(
                api_key=key, model=model, messages=messages, system=system_prompt
            )
        elif provider == "google":
            key = api_key or os.getenv("GOOGLE_API_KEY")
            if not key:
                yield {"type": "error", "message": "Google API key not configured"}
                return
            yield from google.stream_chat(
                api_key=key, model=model, messages=messages, system=system_prompt
            )
        elif provider == "nvidia":
            key = api_key or os.getenv("NVIDIA_API_KEY")
            if not key:
                yield {"type": "error", "message": "NVIDIA API key not configured"}
                return
            yield from nvidia.stream_chat(
                api_key=key, model=model, messages=messages, system=system_prompt, base_url=base_url
            )
        elif provider == "openai":
            key = api_key or os.getenv("OPENAI_API_KEY")
            if not key:
                yield {"type": "error", "message": "OpenAI API key not configured"}
                return
            yield from openai.stream_chat(
                api_key=key, model=model, messages=messages, system=system_prompt
            )
        elif provider == "vllm":
            endpoint = base_url or os.getenv("VLLM_ENDPOINT", "http://localhost:8000")
            if not endpoint.rstrip("/").endswith("/v1"):
                endpoint = endpoint.rstrip("/") + "/v1"
            prepared = [{"role": "system", "content": system_prompt}] + messages
            yield from vllm.stream_chat(
                endpoint=endpoint, model=model, messages=prepared, api_key=api_key
            )
        elif provider == "ollama":
            host = base_url or os.getenv("OLLAMA_HOST", "http://localhost:11434")
            prepared = [{"role": "system", "content": system_prompt}] + messages
            yield from ollama.stream_chat(host=host, model=model, messages=prepared)
        else:
            yield {"type": "error", "message": f"Unknown provider: {provider}"}

    for event in _provider_stream():
        if event.get("type") == "token":
            data = event.get("data", "")
            buffered += data
            yield event
            # After each token, scan for any new completed tool calls in buffer
            for tc in parse_tool_calls(buffered):
                if tc["span"] not in emitted_tool_ids:
                    emitted_tool_ids.add(tc["span"])
                    yield {
                        "type": "tool_call",
                        "kind": tc["kind"],
                        "payload": tc["payload"],
                    }
        else:
            yield event


# Profile to (provider, model) mapping
PROFILE_TO_PROVIDER_MODEL = {
    "default": ("anthropic", "claude-sonnet-4-6"),
    "quality": ("anthropic", "claude-opus-4-7"),
    "budget": ("anthropic", "claude-haiku-4-5"),
    "google-fast": ("google", "gemini-2.0-flash"),
    "google-smart": ("google", "gemini-1.5-pro"),
    "openai-fast": ("openai", "gpt-3.5-turbo"),
    "openai-smart": ("openai", "gpt-4o"),
    "vllm-local": ("vllm", "meta-llama/Llama-3.3-70B-Instruct"),
    "ollama-default": ("ollama", "llama3.3"),
    "ollama-code": ("ollama", "codellama"),
    "ollama-mistral": ("ollama", "mistral"),
}


def chat_stream(
    session_id: str,
    messages: list[dict[str, Any]],
    profile: str = "default",
) -> Iterator[dict[str, Any]]:
    """
    Stream a chat completion from the AI provider using saved config.
    Falls back to profile-based routing if no saved config exists.
    """
    # Try to use saved config first
    config = get_saved_config()

    if config:
        provider = config["provider"]
        model = config["model"]
        api_key = config.get("api_key")
        base_url = config.get("base_url")
    else:
        # Fallback to profile-based routing
        provider, model = PROFILE_TO_PROVIDER_MODEL.get(profile, ("anthropic", "claude-sonnet-4-6"))
        api_key = None
        base_url = None

    # Dispatch to appropriate provider
    if provider == "anthropic":
        key = api_key or os.getenv("ANTHROPIC_API_KEY")
        if not key:
            yield {"type": "error", "message": "Anthropic API key not configured. Go to Settings > General to set it."}
            return
        yield from anthropic.stream_chat(api_key=key, model=model, messages=messages)

    elif provider == "google":
        key = api_key or os.getenv("GOOGLE_API_KEY")
        if not key:
            yield {"type": "error", "message": "Google API key not configured. Go to Settings > General to set it."}
            return
        yield from google.stream_chat(api_key=key, model=model, messages=messages)

    elif provider == "nvidia":
        key = api_key or os.getenv("NVIDIA_API_KEY")
        if not key:
            yield {"type": "error", "message": "NVIDIA API key not configured. Go to Settings > General to set it."}
            return
        yield from nvidia.stream_chat(api_key=key, model=model, messages=messages, base_url=base_url)

    elif provider == "openai":
        key = api_key or os.getenv("OPENAI_API_KEY")
        if not key:
            yield {"type": "error", "message": "OpenAI API key not configured. Go to Settings > General to set it."}
            return
        yield from openai.stream_chat(api_key=key, model=model, messages=messages)

    elif provider == "vllm":
        endpoint = base_url or os.getenv("VLLM_ENDPOINT", "http://localhost:8000")
        # Ensure endpoint ends with /v1 for OpenAI-compatible API
        if not endpoint.rstrip('/').endswith('/v1'):
            endpoint = endpoint.rstrip('/') + '/v1'
        yield from vllm.stream_chat(
            endpoint=endpoint,
            model=model,
            messages=messages,
            api_key=api_key,
        )

    elif provider == "ollama":
        host = base_url or os.getenv("OLLAMA_HOST", "http://localhost:11434")
        yield from ollama.stream_chat(host=host, model=model, messages=messages)

    else:
        yield {"type": "error", "message": f"Unknown provider: {provider}"}


def nl_to_command(
    nl_query: str,
    shell: str = "bash",
    cwd: str = "",
    profile: str = "default",
) -> str:
    """
    Translate natural language to a shell command.

    Args:
        nl_query: Natural language description of what the user wants to do
        shell: Shell type (bash, zsh, powershell, etc.)
        cwd: Current working directory for context
        profile: Model profile ("default", "quality", "budget")

    Returns:
        A shell command string

    Raises:
        Exception if translation fails
    """
    # Import complete function
    from ccie_sidecar.providers.anthropic import complete

    # Load API key from environment
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY environment variable not set")

    # Map profile to model
    from ccie_sidecar.providers.anthropic import SUPPORTED_MODELS
    model_map = {
        "default": "claude-sonnet-4-6",
        "quality": "claude-opus-4-7",
        "budget": "claude-haiku-4-5",
    }
    model = model_map.get(profile, "claude-sonnet-4-6")

    # Build system prompt with context
    system_prompt = f"""You are a shell command expert. Convert natural language to a single shell command.

Context:
- Shell: {shell}
- Working directory: {cwd or "unknown"}
- OS: {os.uname().sysname if hasattr(os, 'uname') else 'unknown'}

Rules:
1. Return ONLY the command, no explanation, no markdown, no quotes
2. The command should be safe and not destructive without confirmation
3. Use common, well-known command-line tools
4. If the request is ambiguous, make a reasonable assumption
5. Never return multi-line commands; use && or ; to chain if needed"""

    # Use complete function for non-streaming response
    response = complete(
        api_key=api_key,
        model=model,
        messages=[{"role": "user", "content": f"{system_prompt}\n\nUser request: {nl_query}"}],
        max_tokens=512,
    )

    # Clean up response - remove markdown code blocks if present
    command = response.strip()
    if command.startswith("```"):
        lines = command.split("\n")
        # Remove first and last lines if they're markdown delimiters
        if lines[0].startswith("```") and lines[-1].strip() == "```":
            command = "\n".join(lines[1:-1]).strip()
        # Handle inline code blocks
        elif lines[0].startswith("```"):
            command = "\n".join(lines[1:]).strip()

    # Remove backticks if present
    command = command.strip("`").strip()

    return command


def explain_api_response(
    method: str,
    url: str,
    status_code: int,
    body: str,
    profile: str = "default",  # kept for API compatibility; unused when saved config exists
) -> str:
    """
    Translate an HTTP JSON response into plain English a non-devops person
    can skim in 30 seconds.

    Uses the user's configured AI provider (Settings → General) via
    `get_saved_config()`. Falls back to the ANTHROPIC_API_KEY env var
    only if no provider has been configured in the app.

    The model is told to:
      * lead with a one-line takeaway ("You have 12 organizations."),
      * summarize counts / names / statuses instead of dumping fields,
      * call out anything unusual (errors, outages, license issues),
      * stay concise — no markdown tables of raw JSON, no code fences
        unless the user genuinely needs a copy-pasteable ID.

    Args:
        method: HTTP method of the request ("GET", "POST", ...).
        url: Full request URL, for context about what was asked.
        status_code: HTTP status. Non-2xx responses get a different framing.
        body: Decoded response body as text. Truncated upstream to fit the
              context window — we cap again here as defence-in-depth.
        profile: Legacy model-profile knob, ignored when the user has set
                 a specific provider+model in Settings.

    Returns:
        A human-friendly summary string. Plain text with light markdown.

    Raises:
        ValueError with a user-facing message when no provider is
        configured, or when the chosen provider fails.
    """
    # Keep the body manageable — 32 KB of JSON is plenty for a summary,
    # and the UI already caps response bodies at 10 MB. A stricter cap
    # here protects against hitting token limits on huge arrays.
    if len(body) > 32_000:
        body = body[:32_000] + "\n\n... (truncated)"

    ok = 200 <= status_code < 300
    framing = (
        "The request succeeded. Summarize what's in this response "
        "for a network engineer who knows networking but not the vendor API."
        if ok
        else "The request FAILED with a non-2xx status. Explain what went "
        "wrong and, if obvious, what to try next."
    )

    system_prompt = f"""You translate raw HTTP API responses into plain English
for network engineers who don't live in vendor API documentation.

{framing}

Rules:
1. Lead with a ONE-LINE takeaway. Then (optionally) 3-6 bullet points.
2. Use COUNTS and NAMES, not raw JSON. "8 devices: 6 switches, 2 APs." — not `{{...}}`.
3. Call out anything unusual: offline devices, expired licenses, non-default settings, auth errors.
4. If the response is a list of objects, summarize shape and give a couple of examples by name/id.
5. Only quote literal IDs/serials when the user likely needs to copy them.
6. NEVER dump the whole JSON. NEVER wrap everything in markdown tables.
7. Keep it under ~180 words unless there's legitimately a lot going on.
8. If the response is empty `[]` or `{{}}`, say so plainly.
"""

    user_prompt = f"""Request: {method} {url}
Status: {status_code}

Response body:
```
{body}
```

Give me the plain-English summary."""

    messages = [
        {
            "role": "user",
            "content": f"{system_prompt}\n\n{user_prompt}",
        }
    ]

    # Stream from the user's configured provider and concatenate. Works
    # across every backend (anthropic, openai, google, ollama, vllm)
    # without requiring a synchronous complete() method on each.
    saved = get_saved_config()
    if saved:
        provider = saved["provider"]
        model = saved["model"]
        api_key = saved.get("api_key")
        base_url = saved.get("base_url")
    else:
        provider = "anthropic"
        model = "claude-sonnet-4-6"
        api_key = os.getenv("ANTHROPIC_API_KEY")
        base_url = None
        if not api_key:
            raise ValueError(
                "No AI provider configured. Open Settings → General and "
                "pick a provider + model (or set ANTHROPIC_API_KEY)."
            )

    if provider == "anthropic":
        key = api_key or os.getenv("ANTHROPIC_API_KEY")
        if not key:
            raise ValueError(
                "Anthropic API key not configured. Open Settings → General "
                "to set it."
            )
        stream = anthropic.stream_chat(api_key=key, model=model, messages=messages)
    elif provider == "google":
        key = api_key or os.getenv("GOOGLE_API_KEY")
        if not key:
            raise ValueError(
                "Google API key not configured. Open Settings → General "
                "to set it."
            )
        stream = google.stream_chat(api_key=key, model=model, messages=messages)
    elif provider == "nvidia":
        key = api_key or os.getenv("NVIDIA_API_KEY")
        if not key:
            raise ValueError(
                "NVIDIA API key not configured. Open Settings → General "
                "to set it."
            )
        stream = nvidia.stream_chat(api_key=key, model=model, messages=messages, base_url=base_url)
    elif provider == "openai":
        key = api_key or os.getenv("OPENAI_API_KEY")
        if not key:
            raise ValueError(
                "OpenAI API key not configured. Open Settings → General "
                "to set it."
            )
        stream = openai.stream_chat(api_key=key, model=model, messages=messages)
    elif provider == "vllm":
        endpoint = base_url or os.getenv("VLLM_ENDPOINT", "http://localhost:8000")
        if not endpoint.rstrip("/").endswith("/v1"):
            endpoint = endpoint.rstrip("/") + "/v1"
        stream = vllm.stream_chat(
            endpoint=endpoint, model=model, messages=messages, api_key=api_key
        )
    elif provider == "ollama":
        host = base_url or os.getenv("OLLAMA_HOST", "http://localhost:11434")
        stream = ollama.stream_chat(host=host, model=model, messages=messages)
    else:
        raise ValueError(f"Unknown provider: {provider}")

    # Collect tokens; surface provider errors as ValueError so the
    # Rust/Tauri command surfaces them as the returned `error` string.
    parts: list[str] = []
    for event in stream:
        etype = event.get("type")
        if etype == "token":
            parts.append(event.get("data", ""))
        elif etype == "error":
            raise ValueError(event.get("message", "provider error"))
        # Ignore 'done' and any other event types.
    return "".join(parts).strip()


def explain_netconf_response(
    operation: str,
    response_xml: str,
    profile: str = "default",
) -> str:
    """
    Translate a NETCONF XML response into plain English for network engineers.

    Uses the user's configured AI provider (Settings → General) via
    `get_saved_config()`. Falls back to the ANTHROPIC_API_KEY env var
    only if no provider has been configured in the app.

    Args:
        operation: NETCONF operation (e.g., "get-config", "edit-config", "get")
        response_xml: Full XML response from the device
        profile: Legacy model-profile knob, ignored when the user has set
                 a specific provider+model in Settings.

    Returns:
        A human-friendly summary string. Plain text with light markdown.

    Raises:
        ValueError with a user-facing message when no provider is
        configured, or when the chosen provider fails.
    """
    # Keep the XML manageable
    if len(response_xml) > 50_000:
        response_xml = response_xml[:50_000] + "\n\n... (truncated)"

    # Check if response contains <ok/> or <rpc-error>
    has_ok = "<ok/>" in response_xml or "<ok />" in response_xml
    has_error = "<rpc-error>" in response_xml

    if has_error:
        framing = (
            "The NETCONF operation FAILED with an <rpc-error>. Explain what went "
            "wrong, extract the error-type, error-tag, and error-message, and "
            "suggest what to try next if it's obvious."
        )
    elif has_ok:
        framing = (
            "The NETCONF operation succeeded (received <ok/>). "
            "Briefly confirm what was done."
        )
    else:
        framing = (
            "The NETCONF operation returned data (not an error). Summarize what's "
            "in the response for a network engineer - focus on configuration state, "
            "operational data, or capabilities as appropriate."
        )

    system_prompt = f"""You translate NETCONF XML responses into plain English
for network engineers working with Cisco devices.

Operation: {operation}

{framing}

Rules:
1. Lead with a ONE-LINE takeaway. Then 3-6 bullet points if there's detail to unpack.
2. For <get-config> or <get> responses: summarize the configuration or operational data - don't dump raw XML paths, translate to human concepts (e.g., "3 interfaces configured: GigabitEthernet1, Loopback0, Loopback99").
3. For <rpc-error>: extract error-type, error-tag, error-message and explain in plain English what it means and how to fix it.
4. For <ok/> responses to edit-config or other operations: confirm what succeeded.
5. For capability lists: group by category (base NETCONF version, YANG models, vendor extensions).
6. NEVER dump raw XML unless quoting a specific error message. Use plain language.
7. Keep it under ~200 words unless there's a lot of structured data.
8. If the response is just <ok/>, say "Success" and briefly describe what the operation did.
"""

    user_prompt = f"""NETCONF Response:
```xml
{response_xml}
```

Give me the plain-English summary."""

    messages = [
        {
            "role": "user",
            "content": f"{system_prompt}\n\n{user_prompt}",
        }
    ]

    # Stream from the user's configured provider
    saved = get_saved_config()
    if saved:
        provider = saved["provider"]
        model = saved["model"]
        api_key = saved.get("api_key")
        base_url = saved.get("base_url")
    else:
        provider = "anthropic"
        model = "claude-sonnet-4-6"
        api_key = os.getenv("ANTHROPIC_API_KEY")
        base_url = None
        if not api_key:
            raise ValueError(
                "No AI provider configured. Open Settings → General and "
                "pick a provider + model (or set ANTHROPIC_API_KEY)."
            )

    if provider == "anthropic":
        key = api_key or os.getenv("ANTHROPIC_API_KEY")
        if not key:
            raise ValueError(
                "Anthropic API key not configured. Open Settings → General "
                "to set it."
            )
        stream = anthropic.stream_chat(api_key=key, model=model, messages=messages)
    elif provider == "google":
        key = api_key or os.getenv("GOOGLE_API_KEY")
        if not key:
            raise ValueError(
                "Google API key not configured. Open Settings → General "
                "to set it."
            )
        stream = google.stream_chat(api_key=key, model=model, messages=messages)
    elif provider == "nvidia":
        key = api_key or os.getenv("NVIDIA_API_KEY")
        if not key:
            raise ValueError(
                "NVIDIA API key not configured. Open Settings → General "
                "to set it."
            )
        stream = nvidia.stream_chat(api_key=key, model=model, messages=messages, base_url=base_url)
    elif provider == "openai":
        key = api_key or os.getenv("OPENAI_API_KEY")
        if not key:
            raise ValueError(
                "OpenAI API key not configured. Open Settings → General "
                "to set it."
            )
        stream = openai.stream_chat(api_key=key, model=model, messages=messages)
    elif provider == "vllm":
        endpoint = base_url or os.getenv("VLLM_ENDPOINT", "http://localhost:8000")
        if not endpoint.rstrip("/").endswith("/v1"):
            endpoint = endpoint.rstrip("/") + "/v1"
        stream = vllm.stream_chat(
            endpoint=endpoint, model=model, messages=messages, api_key=api_key
        )
    elif provider == "ollama":
        host = base_url or os.getenv("OLLAMA_HOST", "http://localhost:11434")
        stream = ollama.stream_chat(host=host, model=model, messages=messages)
    else:
        raise ValueError(f"Unknown provider: {provider}")

    # Collect tokens
    parts: list[str] = []
    for event in stream:
        etype = event.get("type")
        if etype == "token":
            parts.append(event.get("data", ""))
        elif etype == "error":
            raise ValueError(event.get("message", "provider error"))
    return "".join(parts).strip()


def explain_error_stream(
    cmd: str,
    output: str,
    exit_code: int,
    cwd: str,
    profile: str = "default",
) -> Iterator[dict[str, Any]]:
    """
    Stream an explanation and fix suggestion for a failed command.

    Args:
        cmd: The command that failed
        output: The stdout/stderr output
        exit_code: The exit code of the failed command
        cwd: The working directory where the command was run
        profile: Model profile to use

    Yields:
        Dicts with {"type": "token", "data": "..."} for tokens
        or {"type": "error", "message": "..."} for errors
    """
    # Use saved config first, fallback to profile
    config = get_saved_config()
    if config:
        provider = config["provider"]
        model = config["model"]
        saved_api_key = config.get("api_key")
        saved_base_url = config.get("base_url")
    else:
        provider, model = PROFILE_TO_PROVIDER_MODEL.get(profile, ("anthropic", "claude-sonnet-4-6"))
        saved_api_key = None
        saved_base_url = None

    system_prompt = """You are a shell debugging expert. Analyze failed commands and suggest fixes.

Your task:
1. Briefly explain what went wrong (1-2 sentences)
2. Provide a corrected command in a code block

Format your response as:
**Explanation:** [brief explanation]

**Suggested fix:**
```bash
[corrected command]
```

Be concise and actionable. Focus on the most likely fix."""

    user_message = f"""Command failed:
```
{cmd}
```

Exit code: {exit_code}
Working directory: {cwd}

Output:
```
{output[:1000]}
```

Please analyze this error and suggest a fix."""

    messages = [
        {"role": "user", "content": user_message}
    ]

    # Dispatch to appropriate provider using saved config
    if provider == "anthropic":
        key = saved_api_key or os.getenv("ANTHROPIC_API_KEY")
        if not key:
            yield {"type": "error", "message": "Anthropic API key not configured"}
            return
        yield from anthropic.stream_chat(api_key=key, model=model, messages=messages, system=system_prompt)
    elif provider == "google":
        key = saved_api_key or os.getenv("GOOGLE_API_KEY")
        if not key:
            yield {"type": "error", "message": "Google API key not configured"}
            return
        yield from google.stream_chat(api_key=key, model=model, messages=messages, system=system_prompt)
    elif provider == "nvidia":
        key = saved_api_key or os.getenv("NVIDIA_API_KEY")
        if not key:
            yield {"type": "error", "message": "NVIDIA API key not configured"}
            return
        yield from nvidia.stream_chat(api_key=key, model=model, messages=messages, system=system_prompt)
    elif provider == "openai":
        key = saved_api_key or os.getenv("OPENAI_API_KEY")
        if not key:
            yield {"type": "error", "message": "OpenAI API key not configured"}
            return
        yield from openai.stream_chat(api_key=key, model=model, messages=messages, system=system_prompt)
    elif provider == "vllm":
        endpoint = saved_base_url or os.getenv("VLLM_ENDPOINT", "http://localhost:8000")
        if not endpoint.rstrip('/').endswith('/v1'):
            endpoint = endpoint.rstrip('/') + '/v1'
        # Prepend system prompt as first message since vllm provider doesn't have system param
        vllm_messages = [{"role": "system", "content": system_prompt}] + messages
        yield from vllm.stream_chat(endpoint=endpoint, model=model, messages=vllm_messages, api_key=saved_api_key)
    elif provider == "ollama":
        host = saved_base_url or os.getenv("OLLAMA_HOST", "http://localhost:11434")
        ollama_messages = [{"role": "system", "content": system_prompt}] + messages
        yield from ollama.stream_chat(host=host, model=model, messages=ollama_messages)
    else:
        yield {"type": "error", "message": f"Unknown provider: {provider}"}


def explain_command(
    command: str,
    cwd: str,
    profile: str = "default",
) -> str:
    """
    Explain what a shell command does in plain English.

    Args:
        command: The shell command to explain
        cwd: Current working directory for context
        profile: Model profile to use

    Returns:
        Plain English explanation of what the command does

    Raises:
        ValueError if AI provider not configured or request fails
    """
    system_prompt = f"""You explain shell commands to network engineers in 2-3 sentences.

Working directory: {cwd}

Focus on:
1. What the command does (purpose)
2. Key flags/arguments and their effects
3. Expected output or side effects

Keep it concise and practical. No need to explain basic Unix concepts."""

    user_message = f"""Explain this shell command:

```
{command}
```"""

    messages = [
        {"role": "user", "content": f"{system_prompt}\n\n{user_message}"}
    ]

    # Use saved config first, fallback to profile
    config = get_saved_config()
    if config:
        provider = config["provider"]
        model = config["model"]
        api_key = config.get("api_key")
        base_url = config.get("base_url")
    else:
        provider, model = PROFILE_TO_PROVIDER_MODEL.get(profile, ("anthropic", "claude-sonnet-4-6"))
        api_key = None
        base_url = None

    # Stream from the configured provider and collect tokens
    if provider == "anthropic":
        key = api_key or os.getenv("ANTHROPIC_API_KEY")
        if not key:
            raise ValueError(
                "Anthropic API key not configured. Open Settings → General to set it."
            )
        stream = anthropic.stream_chat(api_key=key, model=model, messages=messages)
    elif provider == "google":
        key = api_key or os.getenv("GOOGLE_API_KEY")
        if not key:
            raise ValueError("Google API key not configured. Open Settings → General to set it.")
        stream = google.stream_chat(api_key=key, model=model, messages=messages)
    elif provider == "nvidia":
        key = api_key or os.getenv("NVIDIA_API_KEY")
        if not key:
            raise ValueError(
                "NVIDIA API key not configured. Open Settings → General "
                "to set it."
            )
        stream = nvidia.stream_chat(api_key=key, model=model, messages=messages, base_url=base_url)
    elif provider == "openai":
        key = api_key or os.getenv("OPENAI_API_KEY")
        if not key:
            raise ValueError("OpenAI API key not configured. Open Settings → General to set it.")
        stream = openai.stream_chat(api_key=key, model=model, messages=messages)
    elif provider == "vllm":
        endpoint = base_url or os.getenv("VLLM_ENDPOINT", "http://localhost:8000")
        if not endpoint.rstrip("/").endswith("/v1"):
            endpoint = endpoint.rstrip("/") + "/v1"
        stream = vllm.stream_chat(
            endpoint=endpoint, model=model, messages=messages, api_key=api_key
        )
    elif provider == "ollama":
        host = base_url or os.getenv("OLLAMA_HOST", "http://localhost:11434")
        stream = ollama.stream_chat(host=host, model=model, messages=messages)
    else:
        raise ValueError(f"Unknown provider: {provider}")

    # Collect tokens
    parts = []
    for event in stream:
        etype = event.get("type")
        if etype == "token":
            parts.append(event.get("data", ""))
        elif etype == "error":
            raise ValueError(event.get("message", "Unknown AI provider error"))

    return "".join(parts).strip()


def invoke_skill_manual(
    skill: dict[str, Any],
    args: str,
    context: dict[str, str],
    profile: str = "default",
) -> str:
    """
    Invoke a skill manually with the given arguments and context.

    Args:
        skill: Skill dictionary with name, description, playbook, scripts, etc.
        args: Arguments passed to the skill invocation
        context: Context dict with cwd, shell, etc.
        profile: Model profile to use

    Returns:
        AI response following the skill playbook

    Raises:
        Exception if invocation fails
    """
    # Import complete function
    from ccie_sidecar.providers.anthropic import complete

    # Load API key from environment
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY environment variable not set")

    # Map profile to model
    from ccie_sidecar.providers.anthropic import SUPPORTED_MODELS
    model_map = {
        "default": "claude-sonnet-4-6",
        "quality": "claude-opus-4-7",
        "budget": "claude-haiku-4-5",
    }
    model = model_map.get(profile, "claude-sonnet-4-6")

    # Build system prompt with skill context
    skill_name = skill.get("name", "unknown")
    skill_desc = skill.get("description", "")
    playbook = skill.get("playbook", "")
    scripts = skill.get("scripts", {})
    allowed_commands = skill.get("allowed-commands", [])

    system_prompt = f"""You are an expert network engineer with access to a specialized skill.

**Skill: {skill_name}**
{skill_desc}

**Playbook:**
{playbook}

**Context:**
- Working directory: {context.get('cwd', 'unknown')}
- Shell: {context.get('shell', 'bash')}

**Available scripts:**
{', '.join(scripts.keys()) if scripts else 'None'}

**Allowed commands:**
{', '.join(allowed_commands) if allowed_commands else 'None'}

Follow the playbook instructions to help the user. If scripts are available, mention them in your response.
Be concise and actionable."""

    # Build user message
    if args:
        user_message = f"User invoked skill '{skill_name}' with arguments: {args}"
    else:
        user_message = f"User invoked skill '{skill_name}'. Please provide guidance based on the playbook."

    # Use complete function for non-streaming response
    response = complete(
        api_key=api_key,
        model=model,
        messages=[{"role": "user", "content": user_message}],
        system=system_prompt,
        max_tokens=2048,
    )

    return response.strip()


def generate_skill(
    description: str,
    examples: str = "",
    profile: str = "default",
) -> dict[str, Any]:
    """
    Generate a skill definition (SKILL.md) and suggested scripts using AI.

    Args:
        description: Natural language description of what the skill should do
        examples: Optional example commands or usage scenarios
        profile: Model profile to use

    Returns:
        Dict with:
            - skill_md: The generated SKILL.md content
            - scripts: List of suggested scripts [{"name": str, "content": str}]

    Raises:
        Exception if generation fails
    """
    # Import complete function
    from ccie_sidecar.providers.anthropic import complete

    # Load API key from environment
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY environment variable not set")

    # Map profile to model
    model_map = {
        "default": "claude-sonnet-4-6",
        "quality": "claude-opus-4-7",
        "budget": "claude-haiku-4-5",
    }
    model = model_map.get(profile, "claude-sonnet-4-6")

    # Build system prompt
    system_prompt = """You are an expert at creating CCIE Terminal skills. Skills are defined in a SKILL.md file with YAML frontmatter.

Format for SKILL.md:
---
name: skill-name
description: Brief description of what the skill does
when-to-use: When to invoke this skill (be specific about triggers)
scripts:
  - script1.py
  - script2.sh
allowed-commands:
  - command1
  - command2
---

# Skill Name

## Overview
Detailed overview of the skill.

## Usage
How to use this skill, including example invocations.

## Implementation Details
How the skill works internally.

## Notes
Any additional notes or warnings.

Your task:
1. Generate a complete SKILL.md file following this format
2. Suggest 0-3 helper scripts if they would be useful
3. Return as JSON: {"skill_md": "...", "scripts": [{"name": "...", "content": "..."}]}

Guidelines:
- Keep skill names lowercase with hyphens (e.g., "network-audit")
- Be specific in when-to-use triggers
- Only suggest scripts if they add real value
- Scripts should be production-ready with error handling
- For Python scripts, include shebang and proper structure
- For shell scripts, use bash and include error handling"""

    # Build user message
    user_message = f"""Create a skill with the following requirements:

**Description:**
{description}
"""

    if examples:
        user_message += f"""
**Example commands/scenarios:**
{examples}
"""

    user_message += """
Generate a complete SKILL.md and any helpful scripts. Return as JSON."""

    # Use complete function for non-streaming response
    response = complete(
        api_key=api_key,
        model=model,
        messages=[{"role": "user", "content": user_message}],
        system=system_prompt,
        max_tokens=4096,
    )

    # Parse JSON response
    import json
    import re

    # Try to extract JSON from markdown code blocks if present
    cleaned_response = response.strip()
    if "```json" in cleaned_response:
        match = re.search(r'```json\s*\n(.*?)\n```', cleaned_response, re.DOTALL)
        if match:
            cleaned_response = match.group(1)
    elif "```" in cleaned_response:
        match = re.search(r'```\s*\n(.*?)\n```', cleaned_response, re.DOTALL)
        if match:
            cleaned_response = match.group(1)

    try:
        result = json.loads(cleaned_response)
    except json.JSONDecodeError as e:
        raise ValueError(f"Failed to parse AI response as JSON: {e}\nResponse: {cleaned_response[:200]}")

    # Validate result structure
    if "skill_md" not in result:
        raise ValueError("AI response missing 'skill_md' field")

    if "scripts" not in result:
        result["scripts"] = []

    return result


def check_skill_matches(user_query: str, threshold: float = 0.7) -> list[dict[str, Any]]:
    """
    Check if user query matches any skills with high confidence.

    Args:
        user_query: The user's query
        threshold: Minimum confidence threshold (default: 0.7)

    Returns:
        List of high-confidence skill matches
    """
    try:
        from ccie_sidecar.skills import match_skill
        matches = match_skill(user_query, max_results=3)

        # Filter by threshold
        high_confidence_matches = [
            m for m in matches if m.get("confidence", 0) >= threshold
        ]

        return high_confidence_matches
    except Exception as e:
        print(f"Skill matching failed: {e}")
        return []


def enrich_chat_with_skills(
    messages: list[dict[str, Any]],
    system_prompt: str | None = None,
) -> tuple[list[dict[str, Any]], str | None]:
    """
    Enrich chat messages with skill playbooks if relevant skills are detected.

    Args:
        messages: List of chat messages
        system_prompt: Optional system prompt to enrich

    Returns:
        Tuple of (enriched_messages, enriched_system_prompt)
    """
    # Get the last user message
    last_user_msg = None
    for msg in reversed(messages):
        if msg.get("role") == "user":
            last_user_msg = msg.get("content", "")
            break

    if not last_user_msg:
        return messages, system_prompt

    # Check for high-confidence skill matches
    matches = check_skill_matches(last_user_msg, threshold=0.7)

    if not matches:
        return messages, system_prompt

    # Load matched skills
    from ccie_sidecar.skills import get_skill

    skill_contexts = []
    for match in matches[:1]:  # Only use the top match to avoid context bloat
        skill = get_skill(match["skill_name"])
        if skill:
            playbook = skill.get("playbook", "")
            skill_name = skill.get("name", "unknown")
            when_to_use = skill.get("when-to-use", "")

            skill_context = f"""
**Relevant Skill: {skill_name}**
Trigger: {when_to_use}
Confidence: {match['confidence']:.0%}

{playbook}
"""
            skill_contexts.append(skill_context)

    if not skill_contexts:
        return messages, system_prompt

    # Enrich system prompt with skill context
    skill_addition = "\n\n".join(skill_contexts)
    if system_prompt:
        enriched_system = f"""{system_prompt}

# Relevant Skills

The following skills may be relevant to this conversation:

{skill_addition}

You may reference these playbooks in your response if helpful."""
    else:
        enriched_system = f"""# Relevant Skills

{skill_addition}

You may reference these playbooks in your response if helpful."""

    return messages, enriched_system


def explain_yang_module(
    module_name: str,
    yang_content: str,
    profile: str = "default",
) -> str:
    """
    Explain a YANG module in plain English for network engineers.

    Args:
        module_name: Name of the YANG module
        yang_content: Full YANG module content
        profile: AI model profile to use

    Returns:
        Plain English explanation of the module's purpose, structure, and key elements
    """
    # Truncate very large modules
    if len(yang_content) > 30_000:
        yang_content = yang_content[:30_000] + "\n\n... (truncated)"

    system_prompt = f"""You explain YANG data models to network engineers working with Cisco devices.

The user has opened the YANG module "{module_name}" and wants to understand:
1. What this module is for (high-level purpose)
2. Key configuration elements (containers, lists, leaf nodes)
3. Important operational state data (if any)
4. Common use cases or when they'd use this module

Rules:
1. Lead with a ONE-LINE summary of what this module does.
2. Then 4-8 bullet points covering:
   - Key top-level containers and what they configure/monitor
   - Important leaf nodes network engineers care about
   - Common use cases (e.g., "Use this to configure BGP neighbors")
3. Use plain network engineering terms, not generic XML/YANG jargon.
4. Focus on the "what" and "why", not the syntax details.
5. If this is an operational data module (-oper suffix), emphasize that it's read-only state.
6. Keep it under ~300 words unless the module is very complex.
7. Skip boilerplate like imports and typedefs unless they're essential to understanding.
"""

    user_prompt = f"""YANG Module: {module_name}

```yang
{yang_content}
```

Explain what this module does and when I'd use it."""

    messages = [
        {
            "role": "user",
            "content": f"{system_prompt}\n\n{user_prompt}",
        }
    ]

    # Use the user's configured provider
    saved = get_saved_config()
    if saved:
        provider = saved["provider"]
        model = saved["model"]
        api_key = saved.get("api_key")
        base_url = saved.get("base_url")
    else:
        provider = "anthropic"
        model = "claude-sonnet-4-6"
        api_key = os.getenv("ANTHROPIC_API_KEY")
        base_url = None

    # Stream from the configured provider
    if provider == "anthropic":
        key = api_key or os.getenv("ANTHROPIC_API_KEY")
        if not key:
            raise ValueError(
                "Anthropic API key not configured. Open Settings → General to set it."
            )
        stream = anthropic.stream_chat(api_key=key, model=model, messages=messages)
    elif provider == "google":
        key = api_key or os.getenv("GOOGLE_API_KEY")
        if not key:
            raise ValueError("Google API key not configured. Open Settings → General to set it.")
        stream = google.stream_chat(api_key=key, model=model, messages=messages)
    elif provider == "nvidia":
        key = api_key or os.getenv("NVIDIA_API_KEY")
        if not key:
            raise ValueError(
                "NVIDIA API key not configured. Open Settings → General "
                "to set it."
            )
        stream = nvidia.stream_chat(api_key=key, model=model, messages=messages, base_url=base_url)
    elif provider == "openai":
        key = api_key or os.getenv("OPENAI_API_KEY")
        if not key:
            raise ValueError("OpenAI API key not configured. Open Settings → General to set it.")
        stream = openai.stream_chat(api_key=key, model=model, messages=messages)
    elif provider == "vllm":
        endpoint = base_url or os.getenv("VLLM_ENDPOINT", "http://localhost:8000")
        if not endpoint.rstrip("/").endswith("/v1"):
            endpoint = endpoint.rstrip("/") + "/v1"
        stream = vllm.stream_chat(
            endpoint=endpoint, model=model, messages=messages, api_key=api_key
        )
    elif provider == "ollama":
        host = base_url or os.getenv("OLLAMA_HOST", "http://localhost:11434")
        stream = ollama.stream_chat(host=host, model=model, messages=messages)
    elif provider == "lmstudio":
        endpoint = base_url or os.getenv("LMSTUDIO_ENDPOINT", "http://localhost:1234")
        if not endpoint.rstrip("/").endswith("/v1"):
            endpoint = endpoint.rstrip("/") + "/v1"
        stream = lmstudio.stream_chat(endpoint=endpoint, model=model, messages=messages)
    else:
        raise ValueError(f"Unknown provider: {provider}")

    # Collect tokens
    parts = []
    for event in stream:
        etype = event.get("type")
        if etype == "token":
            parts.append(event.get("data", ""))
        elif etype == "error":
            raise ValueError(event.get("message", "Unknown AI provider error"))

    return "".join(parts).strip()
