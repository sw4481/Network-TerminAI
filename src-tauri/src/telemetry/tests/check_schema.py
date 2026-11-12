"""Check the same v1 examples exercised by Rust against editor hints (installed jsonschema)."""
import json
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
print(f"Schema parity: {len(examples['valid'])} accepted, {len(examples['invalid'])} rejected")
