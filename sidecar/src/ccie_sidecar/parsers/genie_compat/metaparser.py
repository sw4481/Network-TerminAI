"""Stands in for genie.metaparser: the base class every Genie parser subclasses."""
from .exceptions import SchemaEmptyParserError
from .schemaengine import Schema

__all__ = ["MetaParser"]


class MetaParser:
    schema = None

    def __init__(self, device=None, context="cli", **kwargs):
        self.device = device
        self.context = context
        for key, value in kwargs.items():
            setattr(self, key, value)

    def parse(self, **kwargs):
        """Run the parser's cli() and check the result against its schema."""
        contexts = self.context if isinstance(self.context, (list, tuple)) else [self.context]
        parsed = None
        for context in contexts:
            parsed = getattr(self, context)(**kwargs)
        if not parsed:
            raise SchemaEmptyParserError(data=parsed)
        if self.schema is not None:
            schema = self.schema if isinstance(self.schema, Schema) else Schema(self.schema)
            schema.validate(parsed)
        return parsed
