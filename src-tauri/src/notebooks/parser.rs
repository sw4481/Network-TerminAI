//! Markdown-with-YAML-frontmatter ↔ typed cell graph.
//!
//! Strategy:
//! * Frontmatter is delimited by `---` fences at the top of the document.
//! * Body is scanned line-by-line for fenced code blocks (``` info-string).
//!   The known info strings `command`, `approval`, `assertion`, `parameter`
//!   produce typed cells; any other info string (`bash`, `json`, etc.) is
//!   re-emitted as a Markdown cell containing the original fence.
//! * Prose between fenced blocks (or before the first / after the last) is
//!   collected as Markdown cells verbatim — important so authors keep their
//!   headings, paragraphs, bullet lists, links, etc.
//!
//! `body_markdown` on the returned `Notebook` is a verbatim copy of the
//! input. Re-rendering via `render_markdown` is a *lossy projection* used
//! when the user edits cells in-UI; for unmodified notebooks the original
//! body is returned by the export path.

use anyhow::{anyhow, bail, Context, Result};

use super::model::*;

/// Split raw text into (yaml_frontmatter, body_markdown).
fn split_frontmatter(src: &str) -> Result<(&str, &str)> {
    let src = src.strip_prefix('\u{feff}').unwrap_or(src);
    if !src.starts_with("---") {
        return Ok(("", src));
    }
    let after = &src[3..];
    // Frontmatter close is the next line that starts with `---` after a newline.
    // We accept either `\n---\n` or `\n---` at EOF (no trailing newline).
    let after = after.strip_prefix('\n').unwrap_or(after);
    let mut search_from = 0usize;
    let end = loop {
        let needle = "---";
        match after[search_from..].find(needle) {
            None => return Err(anyhow!("unterminated frontmatter")),
            Some(pos) => {
                let abs = search_from + pos;
                let at_line_start = abs == 0 || after.as_bytes()[abs - 1] == b'\n';
                let is_line = at_line_start
                    && after[abs + 3..]
                        .chars()
                        .next()
                        .is_none_or(|c| c == '\n' || c == '\r');
                if is_line {
                    break abs;
                }
                search_from = abs + needle.len();
            }
        }
    };
    let yaml = &after[..end];
    let rest = &after[end + 3..];
    let rest = rest.strip_prefix('\n').unwrap_or(rest);
    Ok((yaml, rest))
}

/// Find the next fenced code block in `body[start..]`.
/// Returns `(prose_end_byte, lang, body_start, body_end, fence_end)` where
/// `body[fence_end..]` is the suffix to keep scanning.
fn next_fence(body: &str, start: usize) -> Option<FenceMatch> {
    let bytes = body.as_bytes();
    let mut i = start;
    while i < bytes.len() {
        // Find a line that begins with ``` (allow up to 3 leading spaces).
        let line_start = i;
        let line_end = body[i..].find('\n').map(|n| i + n).unwrap_or(bytes.len());
        let line = &body[line_start..line_end];
        let trimmed = line.trim_start_matches(' ');
        if trimmed.starts_with("```") {
            let lang = trimmed.trim_start_matches('`').trim().to_string();
            // Code block body starts after the newline following the open fence.
            let body_start = if line_end < bytes.len() {
                line_end + 1
            } else {
                line_end
            };
            // Find the closing fence: a line that is exactly ``` (optionally followed
            // by a language tag — we stop on the first bare ``` line too).
            let mut scan = body_start;
            let mut close_line_start = None;
            while scan < bytes.len() {
                let nl = body[scan..]
                    .find('\n')
                    .map(|n| scan + n)
                    .unwrap_or(bytes.len());
                let l = body[scan..nl].trim_end_matches('\r');
                let lt = l.trim_start_matches(' ');
                if lt.starts_with("```") && lt.trim_end().chars().all(|c| c == '`') {
                    close_line_start = Some(scan);
                    break;
                }
                if nl >= bytes.len() {
                    break;
                }
                scan = nl + 1;
            }
            let body_end = close_line_start.unwrap_or(bytes.len());
            let fence_end = if let Some(cls) = close_line_start {
                body[cls..]
                    .find('\n')
                    .map(|n| cls + n + 1)
                    .unwrap_or(bytes.len())
            } else {
                bytes.len()
            };
            return Some(FenceMatch {
                prose_end: line_start,
                lang,
                body_start,
                body_end,
                fence_end,
            });
        }
        if line_end >= bytes.len() {
            break;
        }
        i = line_end + 1;
    }
    None
}

