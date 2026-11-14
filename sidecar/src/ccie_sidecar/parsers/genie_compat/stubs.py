"""Names genie.libs.parser imports at module level but never needs for parsing."""


def banner(text, *args, **kwargs):
    return str(text)


def str_shortener(text, *args, **kwargs):
    return str(text)


def get_entry_points(*args, **kwargs):
    return []


class _Configuration(dict):
    def get(self, key, default=None, *args, **kwargs):
        return default


configuration = _Configuration()


class MakeParsers:
    """Builds parsers.json in real Genie; not needed at runtime."""

    def __init__(self, *args, **kwargs):
        pass
