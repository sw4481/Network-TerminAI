"""Stands in for pyats.utils.exceptions and genie.metaparser.util.exceptions."""


class SchemaError(Exception):
    """Base class for schema validation errors."""


class SchemaTypeError(SchemaError):
    pass


class SchemaValueError(SchemaError):
    pass


class SchemaMissingKeyError(SchemaError):
    pass


class SchemaUnsupportedKeyError(SchemaError):
    pass


class SchemaEmptyParserError(SchemaError):
    def __init__(self, *args, data=None, **kwargs):
        super().__init__(*args or ("Parser Output is empty",))
        self.data = data


class InvalidCommandError(Exception):
    pass
