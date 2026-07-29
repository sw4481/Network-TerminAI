"""run-pyats-code verb: execute raw Python with testbed pre-bound (computed blast radius)."""

from typing import Any, Dict


def run_pyats_code(testbed, code: str, **kwargs) -> Dict[str, Any]:
    """Execute raw pyATS Python code (testbed pre-bound).

    Args:
        testbed: Genie Testbed object
        code: Python code to execute
        **kwargs: Unused

    Returns:
        Envelope with execution result

    Note:
        Blast radius is computed based on code content (see blast_radius.py).
        The code has access to 'testbed' variable in its namespace.
    """
    try:
        # Build execution namespace
        namespace = {
            "testbed": testbed,
            "__builtins__": __builtins__,
        }

        # Execute code and capture result
        exec(code, namespace)

        # Extract result if 'result' variable was set
        result = namespace.get("result", None)

        return {
            "ok": True,
            "data": {
                "code": code,
                "result": result,
            },
            "meta": {
                "verb": "run-pyats-code",
            }
        }

    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "code": "execution_failed",
                "message": str(exc),
                "hint": "Check Python syntax and testbed availability"
            }
        }
