//! Bounded offline topology interchange. No transport or saved-inventory writes.
use std::collections::{BTreeMap, BTreeSet};

use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection};
use serde_json::{Map, Value};

use super::{
    graph, GraphSnapshot, ImportProvenance, ImportedNodeMetadata, TopologyEdge, TopologyGraph,
    TopologyNode, UnsupportedProtocol,
};

const MAX_BYTES: usize = 10 * 1024 * 1024;
const MAX_NODES: usize = 2000;
const MAX_CONNECTIONS: usize = 10000;
const MAX_PROVENANCE_BYTES: usize = 2 * 1024 * 1024;
const PROTOCOLS: [&str; 7] = ["cdp", "lldp", "bgp", "ospf", "isis", "eigrp", "unknown"];
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, serde::Serialize)]
pub struct ImportPreview {
    pub format: String,
    pub node_count: usize,
    pub edge_count: usize,
    pub placeholder_count: usize,
    pub warnings: Vec<String>,
}

/// Validated data is private; import always reparses the submitted content.
pub struct TopologyImporter {
    snapshot: GraphSnapshot,
    format: String,
    warnings: BTreeSet<String>,
}

impl TopologyImporter {
    pub fn preview(content: &str) -> Result<ImportPreview> {
        let parsed = Self::parse(content)?;
        Ok(ImportPreview {
            format: parsed.format,
            node_count: parsed.snapshot.nodes.len(),
            edge_count: parsed.snapshot.edges.len(),
            placeholder_count: parsed.snapshot.import_provenance.as_ref().map_or(0, |p| {
                p.node_metadata.iter().filter(|n| n.placeholder).count()
            }),
            warnings: parsed.warnings.into_iter().collect(),
        })
    }

    pub fn import(conn: &Connection, content: &str, name: &str) -> Result<GraphSnapshot> {
        let name = name.trim();
        text(name, 256, false)?;
        ensure!(
            !name.chars().any(char::is_control),
            "graph name must not contain control characters"
        );
        let mut parsed = Self::parse(content)?;
        let id = uuid::Uuid::new_v4().to_string();
        let original_id = parsed.snapshot.graph.id.clone();
        parsed.snapshot.graph.id = id.clone();
        parsed.snapshot.graph.name = name.to_owned();
        for node in &mut parsed.snapshot.nodes {
            node.graph_id = id.clone();
        }
        for edge in &mut parsed.snapshot.edges {
            edge.graph_id = id.clone();
        }
        let receipt = parsed
            .snapshot
            .import_provenance
            .get_or_insert_with(|| ImportProvenance {
                format: "native".into(),
                imported_at: chrono::Utc::now().timestamp(),
                source_graph_id: Some(original_id),
                node_metadata: Vec::new(),
                unsupported_protocols: Vec::new(),
            });
        let provenance_json = serde_json::to_string(receipt)?;
        ensure!(
            provenance_json.len() <= MAX_PROVENANCE_BYTES,
            "import provenance exceeds 2 MiB"
        );

        let tx = conn.unchecked_transaction()?;
        let g = &parsed.snapshot.graph;
        tx.execute(
            "INSERT INTO topology_graphs(id, name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![g.id, g.name, g.description, g.created_at, g.updated_at],
        )?;
        for node in &parsed.snapshot.nodes {
            graph::upsert_node(&tx, node)?;
        }
        for edge in &parsed.snapshot.edges {
            // File capture 0 means absent/unknown. Never call native upsert_edge,
            // whose intentional 0 sentinel records a new native observation now.
            tx.execute(
                "INSERT INTO topology_edges(graph_id, a_device_ref, a_port, b_device_ref, b_port, protocol, captured_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, edge.a_device_ref, edge.a_port, edge.b_device_ref, edge.b_port, edge.protocol, edge.captured_at],
            )?;
        }
        for position in &parsed.snapshot.positions {
            tx.execute(
                "INSERT INTO topology_node_positions(graph_id, device_ref, x, y) VALUES (?1, ?2, ?3, ?4)",
                params![id, position.device_ref, position.x, position.y],
            )?;
        }
        tx.execute(
            "INSERT INTO topology_import_provenance(graph_id, provenance_json) VALUES (?1, ?2)",
            params![id, provenance_json],
        )?;
        let saved = graph::snapshot(&tx, &id)?;
        tx.commit()?;
        Ok(saved)
    }

