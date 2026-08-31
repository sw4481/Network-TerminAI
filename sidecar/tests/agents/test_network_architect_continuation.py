"""Network Architect-only checkpoint configuration regression tests."""


def test_only_network_architect_gets_ordinary_step_limit_continuation():
    from ccie_sidecar.agents.deepagents_runtime import _continuation_options

    architect_kwargs, architect_thread, architect_enabled = _continuation_options(
        "network-architect",
        {"run_id": "architect-run-123"},
    )
    assert architect_thread == "architect-run-123"
    assert architect_enabled is True
    assert architect_kwargs.get("checkpointer") is not None

    zabbix_kwargs, zabbix_thread, zabbix_enabled = _continuation_options(
        "zabbix",
        {"run_id": "must-not-enable"},
    )
    assert zabbix_kwargs == {}
    assert zabbix_thread == "default"
    assert zabbix_enabled is False

    terminal_kwargs, terminal_thread, terminal_enabled = _continuation_options(
        "network-architect",
        {"terminal_context": {"turn_id": "terminal-turn-1"}},
    )
    assert terminal_kwargs == {}
    assert terminal_thread == "terminal-turn-1"
    assert terminal_enabled is False
