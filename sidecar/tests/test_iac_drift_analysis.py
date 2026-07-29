"""IaC Phase 3 — AI drift explanation. The analyzer must return per-resource
prose when the LLM responds, and degrade gracefully (empty analyses, never
raise) when the LLM call fails."""
from ccie_sidecar.agents.iac_drift_analysis import analyze_drift


def test_analyze_drift_returns_per_resource_analysis():
    drifted = [
        {"address": "aws_security_group.alb", "resource_type": "aws_security_group",
         "resource_name": "alb", "detected_changes": "drifted (update)"},
    ]

    def fake_llm(prompt: str) -> str:
        return (
            '{"analyses": [{"resource": "aws_security_group.alb",'
            '"explanation": "Ingress rule added manually.",'
            '"cause": "manual change", "recommendation": "import",'
            '"impact": "security exposure"}]}'
        )

    result = analyze_drift(drifted, plan_output="", llm=fake_llm)
    assert len(result["analyses"]) == 1
    assert result["analyses"][0]["resource"] == "aws_security_group.alb"
    assert result["analyses"][0]["recommendation"] == "import"


def test_analyze_drift_degrades_gracefully_on_llm_error():
    drifted = [{"address": "aws_instance.web", "resource_type": "aws_instance",
                "resource_name": "web", "detected_changes": "drifted (update)"}]

    def boom(prompt: str) -> str:
        raise RuntimeError("LLM unavailable")

    result = analyze_drift(drifted, plan_output="", llm=boom)
    assert result["analyses"] == []
    assert result.get("unavailable") is True


def test_rpc_iac_analyze_drift_dispatches(monkeypatch):
    import ccie_sidecar.server as server

    # Stub the analyzer so the test asserts wiring, not LLM behavior.
    monkeypatch.setattr(
        "ccie_sidecar.agents.iac_drift_analysis.analyze_drift",
        lambda drifted, plan_output, **kw: {"analyses": [{"resource": "r"}]},
    )
    resp = server.handle_request({
        "id": "1",
        "method": "iac.analyze_drift",
        "params": {"drifted": [{"address": "r"}], "plan_output": ""},
    })
    assert resp["type"] == "done"
    assert resp["result"]["analyses"][0]["resource"] == "r"


def test_rpc_iac_analyze_drift_requires_list():
    import ccie_sidecar.server as server
    resp = server.handle_request({
        "id": "2",
        "method": "iac.analyze_drift",
        "params": {"drifted": "not-a-list"},
    })
    assert resp["type"] == "error"
