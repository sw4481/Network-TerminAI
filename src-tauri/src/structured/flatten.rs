//! Server-side mirror of `src/lib/flatten.ts` — needed by the diff engine to
//! flatten Genie nested dicts before alignment.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct FlatRow {
    pub key: String,
    pub value: Value,
}

pub fn flatten_to_rows(value: &Value, prefix: &str) -> Vec<FlatRow> {
    let mut out = Vec::new();
    flatten_inner(value, prefix, &mut out);
    out
}

fn flatten_inner(value: &Value, prefix: &str, out: &mut Vec<FlatRow>) {
    match value {
        Value::Object(map) => {
            if map.is_empty() {
                out.push(FlatRow {
                    key: if prefix.is_empty() { "$".to_string() } else { prefix.to_string() },
                    value: Value::Object(map.clone()),
                });
                return;
            }
            for (k, v) in map.iter() {
                let next = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{prefix}.{k}")
                };
                if v.is_object() {
                    flatten_inner(v, &next, out);
                } else {
                    out.push(FlatRow {
                        key: next,
                        value: v.clone(),
                    });
                }
            }
        }
        _ => {
            out.push(FlatRow {
                key: if prefix.is_empty() { "$".to_string() } else { prefix.to_string() },
                value: value.clone(),
            });
        }
    }
}
