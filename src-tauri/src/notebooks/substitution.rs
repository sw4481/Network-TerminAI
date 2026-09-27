//! `{{var}}` interpolation for command and assertion cells.

use once_cell::sync::Lazy;
use regex::Regex;

static VAR_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}").expect("valid regex")
});

/// Substitute `{{name}}` placeholders with values from `params`.
///
/// * String values are inserted unquoted.
/// * Non-string JSON values are inserted via `to_string()` (numbers / bools).
/// * Unknown variables are left as-is so a later substitution pass (or the
///   user) can resolve them.
pub fn substitute(input: &str, params: &serde_json::Map<String, serde_json::Value>) -> String {
    VAR_RE
        .replace_all(input, |caps: &regex::Captures| {
            let name = &caps[1];
            match params.get(name) {
                Some(serde_json::Value::String(s)) => s.clone(),
                Some(v) => v.to_string(),
                None => caps.get(0).unwrap().as_str().to_string(),
            }
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pairs: &[(&str, serde_json::Value)]) -> serde_json::Map<String, serde_json::Value> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn replaces_simple_var() {
        let out = substitute("hello {{name}}", &p(&[("name", "world".into())]));
        assert_eq!(out, "hello world");
    }

    #[test]
    fn allows_whitespace_in_braces() {
        let out = substitute("a {{ x }} b", &p(&[("x", "Y".into())]));
        assert_eq!(out, "a Y b");
    }

    #[test]
    fn leaves_unknown_var_alone() {
        let out = substitute("{{a}}-{{b}}", &p(&[("a", "1".into())]));
        assert_eq!(out, "1-{{b}}");
    }

    #[test]
    fn integer_value_is_stringified() {
        let out = substitute("count={{n}}", &p(&[("n", 42.into())]));
        assert_eq!(out, "count=42");
    }

    #[test]
    fn empty_input_round_trips() {
        let out = substitute("", &p(&[("a", "1".into())]));
        assert_eq!(out, "");
    }

    #[test]
    fn does_not_match_single_brace() {
        let out = substitute("{x}", &p(&[("x", "Y".into())]));
        assert_eq!(out, "{x}");
    }

    #[test]
    fn multiple_occurrences_replaced() {
        let out = substitute("{{a}} {{a}} {{b}}", &p(&[("a", "1".into()), ("b", "2".into())]));
        assert_eq!(out, "1 1 2");
    }
}
