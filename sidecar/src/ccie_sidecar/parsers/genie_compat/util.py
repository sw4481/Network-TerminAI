"""Stands in for genie.metaparser.util."""


def merge_dict(destination, source, update=True):
    """Recursively merge source into destination and return destination."""
    for key, value in (source or {}).items():
        if isinstance(value, dict) and isinstance(destination.get(key), dict):
            merge_dict(destination[key], value, update)
        elif update or key not in destination:
            destination[key] = value
    return destination


def keynames_convert(data, keynames):
    """Rename keys anywhere in a nested dict; keynames is a list of (old, new)."""
    mapping = dict(keynames)
    if isinstance(data, dict):
        return {mapping.get(k, k): keynames_convert(v, keynames) for k, v in data.items()}
    if isinstance(data, list):
        return [keynames_convert(v, keynames) for v in data]
    return data
