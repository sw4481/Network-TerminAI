"""
AI-powered command intelligence for suggestions, completions, and analysis.
"""
import os
from typing import Dict, List, Any
from ccie_sidecar.agent import get_saved_config, PROFILE_TO_PROVIDER_MODEL

# Module-level singleton
_intelligence: 'CommandIntelligence | None' = None


class CommandIntelligence:
    """AI-powered command intelligence with class-based architecture."""

    def __init__(self):
        """Initialize CommandIntelligence."""
        pass

    def suggest_command(
        self,
        partial_command: str,
        cwd: str = "/",
        max_suggestions: int = 5,
        profile: str = "default",
        pane_context: str = "",
    ) -> Dict[str, Any]:
        """
        Suggest command completions based on partial input.

        Args:
            partial_command: The partial command typed so far
            cwd: Current working directory for context
            max_suggestions: Maximum number of suggestions to return
            profile: Model profile to use
            pane_context: Multi-pane workspace context (recent commands, output, errors)

        Returns:
            Dict with 'suggestions' list of {command, description, category}
        """
        # Build context-aware prompt
        prompt = f"""You are a shell command assistant. Given a partial command, suggest {max_suggestions} completions.

Partial command: {partial_command}
Working directory: {cwd}
"""

        # Inject pane context if provided
        if pane_context:
            prompt += f"\n{pane_context}\n"

        prompt += """
Provide practical, commonly-used completions. Focus on:
1. Flags and options for the command being typed
2. Similar commands if the partial is ambiguous
3. Network/system admin commands (user is a network engineer)

Format each suggestion as:
command: <full command>
description: <brief explanation>
category: <optional: flags|commands|aliases>

Keep descriptions under 50 characters."""

        try:
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

            # Use the configured provider's stream_chat
            from ccie_sidecar.providers import get_stream_chat_for_provider

            stream_fn = get_stream_chat_for_provider(provider)
            if not stream_fn:
                raise ValueError(f"Provider '{provider}' not supported for command intelligence")

            # Collect streamed response
            parts: List[str] = []
            messages = [{"role": "user", "content": prompt}]

            # vLLM and Ollama use endpoint parameter instead of api_key
            if provider in ("vllm", "ollama"):
                endpoint = base_url or (os.getenv("VLLM_ENDPOINT", "http://localhost:8000") if provider == "vllm" else "http://localhost:11434")
                if provider == "vllm" and not endpoint.rstrip("/").endswith("/v1"):
                    endpoint = endpoint.rstrip("/") + "/v1"
                for event in stream_fn(endpoint=endpoint, model=model, messages=messages, max_tokens=500):
                    etype = event.get("type")
                    if etype == "token":
                        parts.append(event.get("data", ""))
                    elif etype == "error":
                        raise ValueError(event.get("message", "AI provider error"))
            else:
                for event in stream_fn(api_key=api_key, model=model, messages=messages, max_tokens=500):
                    etype = event.get("type")
                    if etype == "token":
                        parts.append(event.get("data", ""))
                    elif etype == "error":
                        raise ValueError(event.get("message", "AI provider error"))

            text = "".join(parts).strip()

            # Parse response into structured suggestions
            suggestions = _parse_suggestions(text)

            return {
                "suggestions": suggestions[:max_suggestions]
            }

        except Exception as e:
            import logging
            logger = logging.getLogger(__name__)
            logger.error(f"Failed to suggest command: {e}")
            return {"suggestions": []}

    def natural_to_command(
        self,
        natural_language: str,
        cwd: str = "/",
        profile: str = "default",
        pane_context: str = "",
    ) -> Dict[str, Any]:
        """
        Convert natural language description to shell command.

        Args:
            natural_language: Plain English description of desired command
            cwd: Current working directory for context
            profile: Model profile to use
            pane_context: Multi-pane workspace context (recent commands, output, errors)

        Returns:
            Dict with 'command' (shell command) and 'explanation' (what it does)
        """
        prompt = f"""You are a shell command expert. Convert this natural language request into a shell command.

Request: {natural_language}
Working directory: {cwd}
User context: Network engineer working with Cisco/network devices
"""

        # Inject pane context if provided
        if pane_context:
            prompt += f"\n{pane_context}\n"

        prompt += """
Provide:
1. The exact shell command to run
2. A brief explanation of what it does

Format your response as:
command: <shell command>
explanation: <brief explanation>

Guidelines:
- Use common, safe commands
- Prefer widely-available tools (grep, find, awk, etc.)
- For network tasks, consider ping, ssh, curl, netstat, etc.
- Be specific with paths when relevant
- Include necessary flags for safety (e.g., -i for rm)
"""

        try:
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

            # Use the configured provider's stream_chat
            from ccie_sidecar.providers import get_stream_chat_for_provider

            stream_fn = get_stream_chat_for_provider(provider)
            if not stream_fn:
                raise ValueError(f"Provider '{provider}' not supported for command intelligence")

            # Collect streamed response
            parts: List[str] = []
            messages = [{"role": "user", "content": prompt}]

            # vLLM and Ollama use endpoint parameter instead of api_key
            if provider in ("vllm", "ollama"):
                endpoint = base_url or (os.getenv("VLLM_ENDPOINT", "http://localhost:8000") if provider == "vllm" else "http://localhost:11434")
                if provider == "vllm" and not endpoint.rstrip("/").endswith("/v1"):
                    endpoint = endpoint.rstrip("/") + "/v1"
                for event in stream_fn(endpoint=endpoint, model=model, messages=messages, max_tokens=400):
                    etype = event.get("type")
                    if etype == "token":
                        parts.append(event.get("data", ""))
                    elif etype == "error":
                        raise ValueError(event.get("message", "AI provider error"))
            else:
                for event in stream_fn(api_key=api_key, model=model, messages=messages, max_tokens=400):
                    etype = event.get("type")
                    if etype == "token":
                        parts.append(event.get("data", ""))
                    elif etype == "error":
                        raise ValueError(event.get("message", "AI provider error"))

            text = "".join(parts).strip()

            # Parse response
            command = None
            explanation = None

            for line in text.split('\n'):
                line = line.strip()
                if line.startswith('command:'):
                    command = line.replace('command:', '').strip()
                elif line.startswith('explanation:'):
                    explanation = line.replace('explanation:', '').strip()

            if not command:
                raise ValueError("Failed to extract command from response")

            return {
                "command": command,
                "explanation": explanation or "No explanation provided"
            }

        except Exception as e:
            import logging
            logger = logging.getLogger(__name__)
            logger.error(f"Failed to convert natural language to command: {e}")
            raise

    def analyze_error(
        self,
        command: str,
        output: str,
        exit_code: int,
        cwd: str = "/",
        profile: str = "default",
        pane_context: str = "",
    ) -> Dict[str, Any]:
        """
        Analyze a failed command and provide error categorization and fix suggestions.

        Args:
            command: The command that failed
            output: The stdout/stderr output
            exit_code: The exit code of the failed command
            cwd: Current working directory for context
            profile: Model profile to use
            pane_context: Multi-pane workspace context (recent commands, output, errors)

        Returns:
            Dict with 'error_type', 'explanation', and 'suggestions' (list of fix commands)
        """
        # Categorize common error patterns first
        error_type = self._categorize_error(command, output, exit_code)

        prompt = f"""You are a shell debugging expert. Analyze this failed command and provide fixes.

Command: {command}
Exit code: {exit_code}
Working directory: {cwd}

Output:
{output[:1000]}

Error category: {error_type}
"""

        # Inject pane context if provided
        if pane_context:
            prompt += f"\n{pane_context}\n"

        prompt += """
Provide:
1. A brief explanation (1-2 sentences) of what went wrong
2. 2-3 practical fix suggestions (actual commands the user can run)

Format your response as:
explanation: <brief explanation>
suggestion: <fix command 1>
suggestion: <fix command 2>
suggestion: <fix command 3>

Focus on the most common solutions first."""

        try:
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

            # Use the configured provider's stream_chat
            from ccie_sidecar.providers import get_stream_chat_for_provider

            stream_fn = get_stream_chat_for_provider(provider)
            if not stream_fn:
                raise ValueError(f"Provider '{provider}' not supported for command intelligence")

            # Collect streamed response
            parts: List[str] = []
            messages = [{"role": "user", "content": prompt}]

            # vLLM and Ollama use endpoint parameter instead of api_key
            if provider in ("vllm", "ollama"):
                endpoint = base_url or (os.getenv("VLLM_ENDPOINT", "http://localhost:8000") if provider == "vllm" else "http://localhost:11434")
                if provider == "vllm" and not endpoint.rstrip("/").endswith("/v1"):
                    endpoint = endpoint.rstrip("/") + "/v1"
                for event in stream_fn(endpoint=endpoint, model=model, messages=messages, max_tokens=500):
                    etype = event.get("type")
                    if etype == "token":
                        parts.append(event.get("data", ""))
                    elif etype == "error":
                        raise ValueError(event.get("message", "AI provider error"))
            else:
                for event in stream_fn(api_key=api_key, model=model, messages=messages, max_tokens=500):
                    etype = event.get("type")
                    if etype == "token":
                        parts.append(event.get("data", ""))
                    elif etype == "error":
                        raise ValueError(event.get("message", "AI provider error"))

            text = "".join(parts).strip()

            # Parse response
            explanation = None
            suggestions: List[str] = []

            for line in text.split('\n'):
                line = line.strip()
                if line.startswith('explanation:'):
                    explanation = line.replace('explanation:', '').strip()
                elif line.startswith('suggestion:'):
                    suggestion = line.replace('suggestion:', '').strip()
                    if suggestion:
                        suggestions.append(suggestion)

            if not explanation:
                explanation = "Command failed with an error."

            return {
                "error_type": error_type,
                "explanation": explanation,
                "suggestions": suggestions[:3]  # Limit to 3 suggestions
            }

        except Exception as e:
            import logging
            logger = logging.getLogger(__name__)
            logger.error(f"Failed to analyze error: {e}")
            raise

    def _categorize_error(self, command: str, output: str, exit_code: int) -> str:
        """
        Categorize error based on command, output, and exit code.

        Returns:
            Error category string (e.g., 'command_not_found', 'permission_denied', etc.)
        """
        output_lower = output.lower()

        # Command not found
        if 'command not found' in output_lower or 'not recognized' in output_lower:
            return 'command_not_found'

        # Permission denied
        if 'permission denied' in output_lower or 'access denied' in output_lower:
            return 'permission_denied'

        # File/directory not found
        if 'no such file' in output_lower or 'does not exist' in output_lower:
            return 'file_not_found'

        # Syntax error
        if 'syntax error' in output_lower or 'invalid syntax' in output_lower:
            return 'syntax_error'

        # Network errors
        if any(x in output_lower for x in ['connection refused', 'timeout', 'unreachable', 'no route']):
            return 'network_error'

        # Resource errors
        if any(x in output_lower for x in ['disk full', 'no space', 'out of memory']):
            return 'resource_error'

        # Package/dependency errors
        if any(x in output_lower for x in ['not installed', 'missing dependency', 'cannot find package']):
            return 'dependency_error'

        # Generic failure based on exit code
        if exit_code == 1:
            return 'general_error'
        elif exit_code == 2:
            return 'usage_error'
        elif exit_code >= 126:
            return 'execution_error'

        return 'unknown_error'


