"""Sidecar heartbeat emission (Plan 00 / Task 3.3)."""
import json
import os
import subprocess
import sys
import time


def _spawn(heartbeat_s: str = "1") -> subprocess.Popen:
    env = {**os.environ, "CCIE_SIDECAR_HEARTBEAT_S": heartbeat_s}
    return subprocess.Popen(
        [sys.executable, "-m", "ccie_sidecar.server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        env=env,
    )


def test_emits_initial_heartbeat_on_startup():
    proc = _spawn("1")
    try:
        line = proc.stdout.readline()
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    msg = json.loads(line)
    assert msg["type"] == "sidecar.heartbeat"
    payload = msg["payload"]
    assert "version" in payload
    assert isinstance(payload["pid"], int) and payload["pid"] > 0
    assert payload["uptime_s"] >= 0


def test_heartbeat_does_not_interleave_with_responses():
    proc = _spawn("1")
    try:
        # Issue a ping immediately. Response must be valid JSON on its own line
        # despite the heartbeat thread also writing.
        proc.stdin.write(json.dumps({"id": "1", "method": "ping", "params": {}}) + "\n")
        proc.stdin.flush()

        # Read up to 5 lines looking for the ping response and at least one
        # heartbeat. Neither should be truncated or interleaved.
        saw_pong = False
        saw_heartbeat = False
        # Windows CI cold-starts slowly (heavy first-request imports), so the
        # ping response can take several seconds to appear; use a generous
        # deadline to avoid a spurious "no ping response observed".
        deadline = time.time() + 30
        while (not saw_pong or not saw_heartbeat) and time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                break
            msg = json.loads(line)  # <-- corruption would raise here
            if msg.get("id") == "1" and msg.get("type") == "done":
                assert msg["result"] == "pong"
                saw_pong = True
            elif msg.get("type") == "sidecar.heartbeat":
                saw_heartbeat = True
        assert saw_pong, "no ping response observed"
        assert saw_heartbeat, "no heartbeat observed"
    finally:
        proc.terminate()
        proc.wait(timeout=5)