    fn parse(content: &str) -> Result<Self> {
        ensure!(content.len() <= MAX_BYTES, "topology import exceeds 10 MiB");
        let UniqueJson(value) = serde_json::from_str(content).context("invalid topology JSON")?;
        bounded_value(&value, 0)?;
        let root = object(&value, "expected SC2 map or versioned native topology object; URLs, archives and device inventory are not maps")?;
        if root.get("format").is_some_and(Value::is_string)
            || root.get("version").is_some_and(Value::is_number)
            || root
                .get("snapshot")
                .is_some_and(|v| v.get("graph").is_some())
        {
            Self::native(value)
        } else {
            Self::sc2(root)
        }
    }

    fn native(value: Value) -> Result<Self> {
        ensure!(
            value["format"] == "terminai-topology",
            "unsupported topology format; expected terminai-topology"
        );
        ensure!(
            value["version"].as_u64() == Some(1),
            "unsupported native topology version; expected 1"
        );
        let snapshot: GraphSnapshot = serde_json::from_value(value["snapshot"].clone())
            .context("invalid native topology snapshot")?;
        ensure!(
            snapshot.capture_evidence.is_empty(),
            "native v1 does not import local collection receipts"
        );
        text(&snapshot.graph.id, 512, false)?;
        text(&snapshot.graph.name, 256, false)?;
        optional_text(snapshot.graph.description.as_deref(), 4096)?;
        timestamp(snapshot.graph.created_at)?;
        timestamp(snapshot.graph.updated_at)?;
        ensure!(
            snapshot.nodes.len() <= MAX_NODES,
            "topology exceeds 2000 nodes"
        );
        ensure!(
            snapshot.edges.len() <= MAX_CONNECTIONS,
            "topology exceeds 10000 connection records"
        );
        ensure!(
            snapshot.positions.len() <= MAX_NODES,
            "topology exceeds 2000 positions"
        );
        let mut nodes = BTreeSet::new();
        let mut references = BTreeSet::new();
        for node in &snapshot.nodes {
            ensure!(
                node.graph_id == snapshot.graph.id,
                "native node graph_id must match snapshot graph"
            );
            text(&node.device_ref, 512, false)?;
            ensure!(
                ["ssh", "netconf", "discovered"].contains(&node.device_kind.as_str()),
                "unsupported native node kind"
            );
            text(&node.label, 1024, true)?;
            optional_text(node.vendor.as_deref(), 1024)?;
            optional_text(node.platform.as_deref(), 1024)?;
            optional_text(node.mgmt_ip.as_deref(), 512)?;
            ensure!(
                nodes.insert((&node.device_ref, &node.device_kind)),
                "duplicate native node key"
            );
            references.insert(node.device_ref.as_str());
        }
        let mut edges = BTreeSet::new();
        for edge in &snapshot.edges {
            ensure!(
                edge.graph_id == snapshot.graph.id,
                "native edge graph_id must match snapshot graph"
            );
            validate_endpoints(
                &edge.a_device_ref,
                &edge.a_port,
                &edge.b_device_ref,
                &edge.b_port,
            )?;
            ensure!(
                references.contains(edge.a_device_ref.as_str())
                    && references.contains(edge.b_device_ref.as_str()),
                "native edge endpoint not found in declared nodes"
            );
            ensure!(
                PROTOCOLS.contains(&edge.protocol.as_str()),
                "unsupported native edge protocol"
            );
            timestamp(edge.captured_at)?;
            ensure!(
                edges.insert((
                    &edge.a_device_ref,
                    &edge.a_port,
                    &edge.b_device_ref,
                    &edge.b_port,
                    &edge.protocol
                )),
                "duplicate native edge key"
            );
        }
        let mut positions = BTreeSet::new();
        for position in &snapshot.positions {
            ensure!(
                references.contains(position.device_ref.as_str()),
                "native position node not found"
            );
            ensure!(
                position.x.is_finite() && position.y.is_finite(),
                "native position coordinates must be finite"
            );
            ensure!(
                positions.insert(&position.device_ref),
                "duplicate native position key"
            );
        }
        let mut warnings = BTreeSet::from(["Imported files are claims, not application-verified reachability or reverse observations.".into()]);
        if let Some(receipt) = &snapshot.import_provenance {
            validate_provenance(receipt)?;
            if !receipt.unsupported_protocols.is_empty() {
                warnings.insert("Unsupported source protocols are retained in provenance; normalized edges remain unknown.".into());
            }
        }
        Ok(Self {
            snapshot,
            format: "native".into(),
            warnings,
        })
    }