def initialize() -> None:
    """Initialize the module-level CommandIntelligence singleton."""
    global _intelligence
    _intelligence = CommandIntelligence()


def get_instance() -> CommandIntelligence:
    """
    Get the module-level CommandIntelligence singleton.

    Returns:
        The CommandIntelligence instance

    Raises:
        RuntimeError: If initialize() hasn't been called yet
    """
    if _intelligence is None:
        raise RuntimeError("CommandIntelligence not initialized. Call initialize() first.")
    return _intelligence


def _parse_suggestions(text: str) -> List[Dict[str, str]]:
    """Parse AI response into structured suggestion list."""
    import logging
    logger = logging.getLogger(__name__)

    suggestions = []
    current = {}

    for line in text.split('\n'):
        line = line.strip()
        if not line:
            if current:
                suggestions.append(current)
                current = {}
            continue

        if line.startswith('command:'):
            current['command'] = line.replace('command:', '').strip()
        elif line.startswith('description:'):
            current['description'] = line.replace('description:', '').strip()
        elif line.startswith('category:'):
            current['category'] = line.replace('category:', '').strip()

    # Add final suggestion if exists
    if current and 'command' in current:
        suggestions.append(current)

    # Log when parsing fails or returns empty results
    if not suggestions:
        logger.warning(f"Failed to parse suggestions from AI response. Raw text: {text[:200]}")
    elif len(suggestions) == 0:
        logger.warning("AI response parsed but returned 0 suggestions")
    else:
        logger.debug(f"Successfully parsed {len(suggestions)} suggestions")

    return suggestions
