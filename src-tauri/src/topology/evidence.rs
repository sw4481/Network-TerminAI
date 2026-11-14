//! Graph-scoped source receipts. Incomplete attempts never refresh old observations.
use super::NeighborRecord;
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::BTreeMap;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct InterfaceAssociation {
    pub interface: String,
    pub local_address: String,
    pub prefix_length: u8,
    pub source_command: String,
    pub relationship: String,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RoutingEvidence {
    pub state: String,
    pub established: bool,
    pub peer_address: Option<String>,
    pub vrf: Option<String>,
    pub address_family: Option<String>,
    pub instance: Option<String>,
    pub level: Option<String>,
    pub scope_supported: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interface_association: Option<InterfaceAssociation>,
}
impl RoutingEvidence {
    pub fn reference(&self, source: &str, record: &NeighborRecord) -> String {
        use sha2::{Digest, Sha256};
        let context = serde_json::json!([
            source,
            record.protocol,
            record.neighbor_name,
            self.peer_address,
            self.vrf,
            self.address_family,
            self.instance,
            self.level
        ]);
        format!(
            "routing:{:x}",
            Sha256::digest(context.to_string().as_bytes())
        )
    }
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NeighborObservation {
    pub record: NeighborRecord,
    pub captured_at: i64,
    pub in_latest_capture: bool,
}
impl NeighborObservation {
    fn identity(record: &NeighborRecord) -> Result<String> {
        let mut identity = record.clone();
        if let Some(routing) = &mut identity.routing {
            // Keep latest state per identity, not a prefix-count/state event log.
            // Full names, ports, address roles and routing scopes stay distinct.
            routing.state.clear();
            routing.established = false;
            routing.scope_supported = false;
            routing.interface_association = None;
        }
        Ok(serde_json::to_string(&identity)?)
    }
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CaptureEvidence {
    pub source_ref: String,
    pub protocol: String,
    pub source_command: String,
    pub attempted_at: i64,
    pub status: String,
    pub observations: Vec<NeighborObservation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub snmp_observations: Vec<super::snmp::SnmpObservation>,
}
impl CaptureEvidence {
    pub fn protocol(command: &str) -> Option<&'static str> {
        match command {
            "show cdp neighbors detail" | "snmp:cdp" => Some("cdp"),
            "show lldp neighbors detail" | "snmp:lldp" => Some("lldp"),
            "show ip bgp summary" => Some("bgp"),
            "show ip ospf neighbor" => Some("ospf"),
            "show isis neighbors" => Some("isis"),
            "show ip eigrp neighbors" => Some("eigrp"),
            _ => None,
        }
    }
    fn load(conn: &Connection, graph: &str, source: &str, command: &str) -> Result<Self> {
        let protocol = Self::protocol(command)
            .ok_or_else(|| anyhow::anyhow!("unsupported evidence command"))?;
        let json: Option<String> = conn.query_row(
            "SELECT evidence_json FROM topology_capture_evidence WHERE graph_id=?1 AND source_ref=?2 AND protocol=?3 AND source_command=?4",
            params![graph, source, protocol, command], |r| r.get(0),
        ).optional()?;
        Ok(match json {
            Some(json) => serde_json::from_str(&json)?,
            None => Self {
                source_ref: source.into(),
                protocol: protocol.into(),
                source_command: command.into(),
                attempted_at: 0,
                status: "incomplete".into(),
                observations: vec![],
                snmp_observations: vec![],
            },
        })
    }
    fn save(&self, conn: &Connection, graph: &str, attempt: Option<&str>) -> Result<()> {
        let json = serde_json::to_string(self)?;
        anyhow::ensure!(
            json.len() <= 2 * 1024 * 1024,
            "capture evidence exceeds receipt limit"
        );
        let other_bytes: i64 = conn.query_row(
            "SELECT coalesce(sum(length(CAST(evidence_json AS BLOB))),0) FROM topology_capture_evidence WHERE graph_id=?1 AND NOT(source_ref=?2 AND protocol=?3 AND source_command=?4)",
            params![graph, self.source_ref, self.protocol, self.source_command], |r| r.get(0),
        )?;
        anyhow::ensure!(
            other_bytes + json.len() as i64 <= 16 * 1024 * 1024,
            "capture evidence exceeds graph limit"
        );
        conn.execute(
            "INSERT INTO topology_capture_evidence(graph_id,source_ref,protocol,source_command,evidence_json,attempt_id) VALUES (?1,?2,?3,?4,?5,coalesce(?6,'')) ON CONFLICT(graph_id,source_ref,protocol,source_command) DO UPDATE SET evidence_json=excluded.evidence_json, attempt_id=coalesce(?6,topology_capture_evidence.attempt_id)",
            params![graph, self.source_ref, self.protocol, self.source_command, json, attempt],
        )?;
        Ok(())
    }
    pub fn attempt(
        conn: &Connection,
        graph: &str,
        source: &str,
        command: &str,
        status: &str,
    ) -> Result<String> {
        anyhow::ensure!(
            matches!(status, "incomplete" | "failed" | "unsupported"),
            "invalid attempt status"
        );
        let mut receipt = Self::load(conn, graph, source, command)?;
        receipt.attempted_at =
            conn.query_row("SELECT CAST(strftime('%s','now') AS INTEGER)", [], |r| {
                r.get(0)
            })?;
        receipt.status = status.into();
        for observation in &mut receipt.snmp_observations {
            observation.in_latest_attempt = false;
        }
        let attempt = uuid::Uuid::new_v4().to_string();
        receipt.save(conn, graph, Some(&attempt))?;
        Ok(attempt)
    }
    pub fn require_owner(
        conn: &Connection,
        graph: &str,
        source: &str,
        command: &str,
        attempt: &str,
    ) -> Result<()> {
        let owner: Option<String> = conn.query_row(
            "SELECT attempt_id FROM topology_capture_evidence WHERE graph_id=?1 AND source_ref=?2 AND protocol=?3 AND source_command=?4",
            params![graph, source, Self::protocol(command), command], |r| r.get(0),
        ).optional()?;
        anyhow::ensure!(
            owner.as_deref() == Some(attempt),
            "capture attempt was superseded"
        );
        Ok(())
    }
    pub fn finish(
        conn: &Connection,
        graph: &str,
        source: &str,
        command: &str,
        attempt: &str,
        status: &str,
    ) -> Result<()> {
        Self::finish_with_snmp(conn, graph, source, command, attempt, status, None)
    }
    pub(crate) fn finish_with_snmp(
        conn: &Connection,
        graph: &str,
        source: &str,
        command: &str,
        attempt: &str,
        status: &str,
        observations: Option<&[super::snmp::SnmpObservation]>,
    ) -> Result<()> {
        anyhow::ensure!(
            matches!(status, "failed" | "unsupported"),
            "invalid capture outcome"
        );
        let tx = conn.unchecked_transaction()?;
        Self::require_owner(&tx, graph, source, command, attempt)?;
        let mut receipt = Self::load(&tx, graph, source, command)?;
        receipt.status = status.into();
        if let Some(observations) = observations {
            receipt.merge_snmp(observations, false)?;
        }
        receipt.save(&tx, graph, None)?;
        tx.commit()?;
        Ok(())
    }
    /// Caller owns the capture transaction, so receipt/cache/edges commit together.
    pub fn complete(
        conn: &Connection,
        graph: &str,
        source: &str,
        command: &str,
        records: &[NeighborRecord],
    ) -> Result<()> {
        let Some(protocol) = Self::protocol(command) else {
            return Ok(());
        };
        anyhow::ensure!(
            records.len() <= 2000 && records.iter().all(|r| r.protocol == protocol),
            "invalid capture evidence records"
        );
        let mut receipt = Self::load(conn, graph, source, command)?;
        let now: i64 = conn.query_row("SELECT CAST(strftime('%s','now') AS INTEGER)", [], |r| {
            r.get(0)
        })?;
        let mut retained = BTreeMap::new();
        for mut observation in receipt.observations {
            observation.in_latest_capture = false;
            let key = NeighborObservation::identity(&observation.record)?;
            if retained
                .get(&key)
                .is_none_or(|previous: &NeighborObservation| {
                    previous.captured_at <= observation.captured_at
                })
            {
                retained.insert(key, observation);
            }
        }
        for record in records {
            retained.insert(
                NeighborObservation::identity(record)?,
                NeighborObservation {
                    record: record.clone(),
                    captured_at: now,
                    in_latest_capture: true,
                },
            );
        }
        anyhow::ensure!(
            retained.len() <= 10000,
            "capture evidence history exceeds record limit"
        );
        receipt.observations = retained.into_values().collect();
        receipt.attempted_at = now;
        receipt.status = "completed".into();
        receipt.save(conn, graph, None)
    }
    /// Must be inside the same owned transaction as completion/failure.
    pub fn snmp_provenance(
        conn: &Connection,
        graph: &str,
        source: &str,
        command: &str,
        observations: &[super::snmp::SnmpObservation],
    ) -> Result<()> {
        anyhow::ensure!(
            command == "snmp:cdp" || command == "snmp:lldp",
            "not an SNMP source"
        );
        let mut receipt = Self::load(conn, graph, source, command)?;
        receipt.merge_snmp(observations, true)?;
        receipt.save(conn, graph, None)
    }
    fn merge_snmp(
        &mut self,
        observations: &[super::snmp::SnmpObservation],
        refresh: bool,
    ) -> Result<()> {
        let identity = |observation: &super::snmp::SnmpObservation| -> Result<String> {
            let mut identity = observation.clone();
            identity.captured_at = 0;
            identity.in_latest_attempt = false;
            Ok(serde_json::to_string(&identity)?)
        };
        let mut retained = BTreeMap::new();
        for mut observation in std::mem::take(&mut self.snmp_observations) {
            observation.in_latest_attempt = false;
            retained.insert(identity(&observation)?, observation);
        }
        for observation in observations {
            let key = identity(observation)?;
            let mut observation = observation.clone();
            // Failed/partial attempts can add safe table evidence, but cannot refresh old timestamps.
            observation.captured_at = if !refresh {
                retained
                    .get(&key)
                    .map(|old| old.captured_at)
                    .unwrap_or(self.attempted_at)
            } else {
                self.attempted_at
            };
            observation.in_latest_attempt = true;
            retained.insert(key, observation);
        }
        anyhow::ensure!(
            retained.len() <= 10000,
            "SNMP provenance history exceeds record limit"
        );
        self.snmp_observations = retained.into_values().collect();
        Ok(())
    }
    pub fn list(conn: &Connection, graph: &str) -> Result<Vec<Self>> {
        let mut query = conn.prepare("SELECT evidence_json FROM topology_capture_evidence WHERE graph_id=?1 ORDER BY source_ref,protocol,source_command")?;
        let json = query
            .query_map([graph], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        json.into_iter()
            .map(|text| Ok(serde_json::from_str(&text)?))
            .collect()
    }
}
