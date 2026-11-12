//! Conservative operational admission, not a claim of device/release support.
use super::model::{Diagnostic, Platform};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandCost {
    pub max_output_bytes: usize,
    pub min_interval_seconds: u32,
}
#[derive(Debug, Clone)]
pub struct AdmittedCommand {
    command: String,
    cost: CommandCost,
}
impl AdmittedCommand {
    pub fn as_str(&self) -> &str {
        &self.command
    }
    pub fn cost(&self) -> CommandCost {
        self.cost
    }
}
pub struct CommandPolicy;
impl CommandPolicy {
    pub fn admit(_platform: Platform, command: &str) -> Result<AdmittedCommand, Diagnostic> {
        let words: Vec<_> = command.split(' ').collect();
        let exact = matches!(
            command,
            "show version"
                | "show processes cpu"
                | "show processes memory sorted"
                | "show interfaces"
                | "show interfaces description"
                | "show interfaces status"
                | "show ip interface"
                | "show ip interface brief"
                | "show ip bgp summary"
                | "show ip bgp neighbors"
                | "show ip bgp vpnv4 all neighbors"
                | "show ip ospf neighbor"
                | "show ip ospf interface brief"
                | "show ip eigrp neighbors"
                | "show vlan brief"
                | "show interfaces switchport"
                | "show spanning-tree"
                | "show spanning-tree root"
                | "show etherchannel summary"
                | "show cdp neighbors detail"
                | "show lldp neighbors detail"
                | "show mac address-table"
                | "show inventory"
                | "show interfaces trunk"
        );
        let parameterized = match words.as_slice() {
            ["show", "interfaces", interface] => valid_interface(interface),
            ["show", "ip", "bgp", "vpnv4", "vrf", vrf, "summary" | "neighbors"] => valid_vrf(vrf),
            ["show", "ip", "interface", "vrf", vrf] => valid_vrf(vrf),
            _ => false,
        };
        if !command.is_ascii() || command.len() > 256 || (!exact && !parameterized) {
            return Err(Diagnostic::new("command_not_admitted", "Use an exact supported read-only command and validated interface/VRF arguments; shell syntax and arbitrary show commands are unsupported", "source.commands"));
        }
        let inventory = matches!(command, "show version" | "show inventory");
        let large = matches!(
            command,
            "show interfaces"
                | "show interfaces switchport"
                | "show spanning-tree"
                | "show mac address-table"
                | "show ip interface"
                | "show processes memory sorted"
        );
        Ok(AdmittedCommand {
            command: command.into(),
            cost: CommandCost {
                max_output_bytes: if large { 2 * 1024 * 1024 } else { 512 * 1024 },
                min_interval_seconds: if inventory {
                    60
                } else if parameterized {
                    5
                } else {
                    30
                },
            },
        })
    }
}
fn valid_vrf(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))
        && value
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
}
fn valid_interface(value: &str) -> bool {
    let split = value.find(|c: char| c.is_ascii_digit());
    let Some(split) = split else {
        return false;
    };
    let (prefix, suffix) = value.split_at(split);
    matches!(
        prefix,
        "Gi" | "GigabitEthernet"
            | "Te"
            | "TenGigabitEthernet"
            | "Twe"
            | "TwentyFiveGigE"
            | "Fo"
            | "FortyGigabitEthernet"
            | "Hu"
            | "HundredGigE"
            | "Fa"
            | "FastEthernet"
            | "Eth"
            | "Ethernet"
            | "Po"
            | "Port-channel"
            | "Lo"
            | "Loopback"
            | "Vl"
            | "Vlan"
            | "Tu"
            | "Tunnel"
            | "Se"
            | "Serial"
    ) && suffix.len() <= 32
        && suffix
            .bytes()
            .all(|c| c.is_ascii_digit() || matches!(c, b'/' | b'.' | b':'))
        && suffix.bytes().last().is_some_and(|c| c.is_ascii_digit())
        && !suffix
            .as_bytes()
            .windows(2)
            .any(|pair| !pair[0].is_ascii_digit() && !pair[1].is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::model::Platform;

    #[test]
    fn policy_rejects_write_shell_and_expensive_unadmitted_show() {
        assert!(CommandPolicy::admit(Platform::Iosxe, "show tech-support").is_err());
        for command in [
            "configure terminal",
            "reload",
            "show x; reload",
            "show version\nreload",
            "show version | include X",
            "py:print(1)",
            "show running-config",
            "show interfaces `id`",
            "show interfaces $(id)",
        ] {
            assert!(
                CommandPolicy::admit(Platform::Iosxe, command).is_err(),
                "{command}"
            );
        }
    }
    #[test]
    fn policy_admits_only_known_families_and_valid_arguments() {
        for platform in [Platform::Ios, Platform::Iosxe] {
            for command in [
                "show version",
                "show interfaces",
                "show interfaces GigabitEthernet1/0/1",
                "show ip bgp summary",
                "show ip bgp vpnv4 vrf blue summary",
            ] {
                let admitted = CommandPolicy::admit(platform, command).unwrap();
                assert_eq!(admitted.as_str(), command);
                assert!(admitted.cost().max_output_bytes > 0);
            }
        }
        for command in [
            "show interfaces nonexistent",
            "show ip bgp vpnv4 vrf ../x summary",
            "show ip bgp vpnv4 vrf blue* summary",
            "show version ",
            "show  version",
            "show interfaces Gi1\treload",
        ] {
            assert!(
                CommandPolicy::admit(Platform::Iosxe, command).is_err(),
                "{command}"
            );
        }
    }
}
