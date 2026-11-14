"""Check the same v1 examples exercised by Rust against editor hints (installed jsonschema)."""
import json
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator

root = Path(__file__).resolve().parents[4]
schema = json.loads((root / "src/features/telemetry/widget-schema.json").read_text())
examples = json.loads(Path(__file__).with_name("schema-examples.json").read_text())
Draft202012Validator.check_schema(schema)
validator = Draft202012Validator(schema)
for index, document in enumerate(examples["valid"]):
    validator.validate(document)
for index, document in enumerate(examples["invalid"]):
    assert not validator.is_valid(document), f"invalid example {index} passed"
for command, selected, valid in [
    ("show interfaces", 5, True), ("show interfaces", 7, True),
    ("show interfaces", 3600, True), ("show interfaces", 4, False),
    ("show interfaces", 3601, False), ("show version", 5, False),
    ("show interfaces", None, False),
]:
    document = deepcopy(examples["valid"][0])
    widget = document["widgets"][0]
    widget.update(source={"kind": "ssh", "commands": {"iosxe": command}, "templates": {"iosxe": "sample"}}, interval=30, selected_interval=selected)
    assert validator.is_valid(document) == valid, (command, selected)
local = deepcopy(examples["valid"][0])
local["widgets"][0]["selected_interval"] = 5
assert not validator.is_valid(local)
print(f"Schema parity: {len(examples['valid'])} accepted, {len(examples['invalid'])} rejected")
