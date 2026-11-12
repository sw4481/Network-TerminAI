"""Bounded NDJSON TextFSM worker. Rust owns the 3s deadline and process lifetime.

Only supplied TextFSM text is interpreted; no command, path, hook or import is
accepted from a request. Nothing here initializes the application or AI sidecar.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import sys

import textfsm

MAX_REQUEST = 16 * 1024 * 1024  # Includes worst-case JSON escaping of 2MiB raw.
MAX_OUTPUT = 2 * 1024 * 1024
MAX_RAW = 2 * 1024 * 1024
MAX_TEMPLATE = 64 * 1024
MAX_ROWS = 10000


def encoded(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("ascii")


class ParserLimit(ValueError):
    pass


class BoundedRecords(list):
    def __init__(self, overhead):
        super().__init__()
        self.byte_count = overhead

    def append(self, record):
        self.byte_count += len(encoded(record)) + 1
        if len(self) >= MAX_ROWS or self.byte_count > MAX_OUTPUT:
            raise ParserLimit()
        super().append(record)


class BoundedOptions(textfsm.TextFSMOptions):
    class List(textfsm.TextFSMOptions.List):
        def OnAssignVar(self):
            fsm = self.value.fsm
            match = self.value.compiled_regex.match(self.value.value) if self.value.compiled_regex.groups > 1 else None
            if match and match.re.groupindex:
                item, size = {}, 2
                # groupdict() eagerly copies all nested captures before any limit check.
                for name in match.re.groupindex:
                    value = match.group(name)
                    size += len(encoded(name)) + 1 + len(encoded(value)) + bool(item)
                    if fsm.list_bytes + size + 1 > MAX_OUTPUT:
                        raise ParserLimit()
                    item[name] = value
            else:
                item = self.value.value
                size = len(encoded(item))
            if fsm.list_bytes + size + 1 > MAX_OUTPUT:
                raise ParserLimit()
            fsm.list_bytes += size + 1
            self._value.append(item)


class BoundedFSM(textfsm.TextFSM):
    def __init__(self, template):
        self.list_bytes = 0
        self.assignment_bytes = 0
        super().__init__(io.StringIO(template), options_class=BoundedOptions)

    def _AssignVar(self, matched, value):
        self.assignment_bytes += len(encoded(matched.group(value)))
        if self.assignment_bytes > MAX_OUTPUT:
            raise ParserLimit()
        super()._AssignVar(matched, value)

    def _CheckLine(self, line):
        # TextFSM 2.1.0's groupdict() eagerly copies every overlapping capture.
        for rule in self._cur_state:
            matched = self._CheckRule(rule, line)
            if matched:
                for value in matched.re.groupindex:
                    self._AssignVar(matched, value)
                if self._Operations(rule, line):
                    if rule.new_state:
                        if rule.new_state not in ("End", "EOF"):
                            self._cur_state = self.states[rule.new_state]
                        self._cur_state_name = rule.new_state
                    break


class TelemetryParserWorker:
    @staticmethod
    def diagnostic(request_id, code, message):
        return {"id": request_id, "diagnostic": {"code": code, "message": message,
            "path": "parser", "line": None, "column": None}}

    def handle(self, request: dict) -> dict:
        request_id = request.get("id") if isinstance(request, dict) else None
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
            request_id = None
        try:
            if (not isinstance(request, dict) or set(request) != {"id", "operation", "capture", "template"}
                    or request_id is None or request["operation"] != "parse"):
                raise ValueError()
            capture, template = request["capture"], request["template"]
            if (not isinstance(capture, dict) or not isinstance(template, dict)
                    or set(capture) != {"capture_id", "target_id", "platform", "command", "parser_id",
                        "revision", "observed_at_ms", "monotonic_ms", "raw"}
                    or set(template) != {"id", "platform", "command", "text", "sha256"}):
                raise ValueError()
            raw, text = capture["raw"], template["text"]
            if not isinstance(raw, str) or not isinstance(text, str):
                raise ValueError()
            if len(raw.encode("utf-8")) > MAX_RAW or len(text.encode("utf-8")) > MAX_TEMPLATE:
                raise ParserLimit()
            identity = ("capture_id", "target_id", "revision", "command", "parser_id")
            valid = all(isinstance(capture[k], str) and 1 <= len(capture[k].encode("utf-8")) <= 512 for k in identity)
            valid &= all(type(capture[k]) is int and capture[k] >= 0 for k in ("observed_at_ms", "monotonic_ms"))
            valid &= (isinstance(template["id"], str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", template["id"]) is not None)
            valid &= (capture["platform"] in ("ios", "iosxe") and capture["platform"] == template["platform"]
                and capture["command"] == template["command"] and capture["parser_id"] == template["id"]
                and hashlib.sha256(text.encode("utf-8")).hexdigest() == template["sha256"])
            if not valid:
                return self.diagnostic(request_id, "parser_binding", "Capture and template metadata do not match")
            fsm = BoundedFSM(text)
            headers = [name.lower() for name in fsm.header]
            if len(set(headers)) != len(headers):
                return self.diagnostic(request_id, "parser_template", "Template headers are ambiguous")
            reply = {"id": request_id, "headers": headers, "records": []}
            fsm._result = BoundedRecords(len(encoded(reply)))
            reply["records"] = fsm.ParseText(raw)
            if len(encoded(reply)) > MAX_OUTPUT:
                raise ParserLimit()
            return reply
        except ParserLimit:
            return self.diagnostic(request_id, "parser_limit", "Parser input or result exceeds its limit")
        except (textfsm.TextFSMError, textfsm.TextFSMTemplateError, re.error):
            return self.diagnostic(request_id, "parser_template", "Invalid TextFSM template or parse rule")
        except (ValueError, TypeError, KeyError, UnicodeError):
            return self.diagnostic(request_id, "parser_protocol", "Invalid parser request")

    def run(self):
        while True:
            line = sys.stdin.buffer.readline(MAX_REQUEST + 1)
            if not line:
                return
            if len(line) > MAX_REQUEST:
                reply = self.diagnostic(None, "parser_limit", "Parser request exceeds its limit")
                sys.stdout.buffer.write(encoded(reply) + b"\n")
                sys.stdout.buffer.flush()
                return  # Do not route a remainder as a new request.
            try:
                reply = self.handle(json.loads(line))
            except (ValueError, UnicodeError, RecursionError):
                reply = self.diagnostic(None, "parser_protocol", "Invalid parser JSON")
            sys.stdout.buffer.write(encoded(reply) + b"\n")
            sys.stdout.buffer.flush()


if __name__ == "__main__":
    TelemetryParserWorker().run()