struct FenceMatch {
    prose_end: usize,
    lang: String,
    body_start: usize,
    body_end: usize,
    fence_end: usize,
}

pub fn parse_markdown(src: &str) -> Result<Notebook> {
    let (yaml, body) = split_frontmatter(src)?;
    let frontmatter: Frontmatter = if yaml.trim().is_empty() {
        Frontmatter::default()
    } else {
        serde_yaml::from_str(yaml).context("invalid YAML frontmatter")?
    };

    let mut cells: Vec<NotebookCell> = Vec::new();
    if !frontmatter.parameters.is_empty() {
        cells.push(NotebookCell::Parameter {
            params: frontmatter.parameters.clone(),
        });
    }

    let mut cursor = 0usize;
    while cursor < body.len() {
        match next_fence(body, cursor) {
            None => {
                let prose = &body[cursor..];
                push_prose(prose, &mut cells);
                break;
            }
            Some(fm) => {
                let prose = &body[cursor..fm.prose_end];
                push_prose(prose, &mut cells);
                let fence_body = &body[fm.body_start..fm.body_end];
                cells.push(classify_fence(&fm.lang, fence_body)?);
                cursor = fm.fence_end;
            }
        }
    }

    Ok(Notebook {
        frontmatter,
        cells,
        body_markdown: src.to_string(),
    })
}

fn push_prose(prose: &str, cells: &mut Vec<NotebookCell>) {
    if prose.trim().is_empty() {
        return;
    }
    // Normalise leading/trailing blank lines so the cell graph is stable
    // across re-render → re-parse cycles. Internal whitespace (paragraphs,
    // bullet indentation) is preserved.
    let trimmed = prose.trim_matches('\n');
    let normalised = format!("\n{trimmed}\n\n");
    cells.push(NotebookCell::Markdown {
        content: normalised,
    });
}

fn classify_fence(lang: &str, body: &str) -> Result<NotebookCell> {
    let lang = lang.trim();
    match lang {
        "command" => Ok(NotebookCell::Command {
            content: body.trim_end_matches('\n').to_string(),
            metadata: CommandMeta::default(),
        }),
        "approval" => Ok(NotebookCell::Approval {
            content: body.trim_end_matches('\n').to_string(),
        }),
        "assertion" => {
            let trimmed = body.trim();
            let spec: AssertionSpec = serde_json::from_str(trimmed)
                .context("assertion cell must be JSON with {command, jsonpath, op, expected}")?;
            Ok(NotebookCell::Assertion { spec })
        }
        "parameter" => {
            // Inline parameter block: parse as YAML list of ParameterSpec. Allows authors
            // to declare params outside the frontmatter if they want positional context.
            let params: Vec<ParameterSpec> =
                serde_yaml::from_str(body).context("parameter cell must be YAML list")?;
            Ok(NotebookCell::Parameter { params })
        }
        "" => Ok(NotebookCell::Markdown {
            content: format!("```\n{body}```\n"),
        }),
        other if is_known_prose_lang(other) => Ok(NotebookCell::Markdown {
            content: format!("```{other}\n{body}```\n"),
        }),
        other => bail!("unknown cell type: ```{other}"),
    }
}

fn is_known_prose_lang(s: &str) -> bool {
    matches!(
        s,
        "bash" | "sh" | "json" | "yaml" | "text" | "rust" | "python" | "md" | "markdown"
    )
}

