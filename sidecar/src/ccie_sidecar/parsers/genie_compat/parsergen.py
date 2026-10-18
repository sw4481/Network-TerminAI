"""Stands in for genie.parsergen: oper_fill_tabular reads fixed-width CLI tables."""
import re

__all__ = ["oper_fill_tabular"]


class _Result:
    def __init__(self, entries):
        self.entries = entries


def _find_header(lines, header_fields):
    """Index of the first line containing every header regex in order, and their spans."""
    for i, line in enumerate(lines):
        spans, pos = [], 0
        for field in header_fields:
            match = re.compile(field).search(line, pos)
            if not match:
                break
            spans.append((match.start(), match.end()))
            pos = match.end()
        else:
            return i, spans
    return None, None


def _column_bounds(spans, right_justified):
    """Slice bounds for each column, taken from where its header sits."""
    last = len(spans) - 1
    if right_justified:
        ends = [end for _, end in spans]
        return [(ends[i - 1] if i else 0, ends[i] if i < last else None) for i in range(len(ends))]
    starts = [start for start, _ in spans]
    return [(starts[i] if i else 0, starts[i + 1] if i < last else None) for i in range(len(starts))]


def oper_fill_tabular(device_output="", header_fields=(), label_fields=None, index=None,
                      table_terminal_pattern=None, right_justified=False,
                      device_os=None, skip_line=None, **kwargs):
    """Parse every table whose header matches ``header_fields``.

    Rows are keyed by the ``index`` columns (nested for more than one) and
    each row maps ``label_fields`` (default: the headers) to its cell text.
    """
    labels = list(label_fields or header_fields)
    index = list(index if index is not None else [0])
    terminal = re.compile(table_terminal_pattern) if table_terminal_pattern else None
    lines = (device_output or "").splitlines()
    entries = {}
    start = 0
    while True:
        offset, spans = _find_header(lines[start:], header_fields)
        if offset is None:
            break
        bounds = _column_bounds(spans, right_justified)
        row = start + offset + 1
        while row < len(lines):
            line = lines[row]
            if terminal and terminal.match(line + "\n"):
                break
            if not line.strip():
                if terminal is None:
                    break
                row += 1
                continue
            if re.match(r"^\s*-{3,}[-\s]*$", line) or (skip_line and re.search(skip_line, line)):
                row += 1
                continue
            values = [line[a:b].strip() if b is not None else line[a:].strip() for a, b in bounds]
            node = entries
            for col in index[:-1]:
                node = node.setdefault(values[col], {})
            node[values[index[-1]]] = dict(zip(labels, values))
            row += 1
        start = row + 1
    return _Result(entries)
