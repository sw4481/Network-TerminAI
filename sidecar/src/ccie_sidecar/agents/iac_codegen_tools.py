"""IaC Phase 4 — codegen tools the IaC agent calls.

Each factory returns a LangChain StructuredTool whose `func` is synchronous
(matches build_iac_apply_tool). The tool returns a JSON string so the agent can
quote the code back to the user and decide whether to write it to a file (via
execute_python_code) and then call iac_apply. The LLM is injectable for tests;
the default builds the configured chat model and exposes a `str -> str` callable.
"""
from __future__ import annotations

import json
from typing import Callable, Optional

from langchain_core.tools import StructuredTool

from ccie_sidecar.agents.iac_codegen import (
    generate_ansible_playbook,
    generate_terraform_code,
)

LlmFn = Callable[[str], str]


def _make_default_llm() -> LlmFn:
    """Return a `str -> str` callable backed by the configured chat model,
    building the model lazily on first use and reusing it thereafter.

    The model is built at most once per tool (not per invocation). Provider/
    config imports are deferred so tests that inject an llm never touch them.
    """
    state: dict = {}

    def _call(prompt: str) -> str:
        model = state.get("model")
        if model is None:
            from ccie_sidecar.agent import get_saved_config
            from ccie_sidecar.providers.langchain_factory import build_chat_model
            model = build_chat_model(get_saved_config() or {})
            state["model"] = model
        from langchain_core.messages import HumanMessage
        resp = model.invoke([HumanMessage(content=prompt)])
        content = resp.content
        if isinstance(content, list):  # some providers return content blocks
            content = "".join(
                b.get("text", "") if isinstance(b, dict) else str(b)
                for b in content
            )
        if not isinstance(content, str):  # guard None/other provider returns
            content = "" if content is None else str(content)
        return content

    return _call


def build_terraform_codegen_tool(llm: Optional[LlmFn] = None) -> StructuredTool:
    """Build the `generate_terraform_code` tool."""
    call = llm or _make_default_llm()  # memoized; model built lazily on first use

    def generate(intent: str, working_dir: str = "", git_branch: str = "") -> str:
        result = generate_terraform_code(
            intent=intent,
            context={"project_path": working_dir, "git_branch": git_branch},
            llm=call,
        )
        return json.dumps(result)

    return StructuredTool.from_function(
        func=generate,
        name="generate_terraform_code",
        description=(
            "Generate Terraform HCL from a natural-language intent. Returns JSON "
            "with the generated code, a suggested filename, an explanation, and "
            "syntax-validation status. Does NOT apply anything — after generating, "
            "show the code to the user, write it to a .tf file with "
            "execute_python_code, then call iac_apply to apply (which requires "
            "human approval)."
        ),
    )


def build_ansible_codegen_tool(llm: Optional[LlmFn] = None) -> StructuredTool:
    """Build the `generate_ansible_playbook` tool."""
    call = llm or _make_default_llm()  # memoized; model built lazily on first use

    def generate(intent: str, working_dir: str = "", inventory_path: str = "") -> str:
        result = generate_ansible_playbook(
            intent=intent,
            context={"roles_path": working_dir, "inventory_path": inventory_path},
            llm=call,
        )
        return json.dumps(result)

    return StructuredTool.from_function(
        func=generate,
        name="generate_ansible_playbook",
        description=(
            "Generate an Ansible playbook (YAML) from a natural-language intent. "
            "Returns JSON with the playbook, a suggested filename, an explanation, "
            "and --syntax-check status. Does NOT run anything — show the playbook, "
            "write it to a .yml file with execute_python_code, then call iac_apply "
            "to run it (which requires human approval)."
        ),
    )


def build_default_codegen_llm() -> LlmFn:
    """Public seam for the codegen RPC: a `str -> str` callable backed by the
    Settings-page chat model (`get_saved_config()` + `build_chat_model()`).

    Separate from the tool factories so the RPC layer (server.py) can inject the
    same model the agent tools use, and tests can monkeypatch this one symbol to
    avoid any network call.
    """
    return _make_default_llm()