    fn sc2(root: &Map<String, Value>) -> Result<Self> {
        ensure!(root.len() <= MAX_NODES, "topology exceeds 2000 nodes");
        let now = chrono::Utc::now().timestamp();
        let mut nodes = BTreeMap::new();
        let mut metadata = BTreeMap::new();
        let mut edges = BTreeMap::new();
        let mut unsupported_protocols = Vec::new();
        let mut warnings = BTreeSet::from(["Imported files are claims, not application-verified reachability or reverse observations.".into()]);
        let mut connection_count = 0;
        // First pass records exact map keys; peer advertisements never overwrite declared nodes.
        for (reference, value) in root {
            text(reference, 512, false)?;
            let node = object(value, "SC2 map entries require node_details and peers objects; full device inventory is unsupported")?;
            let details = object(
                node.get("node_details")
                    .context("SC2 map entry requires node_details")?,
                "SC2 node_details must be an object",
            )?;
            object(
                node.get("peers").context("SC2 map entry requires peers")?,
                "SC2 peers must be an object",
            )?;
            if let Some(raw) = details.get("metadata") {
                ensure!(
                    serde_json::to_vec(raw)?.len() <= 16 * 1024,
                    "SC2 nested metadata exceeds 16 KiB per node"
                );
                warnings.insert("Nested SC2 metadata is not imported; only supported inventory fields are retained.".into());
            }
            nodes.insert(reference.clone(), sc2_node(reference, details)?);
            metadata.insert(
                reference.clone(),
                ImportedNodeMetadata {
                    device_ref: reference.clone(),
                    placeholder: false,
                    model: field(details, "model", 1024)?,
                    serial: field(details, "serial", 1024)?,
                    os_version: field(details, "os_version", 1024)?,
                },
            );
        }
        for (reference, value) in root {
            let peers = value["peers"].as_object().expect("validated SC2 peers");
            for (peer_ref, peer_value) in peers {
                text(peer_ref, 512, false)?;
                let peer = object(peer_value, "SC2 peer must be an object")?;
                let connections = peer.get("connections").and_then(Value::as_array).context(
                    "SC2 peer connections must be an array of [local, remote] port pairs",
                )?;
                connection_count += connections.len();
                ensure!(connection_count <= MAX_CONNECTIONS, "topology exceeds 10000 connection records (including reversed or duplicate claims)");
                let protocols = match peer.get("protocols") {
                    None => {
                        warnings.insert("Missing protocol arrays normalize to unknown; no LLDP evidence is inferred.".into());
                        None
                    }
                    Some(value) => {
                        let list = value
                            .as_array()
                            .context("SC2 protocols must be an array aligned with connections")?;
                        ensure!(
                            list.len() == connections.len(),
                            "SC2 protocols length must match connections"
                        );
                        Some(list)
                    }
                };
                // Validate supported peer fields even when a declared node is authoritative.
                let candidate = sc2_node(peer_ref, peer)?;
                if !nodes.contains_key(peer_ref) {
                    ensure!(
                        nodes.len() < MAX_NODES,
                        "topology exceeds 2000 nodes including missing-peer placeholders"
                    );
                    nodes.insert(peer_ref.clone(), candidate);
                    metadata.insert(
                        peer_ref.clone(),
                        ImportedNodeMetadata {
                            device_ref: peer_ref.clone(),
                            placeholder: true,
                            model: None,
                            serial: None,
                            os_version: None,
                        },
                    );
                    warnings.insert("Missing peers are placeholders with unknown collection status, not failed devices.".into());
                } else if !root.contains_key(peer_ref) {
                    let existing = &nodes[peer_ref];
                    if existing.mgmt_ip != candidate.mgmt_ip
                        || existing.platform != candidate.platform
                    {
                        warnings.insert("Conflicting placeholder inventory claims retain the first exact-key advertisement; no identity merge was performed.".into());
                    }
                }
                for (index, pair) in connections.iter().enumerate() {
                    let pair = pair
                        .as_array()
                        .context("SC2 connection requires local and remote port strings")?;
                    ensure!(
                        pair.len() == 2,
                        "SC2 connection requires exactly local and remote ports"
                    );
                    let local = pair[0]
                        .as_str()
                        .context("SC2 local port must be a string")?;
                    let remote = pair[1]
                        .as_str()
                        .context("SC2 remote port must be a string")?;
                    validate_endpoints(reference, local, peer_ref, remote)?;
                    let raw = match protocols {
                        None => "unknown",
                        Some(list) => {
                            let raw = list[index].as_str().context(
                                "SC2 protocol entries must be strings aligned with connections",
                            )?;
                            text(raw, 128, false)?;
                            raw
                        }
                    };
                    let normalized = raw.to_ascii_lowercase();
                    let protocol = if PROTOCOLS.contains(&normalized.as_str()) {
                        normalized
                    } else {
                        unsupported_protocols.push(UnsupportedProtocol {
                            a_device_ref: reference.clone(),
                            a_port: local.into(),
                            b_device_ref: peer_ref.clone(),
                            b_port: remote.into(),
                            raw_protocol: raw.into(),
                        });
                        warnings.insert("Unsupported source protocols are retained in provenance; normalized edges remain unknown.".into());
                        "unknown".into()
                    };
                    let (a, ap, b, bp) = graph::canonicalise(reference, local, peer_ref, remote);
                    edges
                        .entry((
                            a.to_owned(),
                            ap.to_owned(),
                            b.to_owned(),
                            bp.to_owned(),
                            protocol.clone(),
                        ))
                        .or_insert_with(|| TopologyEdge {
                            graph_id: String::new(),
                            a_device_ref: a.into(),
                            a_port: ap.into(),
                            b_device_ref: b.into(),
                            b_port: bp.into(),
                            protocol,
                            captured_at: 0,
                        });
                }
            }
        }
        let provenance = ImportProvenance {
            format: "sc2".into(),
            imported_at: now,
            source_graph_id: None,
            node_metadata: metadata.into_values().collect(),
            unsupported_protocols,
        };
        validate_provenance(&provenance)?;
        Ok(Self {
            format: "sc2".into(),
            warnings,
            snapshot: GraphSnapshot {
                graph: TopologyGraph {
                    id: String::new(),
                    name: String::new(),
                    description: None,
                    created_at: now,
                    updated_at: now,
                },
                nodes: nodes.into_values().collect(),
                edges: edges.into_values().collect(),
                positions: Vec::new(),
                import_provenance: Some(provenance),
                capture_evidence: Vec::new(),
            },
        })
    }
}

