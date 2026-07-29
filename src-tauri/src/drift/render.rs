//! Render an `IntentTemplate` to a config string.
//!
//! - Golden intents: `body` returned verbatim.
//! - Jinja intents: `body` is treated as a Jinja2 template; YAML defaults from
//!   `vars_yaml` are merged with caller-provided overrides (override wins),
//!   then handed to MiniJinja as the rendering context.

use crate::drift::intent::{IntentKind, IntentTemplate};
use anyhow::{Context, Result};
use minijinja::Environment;
use serde_yaml::Value as YamlValue;

pub fn render_intent(
    tpl: &IntentTemplate,
    override_vars_yaml: Option<&str>,
) -> Result<String> {
    if matches!(tpl.kind, IntentKind::Golden) {
        return Ok(tpl.body.clone());
    }

    let defaults = parse_yaml_or_null(&tpl.vars_yaml)
        .context("parsing default vars_yaml")?;
    let overrides = match override_vars_yaml {
        None | Some("") => YamlValue::Null,
        Some(s) => parse_yaml_or_null(s).context("parsing override vars_yaml")?,
    };
    let merged = merge_yaml(defaults, overrides);

    // Convert YAML → serde_json::Value so MiniJinja's Serialize-based context
    // path treats keys uniformly.
    let json_value = yaml_to_json(merged)?;

    let mut env = Environment::new();
    env.add_template_owned("intent", tpl.body.clone())
        .context("adding intent template to MiniJinja")?;
    let template = env.get_template("intent")?;
    Ok(template.render(json_value)?)
}

fn parse_yaml_or_null(s: &str) -> Result<YamlValue> {
    if s.trim().is_empty() {
        return Ok(YamlValue::Null);
    }
    let v: YamlValue = serde_yaml::from_str(s).context("parse yaml")?;
    Ok(v)
}

/// Recursive YAML mapping merge — `b`'s leaves win on conflict.
/// `Null` overrides are NOT treated as deletions: `merge(x, Null) = x`.
pub(crate) fn merge_yaml(a: YamlValue, b: YamlValue) -> YamlValue {
    match (a, b) {
        (a, YamlValue::Null) => a,
        (YamlValue::Null, b) => b,
        (YamlValue::Mapping(mut am), YamlValue::Mapping(bm)) => {
            for (k, v) in bm {
                let prev = am.remove(&k);
                let merged_v = match prev {
                    Some(prev_v) => merge_yaml(prev_v, v),
                    None => v,
                };
                am.insert(k, merged_v);
            }
            YamlValue::Mapping(am)
        }
        (_, b) => b,
    }
}

fn yaml_to_json(v: YamlValue) -> Result<serde_json::Value> {
    Ok(serde_json::to_value(v)?)
}
