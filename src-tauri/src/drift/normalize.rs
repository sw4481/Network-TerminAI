//! Per-vendor config normalizer. Strips volatile lines (timestamps, byte
//! counts, NVRAM-update banners) and redacts encrypted secrets so that
//! `diff(intent, normalize(running))` is deterministic.

use once_cell::sync::Lazy;
use regex::Regex;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Vendor {
    CiscoIosXe,
    CiscoNxos,
    CiscoIos,
    CiscoIosXr,
    AristaEos,
    JuniperJunos,
    Generic,
}

impl Vendor {
    pub fn parse(vendor: &str, platform: &str) -> Self {
        match (vendor, platform) {
            ("cisco", "iosxe") => Vendor::CiscoIosXe,
            ("cisco", "nxos") => Vendor::CiscoNxos,
            ("cisco", "ios") => Vendor::CiscoIos,
            ("cisco", "iosxr") => Vendor::CiscoIosXr,
            ("arista", "eos") => Vendor::AristaEos,
            ("juniper", "junos") => Vendor::JuniperJunos,
            _ => Vendor::Generic,
        }
    }
}

// ---- IOS-like drop rules (IOS-XE, NX-OS, IOS classic, IOS-XR, EOS) ----
// Note: bare `!` separator lines are LOAD-BEARING in Cisco configs. Don't drop.

static IOS_DROP: Lazy<Vec<Regex>> = Lazy::new(|| {
    vec![
        Regex::new(r"^!\s*Last configuration change").unwrap(),
        Regex::new(r"^!\s*NVRAM config last updated").unwrap(),
        Regex::new(r"^!\s*Time:").unwrap(),
        Regex::new(r"^Building configuration").unwrap(),
        Regex::new(r"^Current configuration : \d+ bytes").unwrap(),
        Regex::new(r"^!\s*No configuration change since").unwrap(),
    ]
});

static IOS_REDACT: Lazy<Vec<(Regex, &'static str)>> = Lazy::new(|| {
    vec![
        (
            Regex::new(r"^(\s*enable secret \d+ )\S+").unwrap(),
            "$1<REDACTED>",
        ),
        (
            Regex::new(r"^(\s*enable password \d+ )\S+").unwrap(),
            "$1<REDACTED>",
        ),
        (
            Regex::new(r"^(\s*username \S+(?: privilege \d+)? secret \d+ )\S+").unwrap(),
            "$1<REDACTED>",
        ),
        (
            Regex::new(r"^(\s*username \S+ password \d+ )\S+").unwrap(),
            "$1<REDACTED>",
        ),
        (Regex::new(r"^(\s*password 7 )\S+").unwrap(), "$1<REDACTED>"),
        (Regex::new(r"^(\s*key 7 )\S+").unwrap(), "$1<REDACTED>"),
        (Regex::new(r"^(\s*key-string 7 )\S+").unwrap(), "$1<REDACTED>"),
        (
            Regex::new(r"(pre-shared-key.*key \d+ )\S+").unwrap(),
            "$1<REDACTED>",
        ),
        // IOS / IOS-XE: `snmp-server community <name> RO|RW`
        (
            Regex::new(r"^(\s*snmp-server community )\S+(\s+R[WO])").unwrap(),
            "$1<REDACTED>$2",
        ),
        // NX-OS / EOS variants: `snmp-server community <name> group ...` or
        // bare `snmp-server community <name>` (catches everything else).
        (
            Regex::new(r"^(\s*snmp-server community )(\S+)(\s+group)").unwrap(),
            "$1<REDACTED>$3",
        ),
        (
            Regex::new(r"^(\s*snmp-server community )(\S+)\s*$").unwrap(),
            "$1<REDACTED>",
        ),
        (
            Regex::new(r"^(\s*(?:tacacs|radius)-server key \d+ )\S+").unwrap(),
            "$1<REDACTED>",
        ),
    ]
});

// ---- Junos rules ----

static JUNOS_DROP: Lazy<Vec<Regex>> = Lazy::new(|| {
    vec![
        Regex::new(r"^## Last commit:").unwrap(),
        Regex::new(r"^## Last changed:").unwrap(),
    ]
});

static JUNOS_REDACT: Lazy<Vec<(Regex, &'static str)>> = Lazy::new(|| {
    vec![
        (
            Regex::new(r#"(encrypted-password\s+)"\S+""#).unwrap(),
            r#"$1"<REDACTED>""#,
        ),
        (
            Regex::new(r#"(ssh-rsa\s+)"\S+""#).unwrap(),
            r#"$1"<REDACTED>""#,
        ),
        (
            Regex::new(r#"(ssh-ed25519\s+)"\S+""#).unwrap(),
            r#"$1"<REDACTED>""#,
        ),
        (
            Regex::new(r#"(secret\s+)"\S+""#).unwrap(),
            r#"$1"<REDACTED>""#,
        ),
    ]
});

pub fn normalize(vendor: Vendor, raw: &str) -> String {
    let drop_rules: &[Regex] = match vendor {
        Vendor::CiscoIosXe
        | Vendor::CiscoNxos
        | Vendor::CiscoIos
        | Vendor::CiscoIosXr
        | Vendor::AristaEos => &IOS_DROP,
        Vendor::JuniperJunos => &JUNOS_DROP,
        Vendor::Generic => &[],
    };
    let redact_rules: &[(Regex, &'static str)] = match vendor {
        Vendor::CiscoIosXe
        | Vendor::CiscoNxos
        | Vendor::CiscoIos
        | Vendor::CiscoIosXr
        | Vendor::AristaEos => &IOS_REDACT,
        Vendor::JuniperJunos => &JUNOS_REDACT,
        Vendor::Generic => &[],
    };

    let mut out = String::with_capacity(raw.len());
    let mut prev_blank = false;
    for line in raw.lines() {
        if drop_rules.iter().any(|r| r.is_match(line)) {
            continue;
        }
        let mut current: String = line.to_string();
        for (re, repl) in redact_rules {
            current = re.replace_all(&current, *repl).into_owned();
        }
        let trimmed = current.trim_end();
        let is_blank = trimmed.is_empty();
        if is_blank && prev_blank {
            continue;
        }
        prev_blank = is_blank;
        out.push_str(trimmed);
        out.push('\n');
    }
    while out.ends_with("\n\n") {
        out.pop();
    }
    out
}