fn sc2_node(reference: &str, details: &Map<String, Value>) -> Result<TopologyNode> {
    Ok(TopologyNode {
        graph_id: String::new(),
        device_ref: reference.into(),
        device_kind: "discovered".into(),
        label: reference.into(),
        vendor: field(details, "vendor", 1024)?,
        platform: field(details, "platform", 1024)?,
        mgmt_ip: field(details, "ip", 512)?,
    })
}

fn object<'a>(value: &'a Value, message: &str) -> Result<&'a Map<String, Value>> {
    value.as_object().context(message.to_owned())
}

fn field(map: &Map<String, Value>, key: &str, limit: usize) -> Result<Option<String>> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let value = value
                .as_str()
                .context("supported SC2 inventory fields must be strings or null")?;
            text(value, limit, true)?;
            Ok(Some(value.to_owned()))
        }
    }
}

fn text(value: &str, max: usize, empty: bool) -> Result<()> {
    ensure!(
        value.len() <= max,
        "topology string exceeds {max} UTF-8 bytes"
    );
    ensure!(
        !value.contains('\0'),
        "topology strings must not contain NUL"
    );
    ensure!(
        empty || !value.trim().is_empty(),
        "topology reference, name or supplied protocol must not be empty"
    );
    Ok(())
}

fn optional_text(value: Option<&str>, max: usize) -> Result<()> {
    if let Some(value) = value {
        text(value, max, true)?;
    }
    Ok(())
}

