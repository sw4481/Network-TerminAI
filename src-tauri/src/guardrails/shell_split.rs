//! Shared "shell-chain defence" helper.
//!
//! Network CLI commands never legitimately contain `;`, `&&`, `||`, `&`, or
//! backticks. When we receive a command (literal or post-substitution) we
//! must classify each shell-split chunk separately — if ANY chunk exceeds
//! Tier-0 the whole command must be rejected.
//!
//! Originally lived in `troubleshoot::engine::split_for_classification`; was
//! promoted here in the security review so fan-out, notebook, chain, and
//! troubleshoot call sites all share a single, audited splitter.
//!
//! Splitter rules (kept stable so callers can rely on them):
//! - Splits on a bare `;` and `` ` ``.
//! - Splits on `&&` / `||` (the doubled forms).
//! - Splits on a single bare `&` (background).
//! - Does NOT split on a single `|` — that's the legitimate IOS pipe filter
//!   (`show … | include foo`). The doubled `||` is still split.
//! - Empty trimmed chunks are dropped; if no metachar fires we return the
//!   original command verbatim so callers always have at least one chunk.

/// Split `command` into chunks for tier classification.
///
/// See module docs for the metachars handled. The first chunk is the
/// "original" command (verb + args before the first metachar); chunks 2+
/// contain any injected payload — `reload`, `write erase`, etc. — and will
/// classify on their own merits.
pub fn split_for_classification(command: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let bytes = command.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        // bare `;` or backtick
        if c == b';' || c == b'`' {
            if !current.trim().is_empty() {
                out.push(current.trim().to_string());
            }
            current.clear();
            i += 1;
            continue;
        }
        // doubled && or ||
        if (c == b'&' || c == b'|') && i + 1 < bytes.len() && bytes[i + 1] == c {
            if !current.trim().is_empty() {
                out.push(current.trim().to_string());
            }
            current.clear();
            i += 2;
            continue;
        }
        // bare `&` (background) — also a shell construct, not a CLI one
        if c == b'&' {
            if !current.trim().is_empty() {
                out.push(current.trim().to_string());
            }
            current.clear();
            i += 1;
            continue;
        }
        current.push(c as char);
        i += 1;
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    if out.is_empty() {
        out.push(command.to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_metachars_returns_original() {
        assert_eq!(split_for_classification("show version"), vec!["show version"]);
    }

    #[test]
    fn single_pipe_is_not_split() {
        // IOS-style filter pipe must be left alone.
        assert_eq!(
            split_for_classification("show ip route | include 10.0.0.0"),
            vec!["show ip route | include 10.0.0.0"]
        );
    }

    #[test]
    fn semicolon_splits() {
        let chunks = split_for_classification("show version ; reload");
        assert_eq!(chunks, vec!["show version", "reload"]);
    }

    #[test]
    fn double_amp_splits() {
        let chunks = split_for_classification("show version && write erase");
        assert_eq!(chunks, vec!["show version", "write erase"]);
    }

    #[test]
    fn double_pipe_splits() {
        let chunks = split_for_classification("show version || reload");
        assert_eq!(chunks, vec!["show version", "reload"]);
    }

    #[test]
    fn bare_amp_splits() {
        let chunks = split_for_classification("show version & reload");
        assert_eq!(chunks, vec!["show version", "reload"]);
    }

    #[test]
    fn backtick_splits() {
        let chunks = split_for_classification("show version `reload` more");
        assert_eq!(chunks, vec!["show version", "reload", "more"]);
    }

    #[test]
    fn empty_input() {
        // Trim-empty input yields the original (empty) string as the only
        // chunk — callers can decide what to do (typically classify it as
        // Ambiguous which causes a non-T0 refusal).
        assert_eq!(split_for_classification(""), vec![""]);
    }
}
