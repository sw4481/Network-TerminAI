"""Stands in for genie.metaparser.util.schemaengine: the schema checker parsers declare."""
from .exceptions import (
    SchemaError,
    SchemaMissingKeyError,
    SchemaTypeError,
    SchemaUnsupportedKeyError,
    SchemaValueError,
)

__all__ = ["Schema", "Optional", "Any", "Or", "And", "Use", "Default",
           "ListOf", "SchemaTypeError", "SchemaError"]


class Any:
    """Matches any key or value."""

    def __init__(self, *args, **kwargs):
        pass

    def __repr__(self):
        return "Any()"


class Optional:
    """A dict key that may be absent."""

    def __init__(self, schema, default=None, **kwargs):
        self.schema = schema
        self.default = default

    def __repr__(self):
        return f"Optional({self.schema!r})"


class Default(Optional):
    """An optional key filled with a default value when absent."""


class Or:
    def __init__(self, *schemas):
        self.schemas = schemas


class And:
    def __init__(self, *schemas):
        self.schemas = schemas


class Use:
    """Validates by calling a function; its return value replaces the data."""

    def __init__(self, func):
        self.func = func


class ListOf:
    def __init__(self, schema):
        self.schema = schema


class Schema:
    def __init__(self, schema, *args, **kwargs):
        self.schema = schema

    def validate(self, data):
        return _validate(self.schema, data, ())


def _is_literal(key):
    return isinstance(key, (str, int, float, bool, tuple))


def _validate(schema, data, path):
    if isinstance(schema, Schema):
        # Subclasses may override validate(); plain Schemas recurse directly.
        if type(schema).validate is not Schema.validate:
            return schema.validate(data)
        return _validate(schema.schema, data, path)
    if isinstance(schema, Any):
        return data
    if isinstance(schema, Optional):
        return _validate(schema.schema, data, path)
    if isinstance(schema, Use):
        try:
            return schema.func(data)
        except SchemaError:
            raise
        except Exception as exc:
            raise SchemaValueError(f"{path}: {exc}") from exc
    if isinstance(schema, Or):
        errors = []
        for sub in schema.schemas:
            try:
                return _validate(sub, data, path)
            except SchemaError as exc:
                errors.append(exc)
        raise SchemaTypeError(f"{path}: {data!r} matches none of {errors}")
    if isinstance(schema, And):
        for sub in schema.schemas:
            data = _validate(sub, data, path)
        return data
    if isinstance(schema, ListOf):
        if not isinstance(data, list):
            raise SchemaTypeError(f"{path}: expected a list, got {type(data).__name__}")
        return [_validate(schema.schema, item, path + (i,)) for i, item in enumerate(data)]
    if isinstance(schema, dict):
        return _validate_dict(schema, data, path)
    if isinstance(schema, (list, tuple)):
        return _validate_list(schema, data, path)
    if isinstance(schema, type):
        if not isinstance(data, schema):
            raise SchemaTypeError(
                f"{path}: expected {schema.__name__}, got {type(data).__name__} {data!r}")
        return data
    if callable(schema):
        try:
            result = schema(data)
        except SchemaError:
            raise
        except Exception as exc:
            raise SchemaValueError(f"{path}: {exc}") from exc
        if result is False:
            raise SchemaValueError(f"{path}: {data!r} rejected by {schema!r}")
        return data
    if schema != data:
        raise SchemaValueError(f"{path}: expected {schema!r}, got {data!r}")
    return data


def _validate_list(schema, data, path):
    if not isinstance(data, (list, tuple)):
        raise SchemaTypeError(f"{path}: expected a list, got {type(data).__name__}")
    if not schema:
        return data
    out = []
    for i, item in enumerate(data):
        for sub in schema:
            try:
                out.append(_validate(sub, item, path + (i,)))
                break
            except SchemaError:
                continue
        else:
            raise SchemaTypeError(f"{path + (i,)}: {item!r} matches no list schema")
    return type(data)(out)


def _key_matches(skey, dkey, path):
    if isinstance(skey, Optional):
        skey = skey.schema
    if _is_literal(skey):
        return skey == dkey
    try:
        _validate(skey, dkey, path)
        return True
    except SchemaError:
        return False


def _validate_dict(schema, data, path):
    if not isinstance(data, dict):
        raise SchemaTypeError(f"{path}: expected a dict, got {type(data).__name__}")
    # Literal keys match by name; Any(), types and Or() keys match whatever is left.
    literal = {}
    wildcard = []
    for skey, sval in schema.items():
        inner = skey.schema if isinstance(skey, Optional) else skey
        if _is_literal(inner):
            literal[inner] = (skey, sval)
        else:
            wildcard.append((skey, sval))

    out = {}
    for dkey, dval in data.items():
        sub = path + (dkey,)
        if dkey in literal:
            out[dkey] = _validate(literal[dkey][1], dval, sub)
            continue
        last_error = None
        for skey, sval in wildcard:
            if not _key_matches(skey, dkey, sub):
                continue
            try:
                out[dkey] = _validate(sval, dval, sub)
                break
            except SchemaError as exc:
                last_error = exc
        else:
            if last_error is not None:
                raise last_error
            raise SchemaUnsupportedKeyError(f"{path}: unexpected key {dkey!r}")

    for key, (skey, _) in literal.items():
        if key in out:
            continue
        if isinstance(skey, Default):
            out[key] = skey.default
        elif not isinstance(skey, Optional):
            raise SchemaMissingKeyError(f"{path}: missing required key {key!r}")
    return out