fn timestamp(value: i64) -> Result<()> {
    ensure!(
        (0..=MAX_SAFE_INTEGER).contains(&value),
        "topology timestamps must be nonnegative safe integers; 0 means unknown"
    );
    Ok(())
}

fn validate_endpoints(a: &str, ap: &str, b: &str, bp: &str) -> Result<()> {
    text(a, 512, false)?;
    text(b, 512, false)?;
    text(ap, 256, true)?;
    text(bp, 256, true)
}

fn validate_provenance(value: &ImportProvenance) -> Result<()> {
    ensure!(
        ["sc2", "native"].contains(&value.format.as_str()),
        "unsupported import provenance format"
    );
    timestamp(value.imported_at)?;
    optional_text(value.source_graph_id.as_deref(), 512)?;
    ensure!(
        value.node_metadata.len() <= MAX_NODES
            && value.unsupported_protocols.len() <= MAX_CONNECTIONS,
        "import provenance record limit exceeded"
    );
    let mut refs = BTreeSet::new();
    for node in &value.node_metadata {
        text(&node.device_ref, 512, false)?;
        ensure!(
            refs.insert(&node.device_ref),
            "duplicate provenance node reference"
        );
        optional_text(node.model.as_deref(), 1024)?;
        optional_text(node.serial.as_deref(), 1024)?;
        optional_text(node.os_version.as_deref(), 1024)?;
    }
    for raw in &value.unsupported_protocols {
        validate_endpoints(
            &raw.a_device_ref,
            &raw.a_port,
            &raw.b_device_ref,
            &raw.b_port,
        )?;
        text(&raw.raw_protocol, 128, false)?;
    }
    ensure!(
        serde_json::to_vec(value)?.len() <= MAX_PROVENANCE_BYTES,
        "import provenance exceeds 2 MiB"
    );
    Ok(())
}

/// serde_json::Value normally keeps only the last repeated key. At this import
/// boundary that could hide a malformed supplied protocol array or erase a node.
struct UniqueJson(Value);

impl<'de> serde::Deserialize<'de> for UniqueJson {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = UniqueJson;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON without duplicate keys")
            }
            fn visit_bool<E: serde::de::Error>(
                self,
                v: bool,
            ) -> std::result::Result<UniqueJson, E> {
                Ok(UniqueJson(Value::Bool(v)))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> std::result::Result<UniqueJson, E> {
                Ok(UniqueJson(Value::Number(v.into())))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> std::result::Result<UniqueJson, E> {
                Ok(UniqueJson(Value::Number(v.into())))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<UniqueJson, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| UniqueJson(Value::Number(n)))
                    .ok_or_else(|| E::custom("non-finite JSON number"))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> std::result::Result<UniqueJson, E> {
                Ok(UniqueJson(Value::String(v.into())))
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<UniqueJson, E> {
                Ok(UniqueJson(Value::Null))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<UniqueJson, A::Error> {
                let mut values = Vec::new();
                while let Some(UniqueJson(value)) = seq.next_element()? {
                    values.push(value);
                }
                Ok(UniqueJson(Value::Array(values)))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<UniqueJson, A::Error> {
                let mut values = Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(serde::de::Error::custom("duplicate JSON key"));
                    }
                    let UniqueJson(value) = map.next_value()?;
                    values.insert(key, value);
                }
                Ok(UniqueJson(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}

/// Bound ignored data too: accepting a map does not authorize unlimited raw records.
fn bounded_value(value: &Value, depth: usize) -> Result<()> {
    ensure!(depth <= 32, "topology JSON nesting exceeds 32 levels");
    match value {
        Value::String(s) => text(s, 4096, true)?,
        Value::Array(values) => {
            for value in values {
                bounded_value(value, depth + 1)?;
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                text(key, 512, true)?;
                bounded_value(value, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}
