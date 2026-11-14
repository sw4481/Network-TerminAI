"""Stands in for genie.abstract and its package/decorator modules.

Parser packages declare their abstraction tokens at import time; command
lookup here uses parsers.json instead, so these are no-ops.
"""

DEFAULT_ABSTRACT_ORDER = ["os", "platform", "model", "submodel", "pid", "version", "revision"]


def declare_package(*args, **kwargs):
    pass


def declare_token(*args, **kwargs):
    pass


def with_deprecation_context(*args, **kwargs):
    def wrap(func):
        return func
    return wrap


class Lookup:
    def __init__(self, *args, **kwargs):
        raise NotImplementedError("genie.abstract.Lookup is not available without pyATS")


class AbstractTree:
    def __init__(self, *args, **kwargs):
        raise NotImplementedError("genie.abstract.AbstractTree is not available without pyATS")
