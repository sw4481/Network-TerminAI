//! Pure classification function — given a `RuleSet`, vendor, platform, and
//! command line, return the highest-tier matching rule's decision. If no
//! rule matches but the command starts with a read-only verb prefix, the
//! safety default returns Tier::T0. Otherwise Ambiguous.

use super::rules::{CompiledRule, RuleSet};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tier {
    T0,
    T1,
    T2,
    T3,
    Ambiguous,
}

impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::T0 => "T0",
            Tier::T1 => "T1",
            Tier::T2 => "T2",
            Tier::T3 => "T3",
            Tier::Ambiguous => "Ambiguous",
        }
    }

    pub fn as_u8(self) -> u8 {
        match self {
            Tier::T0 => 0,
            Tier::T1 => 1,
            Tier::T2 => 2,
            Tier::T3 => 3,
            // Ambiguous gets recorded as 1 in the audit log (over-gate).
            Tier::Ambiguous => 1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Decision {
    pub tier: Tier,
    pub rule_id: Option<String>,
    pub reasoning: String,
}

pub fn classify(rs: &RuleSet, vendor: &str, platform: &str, command: &str) -> Decision {
    let v = vendor.to_lowercase();
    let p = platform.to_lowercase();
    let c = command.trim();

    // Precedence:
    //  (a) higher tier wins on any vendor/platform match.
    //  (b) on tier ties, more-specific (non-wildcard vendor+platform) wins.
    let mut best: Option<&CompiledRule> = None;

    for cr in &rs.compiled {
        let vendor_ok = cr.rule.vendor == "*" || cr.rule.vendor.eq_ignore_ascii_case(&v);
        let platform_ok = cr.rule.platform == "*" || cr.rule.platform.eq_ignore_ascii_case(&p);
        if !vendor_ok || !platform_ok {
            continue;
        }
        if !cr.regex.is_match(c) {
            continue;
        }
        best = match best {
            None => Some(cr),
            Some(prev) => {
                if cr.rule.tier > prev.rule.tier
                    || (cr.rule.tier == prev.rule.tier && specificity(cr) > specificity(prev))
                {
                    Some(cr)
                } else {
                    Some(prev)
                }
            }
        };
    }

    if let Some(cr) = best {
        return Decision {
            tier: tier_from_u8(cr.rule.tier),
            rule_id: Some(cr.rule.id.clone()),
            reasoning: cr.rule.reason.clone(),
        };
    }

    // Safety default: if the command starts with a known read-only verb,
    // treat as T0. This catches undocumented `show` variants the builtin
    // set didn't anticipate. Otherwise return Ambiguous and let the caller
    // decide whether to LLM-second-opinion or hard-gate as T1.
    let lower = c.to_lowercase();
    let read_only_prefixes = ["show ", "display ", "ping ", "traceroute ", "dir ", "more "];
    if read_only_prefixes.iter().any(|pfx| lower.starts_with(pfx)) {
        return Decision {
            tier: Tier::T0,
            rule_id: None,
            reasoning: "Read-only prefix (safety default)".to_string(),
        };
    }

    Decision {
        tier: Tier::Ambiguous,
        rule_id: None,
        reasoning: "No builtin rule matched; ambiguous — caller should gate or escalate"
            .to_string(),
    }
}

fn specificity(cr: &CompiledRule) -> u8 {
    let mut s = 0;
    if cr.rule.vendor != "*" {
        s += 2;
    }
    if cr.rule.platform != "*" {
        s += 1;
    }
    s
}

fn tier_from_u8(t: u8) -> Tier {
    match t {
        0 => Tier::T0,
        1 => Tier::T1,
        2 => Tier::T2,
        3 => Tier::T3,
        _ => Tier::Ambiguous,
    }
}
