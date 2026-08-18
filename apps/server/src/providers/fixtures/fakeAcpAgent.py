#!/usr/bin/python3

import json
import os
import signal
import subprocess
import sys
from pathlib import Path

mode = os.environ.get("FAKE_ACP_MODE", "ready")
root = Path(os.environ["FAKE_ACP_ROOT"])
agent_name = os.environ.get("FAKE_ACP_AGENT_NAME", "Fixture Agent")


def record(value: dict[str, object]) -> None:
    with (root / "records.jsonl").open("a", encoding="utf-8") as output:
        output.write(json.dumps(value, separators=(",", ":")) + "\n")


record(
    {
        "kind": "spawn",
        "args": sys.argv[1:],
        "cwd": os.getcwd(),
        "environment": {
            key: value for key, value in os.environ.items() if not key.startswith("FAKE_ACP_")
        },
    }
)
record({"kind": "pid", "pid": os.getpid()})

if mode in ("descendant", "stubborn-descendant"):
    command = (
        "trap '' TERM; while :; do sleep 1; done"
        if mode == "stubborn-descendant"
        else "while :; do sleep 1; done"
    )
    child = subprocess.Popen(
        ["/bin/sh", "-c", command],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    record({"kind": "pid", "pid": child.pid})


def terminate(_signal_number: int, _frame: object) -> None:
    record({"kind": "signal", "signal": "SIGTERM"})
    if mode != "stubborn-descendant":
        raise SystemExit(0)


signal.signal(signal.SIGTERM, terminate)

for line in sys.stdin:
    message = json.loads(line)
    record({"kind": "message", "id": message.get("id"), "method": message.get("method")})
    if message.get("method") != "initialize" or "id" not in message:
        continue
    response = {
        "jsonrpc": "2.0",
        "id": message["id"],
        "result": {
            "protocolVersion": 1,
            "agentCapabilities": {
                "loadSession": True,
                "promptCapabilities": {
                    "image": True,
                    "audio": False,
                    "embeddedContext": True,
                },
                "sessionCapabilities": {"close": {}, "list": {}, "fork": {}},
            },
            "authMethods": [{"id": "provider-auth"}],
            "agentInfo": {
                "name": agent_name,
                "title": "Fixture Agent",
                "version": "0.0.0-dev",
            },
            # Harmless for every other profile; required so the Grok profile's
            # `verifyAgentInfo` identity check (which ignores `agentInfo` the
            # way the real `grok` CLI does) still passes against this fixture.
            "_meta": {"grokShell": True},
        },
    }
    sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
    sys.stdout.flush()
