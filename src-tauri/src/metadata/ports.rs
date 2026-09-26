//! Listening-ports gatherer (Phase 3E, macOS-first). Walks the pane pid's
//! descendants and asks lsof for TCP LISTEN sockets in machine-parseable
//! (-F) format.

use super::PortInfo;
use std::collections::BTreeMap;

/// Parse `lsof -nP -FpcPn` field output into deduped PortInfo (by port).
/// lsof -F emits one field per line: `p<pid>`, `c<command>`, then per file
/// `n<name>` like `n*:8000` or `n127.0.0.1:8000`. We track the current
/// command (`c`) and extract the port from each `n` line.
pub(crate) fn parse_lsof_f(output: &str) -> Vec<PortInfo> {
    let mut by_port: BTreeMap<u16, String> = BTreeMap::new();
    let mut cur_cmd = String::new();
    for line in output.lines() {
        let (tag, rest) = line.split_at(line.char_indices().nth(1).map(|(i, _)| i).unwrap_or(0));
        match tag {
            "c" => cur_cmd = rest.to_string(),
            "n" => {
                // rest is like "*:8000" or "127.0.0.1:8000" or "[::1]:8000"
                if let Some(idx) = rest.rfind(':') {
                    if let Ok(port) = rest[idx + 1..].parse::<u16>() {
                        by_port.entry(port).or_insert_with(|| cur_cmd.clone());
                    }
                }
            }
            _ => {}
        }
    }
    by_port
        .into_iter()
        .map(|(port, proc_name)| PortInfo { port, proc_name })
        .collect()
}

pub fn gather_ports(pid: u32) -> Vec<PortInfo> {
    let pids = super::proc::child_pids(pid);
    if pids.is_empty() {
        return Vec::new();
    }
    let csv = pids
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let out = match std::process::Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-FpcPn", "-p", &csv])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    parse_lsof_f(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_lsof_extracts_port_and_command() {
        let sample = "p1234\ncpython3\nn*:8000\n";
        let got = parse_lsof_f(sample);
        assert_eq!(
            got,
            vec![PortInfo {
                port: 8000,
                proc_name: "python3".into()
            }]
        );
    }

    #[test]
    fn test_parse_lsof_dedups_by_port_and_handles_ipv6() {
        let sample = "p1\ncnode\nn127.0.0.1:3000\nn[::1]:3000\n";
        let got = parse_lsof_f(sample);
        assert_eq!(
            got,
            vec![PortInfo {
                port: 3000,
                proc_name: "node".into()
            }]
        );
    }

    #[test]
    fn test_parse_lsof_empty_is_empty() {
        assert!(parse_lsof_f("").is_empty());
    }
}
