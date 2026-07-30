# Theme color domain allowlist

Structural UI color must use the semantic variables in `src/theme/themes.css`.
`scripts/check-structural-colors.mjs` rejects every newly added CSS/TSX color
literal, reporting file, line, value, and property from the actual Git
merge-base diff. `src/theme/color-literal-allowlist.json` is the only escape
hatch: each entry must name an exact source path, exact value, property,
context marker, and domain role. `themes.css` is the deliberately narrow token
definition exception.

The following literal families remain intentional domain data rather than UI
chrome. Keep their use local to the domain and name the surrounding selector,
variable, or inline-style object for that meaning:

- Status and severity: success, warning, danger, and informational indicators.
- Syntax and diffs: language highlighting plus added, removed, and changed code.
- Topology and charts: node/edge types, graph series, and link health.
- Vendor identities: Cisco, Meraki, NetBox, Grafana, and other integration marks.

The current machine-readable entries are the seven `IaCCommandBlock` action
group identifiers. Their `color` strings select semantic CSS classes; they are
not rendered as CSS color values. Each action/value pair is listed separately
so the same word cannot be reused in unrelated chrome.

Do not use a domain literal for a panel background, ordinary text, border,
input, hover, modal, selection, or focus treatment. If a domain color needs a
theme-aware surface, add a named semantic token instead.
