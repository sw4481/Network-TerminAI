//! Rule storage, loading, and regex compilation.

use anyhow::{Context, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub platform: String,
    pub pattern_regex: String,
    pub tier: u8,
    pub reason: String,
    pub enabled: bool,
    pub builtin: bool,
}

pub struct CompiledRule {
    pub rule: Rule,
    pub regex: Regex,
}

pub struct RuleSet {
    pub compiled: Vec<CompiledRule>,
}

impl RuleSet {
    /// Load the embedded builtin ruleset compiled into the binary at
    /// build time.
    pub fn load_builtin() -> Result<Self> {
        const BUILTIN_JSON: &str = include_str!("builtin_rules.json");
        let rules: Vec<Rule> =
            serde_json::from_str(BUILTIN_JSON).context("parsing builtin_rules.json")?;
        Self::compile(rules)
    }

    pub fn compile(rules: Vec<Rule>) -> Result<Self> {
        let mut compiled = Vec::with_capacity(rules.len());
        for r in rules {
            if !r.enabled {
                continue;
            }
            let rx = Regex::new(&r.pattern_regex)
                .with_context(|| format!("rule {} regex invalid: {}", r.id, r.pattern_regex))?;
            compiled.push(CompiledRule { rule: r, regex: rx });
        }
        Ok(Self { compiled })
    }

    pub fn empty() -> Self {
        Self { compiled: vec![] }
    }

    pub fn len(&self) -> usize {
        self.compiled.len()
    }

    pub fn is_empty(&self) -> bool {
        self.compiled.is_empty()
    }
}
