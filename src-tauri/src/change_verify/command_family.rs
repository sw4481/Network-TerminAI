//! Maps raw `show` commands to a coarse family used by the classifier.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandFamily {
    InterfaceStatus,
    BgpNeighbor,
    OspfNeighbor,
    RouteSummary,
    CdpNeighbor,
    Unknown,
}

pub fn classify_command(cmd: &str) -> CommandFamily {
    let c = cmd.to_lowercase();
    if c.contains("ip interface brief") || c.contains("interfaces status") {
        CommandFamily::InterfaceStatus
    } else if c.contains("bgp") && c.contains("summary") {
        CommandFamily::BgpNeighbor
    } else if c.contains("ospf") && c.contains("neighbor") {
        CommandFamily::OspfNeighbor
    } else if c.contains("route") && c.contains("summary") {
        CommandFamily::RouteSummary
    } else if c.contains("cdp neighbor") || c.contains("lldp neighbor") {
        CommandFamily::CdpNeighbor
    } else {
        CommandFamily::Unknown
    }
}

pub fn family_name(f: CommandFamily) -> &'static str {
    match f {
        CommandFamily::InterfaceStatus => "interface-status",
        CommandFamily::BgpNeighbor => "bgp-neighbor",
        CommandFamily::OspfNeighbor => "ospf-neighbor",
        CommandFamily::RouteSummary => "route-summary",
        CommandFamily::CdpNeighbor => "cdp-neighbor",
        CommandFamily::Unknown => "unknown",
    }
}