/// Re-render a Notebook's cell graph back to markdown.
///
/// **Lossy:** prose Markdown cells round-trip verbatim, but the
/// frontmatter is re-serialised by `serde_yaml` so key order and quoting
/// may differ from the source. For exporting a notebook that was imported
/// from a file, prefer returning `notebook.body_markdown` verbatim — this
/// helper is for the in-UI cell editor.
pub fn render_markdown(nb: &Notebook) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&serde_yaml::to_string(&nb.frontmatter).unwrap_or_default());
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("---\n\n");
    for cell in &nb.cells {
        match cell {
            NotebookCell::Parameter { .. } => { /* synthesised from frontmatter — don't re-emit */
            }
            NotebookCell::Markdown { content } => {
                out.push_str(content);
                if !content.ends_with('\n') {
                    out.push('\n');
                }
                if !out.ends_with("\n\n") {
                    out.push('\n');
                }
            }
            NotebookCell::Command { content, .. } => {
                out.push_str("```command\n");
                out.push_str(content);
                if !content.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str("```\n\n");
            }
            NotebookCell::Approval { content } => {
                out.push_str("```approval\n");
                out.push_str(content);
                if !content.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str("```\n\n");
            }
            NotebookCell::Assertion { spec } => {
                out.push_str("```assertion\n");
                out.push_str(&serde_json::to_string(spec).unwrap_or_default());
                out.push('\n');
                out.push_str("```\n\n");
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("tests/fixtures/bgp_peer_bringup.mop.md");

    #[test]
    fn parses_bgp_fixture_into_cells() {
        let nb = parse_markdown(FIXTURE).expect("parse");
        assert_eq!(nb.frontmatter.title, "BGP Peer Bringup");
        assert_eq!(nb.frontmatter.vendor.as_deref(), Some("cisco"));
        assert_eq!(nb.frontmatter.parameters.len(), 2);

        use NotebookCell::*;
        assert!(matches!(nb.cells[0], Parameter { .. }));
        let has_show = nb.cells.iter().any(
            |c| matches!(c, Command { content, .. } if content.contains("show ip bgp summary")),
        );
        assert!(
            has_show,
            "expected a Command cell containing 'show ip bgp summary'"
        );
        assert!(nb.cells.iter().any(|c| matches!(c, Approval { .. })));
        let assertion = nb
            .cells
            .iter()
            .find_map(|c| match c {
                Assertion { spec } => Some(spec),
                _ => None,
            })
            .expect("assertion cell");
        assert_eq!(assertion.command, "show ip bgp summary");
        assert_eq!(assertion.op, AssertionOp::Equals);
    }

    #[test]
    fn round_trip_preserves_body_markdown_bytes() {
        let nb = parse_markdown(FIXTURE).unwrap();
        assert_eq!(nb.body_markdown, FIXTURE);
        // Re-render is a lossy projection: it must still round-trip back to an
        // equivalent cell graph.
        let rendered = render_markdown(&nb);
        let reparsed = parse_markdown(&rendered).unwrap();
        assert_eq!(reparsed.cells, nb.cells);
    }

    #[test]
    fn rejects_unknown_fence_lang() {
        let bad = "---\ntitle: x\n---\n```wat\nboom\n```\n";
        let err = parse_markdown(bad).unwrap_err();
        assert!(err.to_string().contains("unknown cell type"));
    }

    #[test]
    fn empty_frontmatter_synthesises_default() {
        let src = "# Hello\n\nSome prose.\n";
        let nb = parse_markdown(src).unwrap();
        assert_eq!(nb.frontmatter.title, "Untitled");
        assert!(nb
            .cells
            .iter()
            .any(|c| matches!(c, NotebookCell::Markdown { .. })));
    }

    #[test]
    fn known_prose_lang_becomes_markdown_cell() {
        let src = "---\ntitle: x\n---\n```bash\necho hi\n```\n";
        let nb = parse_markdown(src).unwrap();
        assert_eq!(nb.cells.len(), 1);
        assert!(
            matches!(&nb.cells[0], NotebookCell::Markdown { content } if content.contains("```bash"))
        );
    }

    #[test]
    fn crlf_input_does_not_panic() {
        let src =
            "---\r\ntitle: x\r\n---\r\n\r\n# Heading\r\n\r\n```command\r\nshow version\r\n```\r\n";
        let nb = parse_markdown(src).expect("parse CRLF");
        assert!(nb
            .cells
            .iter()
            .any(|c| matches!(c, NotebookCell::Command { content, .. } if content.contains("show version"))));
    }

    #[test]
    fn missing_frontmatter_close_errors() {
        let bad = "---\ntitle: x\n";
        let err = parse_markdown(bad).unwrap_err();
        assert!(err.to_string().contains("unterminated frontmatter"));
    }

    #[test]
    fn assertion_invalid_json_errors() {
        let bad = "---\ntitle: x\n---\n```assertion\nnot-json\n```\n";
        let err = parse_markdown(bad).unwrap_err();
        assert!(err.to_string().contains("assertion cell must be JSON"));
    }

    #[test]
    fn multiple_command_cells_preserved_in_order() {
        let src = "---\ntitle: x\n---\n```command\na\n```\n\nbetween\n\n```command\nb\n```\n";
        let nb = parse_markdown(src).unwrap();
        let cmds: Vec<_> = nb
            .cells
            .iter()
            .filter_map(|c| match c {
                NotebookCell::Command { content, .. } => Some(content.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(cmds, vec!["a", "b"]);
    }
}
