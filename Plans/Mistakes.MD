# Mistakes

## 2026-09-04: Initial plan artifact patch failed

- Issue: The first attempt to create the two Markdown artifacts failed before
  writing because the JavaScript tool wrapper interpreted Markdown backticks
  inside a template literal.
- Root cause analysis: The patch payload was passed through a JavaScript
  template literal containing unescaped backticks, so the payload ended early
  and the wrapper evaluated later Markdown as JavaScript.
- How addressed: Split the artifact creation into smaller apply_patch calls,
  used safer payload construction, verified both files afterward, and scanned
  them for leftover escape characters and placeholders.
