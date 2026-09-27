# Fan-out CSV import format

A simple two-column CSV defines who joins a fan-out group.

## Header

The first line **must** be the literal header `device_kind,identifier`. Comments
(lines starting with `#`) and blank lines are ignored. If the first line does
not look like a header it is treated as a data row.

## Columns

| Column | Allowed values | Notes |
|---|---|---|
| `device_kind` | `ssh`, `netconf` | Anything else is reported as a warning. |
| `identifier`  | the saved connection's `id` (string) **or** `name` | Resolver tries `id` first, then case-insensitive `name`. |

## Resolver precedence

1. **Exact id match.** SSH ids are 32-char hex strings, NETCONF ids are integers.
2. **Case-insensitive name match.** `R1-ATL` matches `r1-atl`.

Rows that resolve to no device are returned in `warnings` (one entry per row);
they do **not** abort the import.

## Example

```csv
device_kind,identifier
ssh,r1-atl-core
ssh,r2-atl-core
netconf,xe1-atl-dist
# comment lines are skipped
netconf,12
```

## Result

`fanout_group_import_csv` returns:

```jsonc
{
  "added": 3,           // number of rows actually inserted (deduped vs. existing)
  "warnings": ["line 5: no netconf device matching '99'"]
}
```
