//! Compiled telemetry assets, protocol observations and strict upstream draft translation.
use super::{
    config::TelemetryConfigRepository,
    definition::{parse_document, ArithmeticExpression, DefinitionValidator, MAX_YAML_BYTES},
    model::*,
    processing::FrameNormalizer,
};
use serde::Deserialize;
use serde_yaml::{Mapping, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Deserialize)]
struct Manifest {
    schema_version: u32,
    templates: Vec<AssetBinding>,
}
#[derive(Deserialize)]
struct AssetBinding {
    id: String,
    platform: Platform,
    command: String,
    path: String,
    sha256: String,
}

impl Catalog {
    pub fn builtin() -> Result<Self, Diagnostic> {
        let manifest: Manifest = serde_json::from_str(include_str!("../../telemetry/catalog.json"))
            .map_err(|_| {
                Diagnostic::new(
                    "builtin_catalog",
                    "Compiled catalog metadata is invalid",
                    "catalog",
                )
            })?;
        if manifest.schema_version != 1 {
            return Err(Diagnostic::new(
                "schema_version",
                "Unsupported catalog version",
                "catalog",
            ));
        }
        let mut catalog = Self::default();
        for asset in manifest.templates {
            let text = template_text(&asset.path)?;
            if format!("{:x}", Sha256::digest(text.as_bytes())) != asset.sha256 {
                return Err(Diagnostic::new(
                    "builtin_hash",
                    "Compiled template checksum mismatch",
                    asset.id,
                ));
            }
            let template = TemplateAsset {
                id: asset.id.clone(),
                platform: asset.platform,
                command: asset.command,
                text: text.into(),
                sha256: asset.sha256,
            };
            if catalog
                .templates
                .insert(asset.id.clone(), template)
                .is_some()
            {
                return Err(Diagnostic::new(
                    "duplicate_template",
                    "Repeated bundled template",
                    asset.id,
                ));
            }
        }
        let widgets: WidgetDocument = parse_document(include_str!("../../telemetry/widgets.yaml"))?;
        let layouts: LayoutDocument = parse_document(include_str!("../../telemetry/layouts.yaml"))?;
        if widgets.schema_version != 1 || layouts.schema_version != 1 {
            return Err(Diagnostic::new(
                "schema_version",
                "Unsupported bundled definition version",
                "catalog",
            ));
        }
        for widget in widgets.widgets {
            if catalog
                .widgets
                .insert(widget.widget.clone(), widget)
                .is_some()
            {
                return Err(Diagnostic::new(
                    "duplicate_widget",
                    "Repeated bundled widget",
                    "widgets",
                ));
            }
        }
        for layout in layouts.layouts {
            if catalog
                .layouts
                .insert(layout.layout.clone(), layout)
                .is_some()
            {
                return Err(Diagnostic::new(
                    "duplicate_layout",
                    "Repeated bundled layout",
                    "layouts",
                ));
            }
        }
        // Validate each source domain with the same authoritative parser as editable drafts.
        for scope in [
            ConfigScope::Local,
            ConfigScope::Profile(Platform::Ios),
            ConfigScope::Profile(Platform::Iosxe),
        ] {
            let local = scope == ConfigScope::Local;
            let draft = ConfigDraft {
                scope,
                widgets_yaml: serde_yaml::to_string(&WidgetDocument {
                    schema_version: 1,
                    widgets: catalog
                        .widgets
                        .values()
                        .filter(|w| matches!(w.source, WidgetSource::Local { .. }) == local)
                        .cloned()
                        .collect(),
                })
                .map_err(encoding)?,
                layouts_yaml: serde_yaml::to_string(&LayoutDocument {
                    schema_version: 1,
                    layouts: catalog
                        .layouts
                        .values()
                        .filter(|l| l.platforms.is_empty() == local)
                        .cloned()
                        .collect(),
                })
                .map_err(encoding)?,
                templates: BTreeMap::new(),
                expected_revision: String::new(),
                reset_assets: vec![],
            };
            DefinitionValidator.parse(&draft, &catalog).map_err(|d| {
                d.into_iter()
                    .next()
                    .expect("failed validation has a diagnostic")
            })?;
        }
        Ok(catalog)
    }
}
fn encoding(_: serde_yaml::Error) -> Diagnostic {
    Diagnostic::new("yaml_encoding", "Definition cannot be encoded", "import")
}
fn template_text(path: &str) -> Result<&'static str, Diagnostic> {
    Ok(match path.strip_prefix("templates/").unwrap_or("") {
        "cisco_ios_show_version.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_version.textfsm")
        }
        "cisco_ios_show_processes_cpu.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_processes_cpu.textfsm")
        }
        "cisco_ios_show_processes_memory_sorted.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_processes_memory_sorted.textfsm")
        }
        "cisco_ios_show_interfaces.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_interfaces.textfsm")
        }
        "cisco_ios_show_interfaces_description.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_interfaces_description.textfsm")
        }
        "cisco_ios_show_interfaces_status.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_interfaces_status.textfsm")
        }
        "cisco_ios_show_ip_interface.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_ip_interface.textfsm")
        }
        "cisco_ios_show_ip_interface_brief.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_ip_interface_brief.textfsm")
        }
        "cisco_ios_show_ip_bgp_summary.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_ip_bgp_summary.textfsm")
        }
        "cisco_ios_show_ip_bgp_vpnv4_all_neighbors.textfsm" => include_str!(
            "../../telemetry/templates/cisco_ios_show_ip_bgp_vpnv4_all_neighbors.textfsm"
        ),
        "cisco_ios_show_ip_ospf_neighbor.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_ip_ospf_neighbor.textfsm")
        }
        "cisco_ios_show_ip_ospf_interface_brief.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_ip_ospf_interface_brief.textfsm")
        }
        "cisco_ios_show_ip_eigrp_neighbors.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_ip_eigrp_neighbors.textfsm")
        }
        "cisco_ios_show_vlan.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_vlan.textfsm")
        }
        "cisco_ios_show_interfaces_switchport.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_interfaces_switchport.textfsm")
        }
        "cisco_ios_show_spanning-tree.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_spanning-tree.textfsm")
        }
        "cisco_ios_show_spanning-tree_root.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_spanning-tree_root.textfsm")
        }
        "cisco_ios_show_etherchannel_summary.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_etherchannel_summary.textfsm")
        }
        "cisco_ios_show_cdp_neighbors_detail.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_cdp_neighbors_detail.textfsm")
        }
        "cisco_ios_show_lldp_neighbors_detail.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_lldp_neighbors_detail.textfsm")
        }
        "cisco_ios_show_mac-address-table.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_mac-address-table.textfsm")
        }
        "cisco_ios_show_inventory.textfsm" => {
            include_str!("../../telemetry/templates/cisco_ios_show_inventory.textfsm")
        }
        "ios_interface_bytes.textfsm" => {
            include_str!("../../telemetry/templates/ios_interface_bytes.textfsm")
        }
        _ => {
            return Err(Diagnostic::new(
                "builtin_template",
                "Compiled template path is unknown",
                path,
            ))
        }
    })
}

/// Adds only command/field-grounded observations. No rates, aliases or arithmetic are duplicated.
pub struct ProtocolClassifier;
impl ProtocolClassifier {
    pub fn normalize(
        context: &FrameContext,
        definition: &WidgetDefinition,
        capture: &Capture,
        records: Vec<MetricRow>,
        previous: Option<(&[MetricRow], u64)>,
    ) -> WidgetFrame {
        Self::normalize_bounded(
            context,
            definition,
            capture,
            records,
            previous,
            super::processing::MAX_WORKSPACE_BYTES,
        )
    }
    pub(crate) fn normalize_bounded(
        context: &FrameContext,
        definition: &WidgetDefinition,
        capture: &Capture,
        records: Vec<MetricRow>,
        previous: Option<(&[MetricRow], u64)>,
        maximum_bytes: usize,
    ) -> WidgetFrame {
        let mut frame = FrameNormalizer::normalize_bounded(
            context,
            definition,
            capture,
            records,
            previous,
            maximum_bytes,
        );
        if frame.state == CollectionState::Failed {
            return frame;
        }
        if let Some((state, diagnostic)) = Self::capture_rejection(capture) {
            frame.state = state;
            frame.severity = ObservationSeverity::Info;
            frame.rows.clear();
            frame.last_success_at_ms = None;
            frame.diagnostics.push(diagnostic);
            return frame;
        }
        if frame.rows.is_empty() {
            frame.state = CollectionState::Failed;
            frame.last_success_at_ms = None;
            frame.diagnostics.push(Diagnostic::new("parse_mismatch","No parsed records; no source-pinned supported-empty evidence exists for this binding",&definition.widget));
            return frame;
        }
        Self::classify(&mut frame, definition, capture);
        frame
    }
    /// Used only at the shared alias -> value admission seam, before keys/math/alerts.
    pub(crate) fn field_value(
        definition: &WidgetDefinition,
        capture: &Capture,
        field: &str,
        alias: &str,
        value: &MetricValue,
    ) -> Option<MetricValue> {
        if !source_matches(definition, capture, "show ip bgp summary")
            || !bgp_summary_parser(capture.platform, &capture.parser_id)
            || !bgp_canonical_alias(field, alias)
        {
            return None;
        }
        let token = match value {
            MetricValue::Text { value } | MetricValue::Unsigned { value } => value.as_str(),
            _ => return None,
        };
        let numeric = !token.is_empty() && token.bytes().all(|b| b.is_ascii_digit());
        let count = numeric.then(|| token.parse::<u64>().ok()).flatten();
        match (field, count, numeric) {
            ("state", Some(_), _) => Some(MetricValue::Text {
                value: "Established".into(),
            }),
            ("state", None, true) => Some(missing("prefix_count_out_of_range")),
            ("state", None, false) => None,
            (_, Some(count), _) => Some(MetricValue::Unsigned {
                value: count.to_string(),
            }),
            (_, None, true) => Some(missing("prefix_count_out_of_range")),
            _ => Some(missing(if token.eq_ignore_ascii_case("Established") {
                "prefix_count_unavailable"
            } else {
                "neighbor_not_established"
            })),
        }
    }
    /// Call after capture binding, size and hash validation, before invoking TextFSM.
    /// Unknown output remains a parser diagnostic; these signatures never prove configuration absence.
    pub fn capture_rejection(capture: &Capture) -> Option<(CollectionState, Diagnostic)> {
        for line in capture.raw.lines().map(str::trim) {
            let (state, code, message) = if line.starts_with("% Invalid input detected") {
                (
                    CollectionState::Unsupported,
                    "command_unsupported",
                    "Device rejected the command",
                )
            } else if line == "Command authorization failed." {
                (
                    CollectionState::Failed,
                    "command_permission",
                    "Device denied permission for the command",
                )
            } else {
                continue;
            };
            return Some((state, Diagnostic::new(code, message, "capture")));
        }
        None
    }
    pub fn classify(frame: &mut WidgetFrame, definition: &WidgetDefinition, capture: &Capture) {
        if frame.state != CollectionState::Fresh {
            return;
        }
        if source_matches(definition, capture, "show ip bgp summary")
            && bgp_summary_parser(capture.platform, &capture.parser_id)
        {
            if ["state", "prefixes_received"].iter().any(|field| {
                definition.fields.get(*field).is_some_and(|aliases| {
                    aliases
                        .iter()
                        .any(|alias| !bgp_canonical_alias(field, alias))
                })
            }) {
                frame.diagnostics.push(Diagnostic::new("classification_binding", "Edited aliases require context; canonicalization applies only to selected known aliases", &frame.widget_id));
            }
            frame.diagnostics.push(Diagnostic::new(
                "routing_context_missing",
                "BGP summary does not establish VRF; address family is retained only when parsed",
                &frame.widget_id,
            ));
            return;
        }
        let binding = match frame.widget_id.as_str() {
            "bgp_vrf_peers" => ("show ip bgp vpnv4 all neighbors", "state", "bgp_state"),
            "ospf_neighbors" => ("show ip ospf neighbor", "state", "state"),
            "ospf_interfaces" => ("show ip ospf interface brief", "process", "process"),
            "eigrp_neighbors" => ("show ip eigrp neighbors", "as_number", "as"),
            "stp_ports" => ("show spanning-tree", "role", "role"),
            "trunks" => ("show interfaces switchport", "mode", "mode"),
            "interface_traffic" => ("show interfaces", "capacity_kbit_s", "capacity_kbit_s"),
            _ => return,
        };
        if !source_matches(definition, capture, binding.0)
            || !definition.fields.get(binding.1).is_some_and(|aliases| {
                aliases
                    .iter()
                    .all(|alias| alias.eq_ignore_ascii_case(binding.2))
            })
        {
            frame.diagnostics.push(Diagnostic::new("classification_binding", "Edited source/aliases require context; canonicalization applies only to selected known aliases", &frame.widget_id));
            return;
        }
        let mut notes = BTreeSet::new();
        for row in &frame.rows {
            match frame.widget_id.as_str() {
                "bgp_vrf_peers" => {
                    notes.insert(("routing_context_missing","VRF detail does not establish address family, uptime or prefixes; never join summary by peer address alone"));
                }
                "ospf_neighbors" => {
                    let state = text(row, "state").to_ascii_uppercase();
                    if state.starts_with("2WAY") || state.starts_with("2-WAY") {
                        notes.insert(("ospf_context_missing","2-Way can be normal between broadcast DROTHERs; network type/local role is not established by this capture"));
                    }
                    notes.insert(("routing_context_missing","OSPF neighbor capture does not establish process or VRF; no interface-table join is inferred"));
                }
                "ospf_interfaces" => {
                    notes.insert(("routing_context_missing","OSPF interface capture does not establish VRF or a safe neighbor-table join"));
                }
                "eigrp_neighbors" => {
                    notes.insert(("routing_context_missing","EIGRP capture preserves AS but does not establish address family, named process or VRF"));
                }
                "stp_ports" => {
                    let role = text(row, "role").to_ascii_lowercase();
                    let state = text(row, "state").to_ascii_lowercase();
                    if !matches!(state.as_str(), "fwd" | "forwarding")
                        && !(matches!(role.as_str(), "altn" | "alternate" | "backup" | "back")
                            && matches!(state.as_str(), "blk" | "blocking" | "discarding" | "disc"))
                    {
                        notes.insert(("stp_state_context","STP port state needs role/topology context; no blanket down-state alert"));
                    }
                }
                "trunks" => {
                    notes.insert(("trunk_sets_unavailable","Switchport mode/native/enabled VLANs are observations only; active/forwarding/pruned trunk VLAN sets are unavailable"));
                }
                "interface_traffic" => {
                    if text(row, "capacity_kbit_s")
                        .parse::<u64>()
                        .ok()
                        .filter(|n| *n > 0)
                        .is_none()
                    {
                        notes.insert(("interface_capacity_missing","Interface utilization is unavailable without positive configured bandwidth"));
                    }
                    notes.insert(("configured_bandwidth","Utilization uses configured BW, not independently measured physical/negotiated capacity"));
                }
                _ => {}
            }
        }
        for (code, message) in notes {
            frame
                .diagnostics
                .push(Diagnostic::new(code, message, &frame.widget_id));
        }
    }
}
fn bgp_summary_parser(platform: Platform, parser_id: &str) -> bool {
    matches!(
        (platform, parser_id),
        (Platform::Ios, "ios.show_ip_bgp_summary") | (Platform::Iosxe, "iosxe.show_ip_bgp_summary")
    )
}
fn bgp_canonical_alias(field: &str, alias: &str) -> bool {
    matches!(field, "state" | "prefixes_received")
        && alias.eq_ignore_ascii_case("state_or_prefixes_received")
}
fn source_matches(definition: &WidgetDefinition, capture: &Capture, command: &str) -> bool {
    capture.command == command
        && matches!(&definition.source, WidgetSource::Ssh {commands, templates}
        if commands.get(&capture.platform) == Some(&capture.command) && templates.get(&capture.platform) == Some(&capture.parser_id))
}
fn text<'a>(row: &'a MetricRow, field: &str) -> &'a str {
    match row.fields.get(field) {
        Some(MetricValue::Text { value } | MetricValue::Unsigned { value }) => value,
        _ => "",
    }
}
fn missing(reason: &str) -> MetricValue {
    MetricValue::Missing {
        reason: reason.into(),
    }
}
/// Translates the documented terminaltelemetry2 pinned subset. YAML cannot choose authority.
pub struct UpstreamWidgetImporter<'a> {
    repository: &'a TelemetryConfigRepository,
    scope: ConfigScope,
}
impl<'a> UpstreamWidgetImporter<'a> {
    pub fn new(repository: &'a TelemetryConfigRepository, scope: ConfigScope) -> Self {
        Self { repository, scope }
    }
    pub fn import(&self, yaml: &str) -> ImportReport {
        if yaml.len() > MAX_YAML_BYTES {
            return ImportReport {
                draft: None,
                diagnostics: vec![Diagnostic::new(
                    "yaml_limit",
                    "Import exceeds 256KiB",
                    "import",
                )],
            };
        }
        let mut layout_input = false;
        let converted = (|| {
            let value: Value = parse_document(yaml)?;
            let map = mapping(&value, "")?;
            let catalog = Catalog::builtin()?;
            layout_input = map.contains_key("layout") && !map.contains_key("widget");
            let (widgets, layouts) = if map.contains_key("widget") {
                (vec![self.widget(map, &catalog)?], vec![])
            } else if map.contains_key("layout") {
                (vec![], vec![Self::layout(map)?])
            } else {
                return Err(unsupported(
                    "",
                    "Expected one upstream widget or layout document",
                ));
            };
            let draft = self.repository.import_draft(
                self.scope.clone(),
                serde_yaml::to_string(&WidgetDocument {
                    schema_version: 1,
                    widgets,
                })
                .map_err(encoding)?,
                serde_yaml::to_string(&LayoutDocument {
                    schema_version: 1,
                    layouts,
                })
                .map_err(encoding)?,
                BTreeMap::new(),
            )?;
            let report = self.repository.validate(&draft);
            if let Some(d) = report.diagnostics.into_iter().next() {
                return Err(d);
            }
            Ok(draft)
        })();
        match converted {
            Ok(draft) => ImportReport {
                draft: Some(draft),
                diagnostics: vec![],
            },
            Err(diagnostic) => {
                // Preserve exact input for editing; the unknown marker blocks native validation/Apply.
                let preserved = format!("{yaml}\n__unsupported_upstream_import__: true\n");
                let draft = self.repository.import_draft(
                    self.scope.clone(),
                    if layout_input {
                        "schema_version: 1\nwidgets: []\n".into()
                    } else {
                        preserved.clone()
                    },
                    if layout_input {
                        preserved
                    } else {
                        "schema_version: 1\nlayouts: []\n".into()
                    },
                    BTreeMap::new(),
                );
                match draft {
                    Ok(draft) => ImportReport {
                        draft: Some(draft),
                        diagnostics: vec![diagnostic],
                    },
                    Err(authority) => ImportReport {
                        draft: None,
                        diagnostics: vec![diagnostic, authority],
                    },
                }
            }
        }
    }
    fn widget(&self, map: &Mapping, catalog: &Catalog) -> Result<WidgetDefinition, Diagnostic> {
        keys(
            map,
            &[
                "widget",
                "title",
                "interval",
                "commands",
                "templates",
                "fields",
                "key",
                "rates",
                "deltas",
                "computes",
                "view",
            ],
            "",
        )?;
        let id = string(required(map, "widget", "")?, "widget")?;
        let mut commands = BTreeMap::new();
        for (platform, command) in mapping(required(map, "commands", "")?, "commands")? {
            let p = string(platform, "commands")?;
            let value = string(command, &format!("commands.{p}"))?;
            for translated in platforms(&p, &format!("commands.{p}"))? {
                commands.insert(translated, value.clone());
            }
        }
        let requests = map
            .get("templates")
            .map(|v| mapping(v, "templates"))
            .transpose()?;
        if let Some(requests) = requests {
            for (key, _) in requests {
                let key = string(key, "templates")?;
                platforms(&key, &format!("templates.{key}"))?;
                if !mapping(required(map, "commands", "")?, "commands")?.contains_key(&key) {
                    return Err(unsupported(
                        &format!("templates.{key}"),
                        "Template platform has no command",
                    ));
                }
            }
        }
        let mut templates = BTreeMap::new();
        for (platform, command) in &commands {
            let request = requests
                .and_then(|m| m.get("cisco_ios"))
                .map(|v| string(v, "templates.cisco_ios"))
                .transpose()?;
            let binding = catalog.templates.values().find(|a| {
                a.platform == *platform
                    && a.command == *command
                    && request
                        .as_ref()
                        .map_or(!a.id.ends_with("interface_bytes"), |name| {
                            a.id == format!(
                                "{}.{suffix}",
                                match platform {
                                    Platform::Ios => "ios",
                                    Platform::Iosxe => "iosxe",
                                },
                                suffix = name.strip_prefix("cisco_ios_").unwrap_or(name)
                            )
                        })
            });
            templates.insert(*platform,binding.ok_or_else(||unsupported("templates.cisco_ios","No exact bundled template matches this platform, command and requested template; automatic sweeps/siblings are unsupported"))?.id.clone());
        }
        let mut fields = BTreeMap::new();
        for (name, aliases) in mapping(required(map, "fields", "")?, "fields")? {
            let name = string(name, "fields")?;
            let mut normalized = Vec::new();
            for alias in sequence(aliases, &format!("fields.{name}"))? {
                let alias = string(alias, &format!("fields.{name}"))?;
                for key in [alias.to_lowercase(), alias] {
                    if !normalized.contains(&key) {
                        normalized.push(key);
                    }
                }
            }
            fields.insert(name, normalized);
        }
        if commands.iter().any(|(platform, command)| {
            command == "show ip bgp summary"
                && templates
                    .get(platform)
                    .is_some_and(|id| bgp_summary_parser(*platform, id))
        }) {
            for (field, aliases) in &fields {
                if aliases
                    .iter()
                    .any(|alias| bgp_canonical_alias(field, alias))
                {
                    return Err(unsupported(&format!("fields.{field}"), "Native BGP canonicalization changes upstream raw values; use a distinct raw output field name or author native canonical YAML explicitly"));
                }
            }
        }
        let key = match map.get("key") {
            None => vec![],
            Some(Value::String(v)) => vec![v.clone()],
            Some(v) => strings(v, "key")?,
        };
        if key.is_empty()
            && commands
                .values()
                .any(|c| !matches!(c.as_str(), "show version" | "show processes memory sorted"))
        {
            return Err(unsupported("key","This runtime requires an explicit stable key for non-singleton sources; no ordinal/deduplication key is invented"));
        }
        let rates = transforms(map.get("rates"), "rates")?;
        let deltas = transforms(map.get("deltas"), "deltas")?;
        let safe_counter = |field: &str| {
            fields.get(field).is_some_and(|aliases| {
                aliases.iter().all(|alias| {
                    templates.values().all(|id| {
                        catalog.templates[id].text.lines().any(|line| {
                            let words: Vec<_> = line.split_whitespace().collect();
                            words.first() == Some(&"Value")
                                && !words.contains(&"List")
                                && words
                                    .get(words.len().saturating_sub(2))
                                    .is_some_and(|header| header.eq_ignore_ascii_case(alias))
                                && words.last() == Some(&"(\\d+)")
                        })
                    })
                })
            })
        };
        for (name, transform) in rates.iter().chain(&deltas) {
            if !safe_counter(&transform.field) {
                return Err(unsupported(&format!("rates_or_deltas.{name}"),"Only exact unsigned scalar template counters preserve rate/delta semantics; unit-bearing/list/fallback operands are unsupported"));
            }
        }
        let computes: BTreeMap<String, String> = map
            .get("computes")
            .map(|v| parse_map_strings(v, "computes"))
            .transpose()?
            .unwrap_or_default();
        for (name, expression) in &computes {
            let expr = ArithmeticExpression::parse(expression).map_err(|mut d| {
                d.path = format!("computes.{name}");
                d
            })?;
            if expr.fields().iter().any(|field| {
                !rates.contains_key(field) && !deltas.contains_key(field) && !safe_counter(field)
            }) {
                return Err(unsupported(&format!("computes.{name}"),"Computes accept exact unsigned scalar fields, rates and deltas; unit-prefix coercion and chained computes are unsupported"));
            }
        }
        let view_map = mapping(required(map, "view", "")?, "view")?;
        if let Some(alerts) = view_map.get("alerts") {
            if !sequence(alerts, "view.alerts")?.is_empty() {
                return Err(unsupported("view.alerts[0]", "Upstream alert coercion, precision and fallback semantics are unsupported; author native YAML alerts explicitly"));
            }
        }
        let kind = string(required(view_map, "type", "view")?, "view.type")?;
        let labels = view_map
            .get("labels")
            .map(|v| parse_map_strings(v, "view.labels"))
            .transpose()?
            .unwrap_or_default();
        let view = match kind.as_str() {
            "table" | "kv" => {
                keys(
                    view_map,
                    if kind == "table" {
                        &["type", "columns", "labels", "alerts"]
                    } else {
                        &["type", "show", "labels"]
                    },
                    "view",
                )?;
                let names = if kind == "table" {
                    strings(required(view_map, "columns", "view")?, "view.columns")?
                } else {
                    view_map
                        .get("show")
                        .map(|v| strings(v, "view.show"))
                        .transpose()?
                        .unwrap_or_else(|| {
                            fields
                                .keys()
                                .chain(rates.keys())
                                .chain(deltas.keys())
                                .cloned()
                                .collect()
                        })
                };
                for label in labels.keys() {
                    if !names.contains(label) {
                        return Err(unsupported(
                            &format!("view.labels.{label}"),
                            "Label does not name a displayed field",
                        ));
                    }
                }
                let columns = names
                    .into_iter()
                    .map(|field| ViewField {
                        label: labels.get(&field).cloned().unwrap_or_else(|| field.clone()),
                        field,
                        unit: None,
                    })
                    .collect();
                if kind == "table" {
                    WidgetView::Table { columns }
                } else {
                    WidgetView::Kv { columns }
                }
            }
            "stat" => {
                keys(view_map, &["type", "aggregate", "field", "label"], "view")?;
                let name = string(required(view_map, "aggregate", "view")?, "view.aggregate")?;
                let aggregation = match name.as_str() {
                    "count" => Aggregation::Count,
                    "sum" => Aggregation::Sum,
                    "min" => Aggregation::Min,
                    "max" => Aggregation::Max,
                    _ => {
                        return Err(unsupported(
                            "view.aggregate",
                            "Supported aggregates: count, sum, min, max",
                        ))
                    }
                };
                let field = view_map
                    .get("field")
                    .map(|v| string(v, "view.field"))
                    .transpose()?;
                if aggregation != Aggregation::Count
                    && field.as_ref().is_some_and(|f| {
                        !safe_counter(f)
                            && !rates.contains_key(f)
                            && !deltas.contains_key(f)
                            && !computes.contains_key(f)
                    })
                {
                    return Err(unsupported(
                        "view.field",
                        "Numeric aggregate requires a proven scalar numeric field",
                    ));
                }
                WidgetView::Stat {
                    field,
                    label: view_map
                        .get("label")
                        .map(|v| string(v, "view.label"))
                        .transpose()?
                        .unwrap_or_else(|| id.clone()),
                    aggregation,
                }
            }
            _ => {
                return Err(unsupported(
                    "view.type",
                    "Supported upstream view types: table, kv, stat",
                ))
            }
        };
        let interval = map
            .get("interval")
            .map(|v| {
                v.as_u64()
                    .filter(|n| *n <= u32::MAX as u64)
                    .map(|n| n as u32)
                    .ok_or_else(|| unsupported("interval", "Interval must be integer seconds"))
            })
            .transpose()?
            .unwrap_or(30);
        Ok(WidgetDefinition {
            widget: id.clone(),
            title: map
                .get("title")
                .map(|v| string(v, "title"))
                .transpose()?
                .unwrap_or(id),
            source: WidgetSource::Ssh {
                commands,
                templates,
            },
            interval,
            key,
            fields,
            view,
            rates,
            deltas,
            computes,
            alerts: vec![],
            history: None,
        })
    }
    fn layout(map: &Mapping) -> Result<LayoutDefinition, Diagnostic> {
        keys(map, &["layout", "platforms", "rows"], "")?;
        let mut translated = Vec::new();
        for platform in strings(required(map, "platforms", "")?, "platforms")? {
            for p in platforms(&platform, &format!("platforms.{platform}"))? {
                if !translated.contains(&p) {
                    translated.push(p);
                }
            }
        }
        if translated.is_empty() {
            return Err(unsupported(
                "platforms",
                "Upstream empty/default platform selection is not Local PC semantics",
            ));
        }
        let mut rows = Vec::new();
        for (index, value) in sequence(required(map, "rows", "")?, "rows")?
            .iter()
            .enumerate()
        {
            let path = format!("rows[{index}]");
            let mut row = Vec::new();
            for (column, value) in sequence(value, &path)?.iter().enumerate() {
                let path = format!("{path}[{column}]");
                let (widget, span) = match value {
                    Value::String(name) => (name.clone(), 1),
                    Value::Mapping(m) => {
                        keys(m, &["name", "span"], &path)?;
                        (
                            string(required(m, "name", &path)?, &format!("{path}.name"))?,
                            m.get("span")
                                .map(|v| {
                                    v.as_u64().ok_or_else(|| {
                                        unsupported(
                                            &format!("{path}.span"),
                                            "Span must be a positive integer",
                                        )
                                    })
                                })
                                .transpose()?
                                .unwrap_or(1),
                        )
                    }
                    _ => {
                        return Err(unsupported(
                            &path,
                            "Entry must be a widget name or name/span mapping",
                        ))
                    }
                };
                if !(1..=12).contains(&span) {
                    return Err(unsupported(
                        &format!("{path}.span"),
                        "Relative span must be 1–12",
                    ));
                }
                row.push((widget, span));
            }
            let sum: u64 = row.iter().map(|(_, span)| span).sum();
            if sum == 0 || row.iter().any(|(_, span)| span * 12 % sum != 0) {
                return Err(unsupported(&path,"Relative spans must map exactly to the 12-column native grid; no rounding is applied"));
            }
            rows.push(
                row.into_iter()
                    .map(|(widget, span)| LayoutEntry {
                        widget,
                        span: (span * 12 / sum) as u8,
                    })
                    .collect(),
            );
        }
        Ok(LayoutDefinition {
            layout: string(required(map, "layout", "")?, "layout")?,
            platforms: translated,
            sections: vec![LayoutSection {
                id: "imported".into(),
                title: "Imported".into(),
                rows,
            }],
        })
    }
}
fn unsupported(path: &str, message: &str) -> Diagnostic {
    Diagnostic::new("upstream_unsupported", message, path)
}
fn keys(map: &Mapping, allowed: &[&str], path: &str) -> Result<(), Diagnostic> {
    for key in map.keys() {
        let key = string(key, path)?;
        if !allowed.contains(&key.as_str()) {
            let path = if path.is_empty() {
                key
            } else {
                format!("{path}.{key}")
            };
            return Err(unsupported(
                &path,
                "Unsupported upstream behavior; convert/remove this field explicitly before Apply",
            ));
        }
    }
    Ok(())
}
fn mapping<'a>(value: &'a Value, path: &str) -> Result<&'a Mapping, Diagnostic> {
    value
        .as_mapping()
        .ok_or_else(|| unsupported(path, "Expected a mapping"))
}
fn sequence<'a>(value: &'a Value, path: &str) -> Result<&'a Vec<Value>, Diagnostic> {
    value
        .as_sequence()
        .ok_or_else(|| unsupported(path, "Expected an array"))
}
fn string(value: &Value, path: &str) -> Result<String, Diagnostic> {
    value
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| unsupported(path, "Expected a string"))
}
fn strings(value: &Value, path: &str) -> Result<Vec<String>, Diagnostic> {
    sequence(value, path)?
        .iter()
        .map(|v| string(v, path))
        .collect()
}
fn required<'a>(map: &'a Mapping, key: &str, path: &str) -> Result<&'a Value, Diagnostic> {
    map.get(key).ok_or_else(|| {
        unsupported(
            &if path.is_empty() {
                key.into()
            } else {
                format!("{path}.{key}")
            },
            "Required upstream field is missing",
        )
    })
}
fn parse_map_strings(value: &Value, path: &str) -> Result<BTreeMap<String, String>, Diagnostic> {
    mapping(value, path)?
        .iter()
        .map(|(k, v)| {
            let key = string(k, path)?;
            let val = string(v, &format!("{path}.{key}"))?;
            Ok((key, val))
        })
        .collect()
}
fn transforms(
    value: Option<&Value>,
    path: &str,
) -> Result<BTreeMap<String, NumericTransform>, Diagnostic> {
    value
        .map(|v| parse_map_strings(v, path))
        .transpose()
        .map(|map| {
            map.unwrap_or_default()
                .into_iter()
                .map(|(name, field)| {
                    (
                        name,
                        NumericTransform {
                            field,
                            multiplier: 1.0,
                            unit: None,
                        },
                    )
                })
                .collect()
        })
}
fn platforms(value: &str, path: &str) -> Result<Vec<Platform>, Diagnostic> {
    match value {
        "cisco_ios" => Ok(vec![Platform::Ios, Platform::Iosxe]),
        _ => Err(unsupported(
            path,
            "Only upstream cisco_ios maps to the supported IOS/IOS-XE platforms",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::{config::TelemetryConfigRepository, parser::TelemetryParser};
    use std::sync::Arc;

    fn row(values: &[(&str, &str)]) -> MetricRow {
        MetricRow {
            key: "raw".into(),
            fields: values
                .iter()
                .map(|(k, v)| {
                    (
                        k.to_string(),
                        MetricValue::Text {
                            value: v.to_string(),
                        },
                    )
                })
                .collect(),
        }
    }
    fn frame(id: &str, records: Vec<MetricRow>) -> WidgetFrame {
        let catalog = Catalog::builtin().unwrap();
        frame_with_definition(&catalog.widgets[id], records)
    }
    fn frame_with_definition(
        definition: &WidgetDefinition,
        records: Vec<MetricRow>,
    ) -> WidgetFrame {
        let WidgetSource::Ssh {
            commands,
            templates,
        } = &definition.source
        else {
            panic!()
        };
        let context = FrameContext {
            workspace_id: "w".into(),
            target_id: "t".into(),
            revision: "r".into(),
            generation: 1,
        };
        let capture = Capture {
            capture_id: "c".into(),
            target_id: "t".into(),
            platform: Platform::Iosxe,
            command: commands[&Platform::Iosxe].clone(),
            parser_id: templates[&Platform::Iosxe].clone(),
            revision: "r".into(),
            observed_at_ms: 1000,
            monotonic_ms: 1000,
            raw: "offline records; not supported-empty evidence".into(),
        };
        ProtocolClassifier::normalize(&context, definition, &capture, records, None)
    }
    fn repository(root: &std::path::Path) -> TelemetryConfigRepository {
        TelemetryConfigRepository::load(
            root.into(),
            Catalog::builtin().unwrap(),
            Arc::new(TelemetryParser::new()),
        )
        .unwrap()
    }
    const IMPORT: &str = "widget: imported\ncommands: {cisco_ios: show interfaces}\ntemplates: {cisco_ios: cisco_ios_show_interfaces}\nkey: interface\nfields: {interface: [INTERFACE], packets: [INPUT_PACKETS]}\nrates: {pps: packets}\ndeltas: {change: packets}\ncomputes: {twice: pps * 2}\nview: {type: table, columns: [interface, pps, change, twice], labels: {interface: Interface}}\n";

    #[test]
    fn test_required_panel_capture_matrix() {
        let catalog = Catalog::builtin().unwrap();
        for id in [
            "version",
            "cpu",
            "memory",
            "interfaces",
            "interface_traffic",
            "interface_descriptions",
            "port_status",
            "ip_interfaces",
            "ip_interface_brief",
            "bgp_peers",
            "bgp_vrf_peers",
            "ospf_neighbors",
            "ospf_interfaces",
            "eigrp_neighbors",
            "vlans",
            "trunks",
            "stp_ports",
            "stp_roots",
            "etherchannel",
            "cdp_neighbors",
            "lldp_neighbors",
            "mac_table",
            "inventory",
            "local_cpu",
            "local_memory",
            "local_filesystems",
            "local_network",
            "local_processes",
        ] {
            assert!(catalog.widgets.contains_key(id), "{id}");
        }
        assert_eq!(
            catalog.widgets["interface_traffic"].rates["input_bit_s"].multiplier,
            8.0
        );
        assert_eq!(
            catalog.widgets["interface_traffic"].rates["input_bit_s"]
                .unit
                .as_deref(),
            Some("bit/s")
        );
        assert_eq!(
            catalog.widgets["interfaces"].fields["input_cli_bit_s"],
            vec!["input_rate", "INPUT_RATE"]
        );
        assert_eq!(
            catalog.widgets["trunks"].fields["mode"],
            vec!["mode", "MODE"]
        );
        assert!(!catalog.widgets["trunks"]
            .fields
            .contains_key("forwarding_vlans"));
        assert_eq!(
            catalog.widgets["local_processes"].key,
            vec!["pid", "start_time"]
        );
        let root = tempfile::tempdir().unwrap();
        let repo = repository(root.path());
        assert_eq!(
            repo.effective_local()
                .layouts
                .iter()
                .map(|l| l.layout.as_str())
                .collect::<Vec<_>>(),
            vec!["local_pc"]
        );
        assert!(repo
            .effective_local()
            .layouts
            .iter()
            .all(|l| l.platforms.is_empty()));
    }
    #[test]
    fn protocol_states_are_not_blanket_faults() {
        let normal_stp = frame(
            "stp_ports",
            vec![row(&[
                ("vlan_id", "1"),
                ("interface", "Gi1"),
                ("role", "Altn"),
                ("status", "BLK"),
            ])],
        );
        assert_ne!(normal_stp.severity, ObservationSeverity::Alert);
        assert_eq!(normal_stp.state, CollectionState::Fresh);
        let two_way = frame(
            "ospf_neighbors",
            vec![row(&[
                ("neighbor_id", "192.0.2.1"),
                ("ip_address", "192.0.2.2"),
                ("interface", "Gi1"),
                ("state", "2WAY/DROTHER"),
            ])],
        );
        assert_ne!(two_way.severity, ObservationSeverity::Alert);
        assert!(two_way
            .diagnostics
            .iter()
            .any(|d| d.code == "ospf_context_missing"));
        for (token, state, prefix) in [
            ("0", "Established", Some("0")),
            ("120", "Established", Some("120")),
            ("Idle", "Idle", None),
        ] {
            let bgp = frame(
                "bgp_peers",
                vec![row(&[
                    ("router_id", "192.0.2.254"),
                    ("local_as", "65000"),
                    ("address_family", "IPv4 Unicast"),
                    ("bgp_neighbor", "192.0.2.1"),
                    ("state_or_prefixes_received", token),
                ])],
            );
            assert_eq!(
                bgp.rows[0].fields["state"],
                MetricValue::Text {
                    value: state.into()
                }
            );
            assert_eq!(
                match &bgp.rows[0].fields["prefixes_received"] {
                    MetricValue::Unsigned { value } => Some(value.as_str()),
                    _ => None,
                },
                prefix
            );
        }
    }
    #[test]
    fn empty_neighbors_do_not_prove_no_configuration() {
        let empty_neighbors = frame("ospf_neighbors", vec![]);
        assert_ne!(empty_neighbors.state, CollectionState::NotConfigured);
        assert_eq!(empty_neighbors.state, CollectionState::Failed);
        assert!(empty_neighbors
            .diagnostics
            .iter()
            .any(|d| d.code == "parse_mismatch"));
    }
    #[test]
    fn vrf_identity_missing_capacity_and_parser_misses_are_visible() {
        let peers = frame(
            "bgp_vrf_peers",
            vec![
                row(&[
                    ("vrf", "Client_A"),
                    ("neighbor", "10.0.6.1"),
                    ("bgp_state", "Established"),
                ]),
                row(&[
                    ("vrf", "Client_B"),
                    ("neighbor", "10.0.6.1"),
                    ("bgp_state", "Established"),
                ]),
            ],
        );
        assert_eq!(peers.rows.len(), 2);
        assert_ne!(peers.rows[0].key, peers.rows[1].key);
        assert!(peers
            .diagnostics
            .iter()
            .any(|d| d.code == "routing_context_missing"));
        let traffic = frame(
            "interface_traffic",
            vec![row(&[
                ("interface", "Gi1"),
                ("input_bytes", "48614"),
                ("output_bytes", "62737"),
            ])],
        );
        assert!(matches!(
            traffic.rows[0].fields["input_util_percent"],
            MetricValue::Missing { .. }
        ));
        assert!(traffic
            .diagnostics
            .iter()
            .any(|d| d.code == "interface_capacity_missing"));
        let invalid = frame(
            "bgp_vrf_peers",
            vec![row(&[
                ("vrf", ""),
                ("neighbor", ""),
                ("bgp_state", "Established"),
            ])],
        );
        assert_eq!(invalid.state, CollectionState::Failed);
    }
    #[test]
    fn upstream_unsupported_behavior_is_not_silently_dropped() {
        let root = tempfile::tempdir().unwrap();
        let repo = repository(root.path());
        let importer = UpstreamWidgetImporter::new(&repo, ConfigScope::Profile(Platform::Iosxe));
        let input = format!("{IMPORT}requires: [uname -a]\n");
        let unsupported_import = importer.import(&input);
        assert!(unsupported_import
            .diagnostics
            .iter()
            .any(|d| d.path.contains("requires")));
        let draft = unsupported_import.draft.unwrap();
        assert!(draft.widgets_yaml.starts_with(&input));
        assert!(!repo.validate(&draft).valid);
        for suffix in [
            "drop: []",
            "unique: true",
            "monitor: interface",
            "scope: local",
            "expected_revision: fake",
            "parser: py:exec(1)",
            "unknown: true",
        ] {
            let result = importer.import(&format!("{IMPORT}{suffix}\n"));
            assert!(!result.diagnostics.is_empty(), "{suffix}");
            assert!(!repo.validate(&result.draft.unwrap()).valid);
        }
    }
    #[test]
    fn upstream_supported_subset_keeps_scope_revision_and_semantics() {
        let root = tempfile::tempdir().unwrap();
        let repo = repository(root.path());
        let result = UpstreamWidgetImporter::new(&repo, ConfigScope::Profile(Platform::Iosxe))
            .import(IMPORT);
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
        let draft = result.draft.unwrap();
        assert_eq!(draft.scope, ConfigScope::Profile(Platform::Iosxe));
        assert_eq!(draft.expected_revision, repo.base_revision());
        assert!(repo.validate(&draft).valid);
        let widgets: WidgetDocument = serde_yaml::from_str(&draft.widgets_yaml).unwrap();
        let widget = &widgets.widgets[0];
        assert_eq!(
            widget.fields["packets"],
            vec!["input_packets", "INPUT_PACKETS"]
        );
        assert_eq!(widget.rates["pps"].field, "packets");
        assert_eq!(widget.deltas["change"].multiplier, 1.0);
        assert_eq!(widget.computes["twice"], "pps * 2");
        assert_eq!(repo.effective_local().widgets.len(), 5);
    }
    #[test]
    fn upstream_safe_yaml_platform_templates_views_and_layout_paths() {
        let root = tempfile::tempdir().unwrap();
        let repo = repository(root.path());
        let importer = UpstreamWidgetImporter::new(&repo, ConfigScope::Profile(Platform::Ios));
        for input in [
            IMPORT.replace("cisco_ios: show interfaces", "cisco_nxos: show interfaces"),
            IMPORT.replace("cisco_ios_show_interfaces", "missing"),
            IMPORT.replace("type: table", "type: qt"),
            IMPORT.replace("key: interface", "key: &x interface"),
            format!("{IMPORT}widget: duplicate\n"),
            IMPORT.replace("twice: pps * 2", "twice: __import__('os')"),
        ] {
            assert!(!importer.import(&input).diagnostics.is_empty(), "{input}");
        }
        let layout=importer.import("layout: imported_layout\nplatforms: [cisco_ios]\nrows: [[version, {name: cpu, span: 2}]]\n");
        assert!(layout.diagnostics.is_empty(), "{:?}", layout.diagnostics);
        let draft = layout.draft.unwrap();
        let doc: LayoutDocument = serde_yaml::from_str(&draft.layouts_yaml).unwrap();
        assert_eq!(
            doc.layouts[0].sections[0].rows[0]
                .iter()
                .map(|x| x.span)
                .collect::<Vec<_>>(),
            vec![4, 8]
        );
        let unsupported = importer.import(
            "layout: x\nplatforms: [cisco_ios]\nterminal: {position: left}\nrows: [[version]]\n",
        );
        assert!(unsupported.diagnostics.iter().any(|d| d.path == "terminal"));
        let unknown = UpstreamWidgetImporter::new(&repo, ConfigScope::Device("unknown".into()))
            .import(IMPORT);
        assert!(unknown.draft.is_none());
    }
    #[tokio::test]
    async fn public_capture_matrix_uses_actual_worker_and_shared_normalizer() {
        let catalog = Catalog::builtin().unwrap();
        let parser = TelemetryParser::new();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("sidecar/tests/telemetry/fixtures");
        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("manifest.json")).unwrap())
                .unwrap();
        let metadata: serde_json::Value =
            serde_json::from_str(include_str!("../../telemetry/catalog.json")).unwrap();
        for widget in catalog
            .widgets
            .values()
            .filter(|w| matches!(w.source, WidgetSource::Ssh { .. }))
        {
            let WidgetSource::Ssh {
                commands,
                templates,
            } = &widget.source
            else {
                unreachable!()
            };
            let asset = &catalog.templates[&templates[&Platform::Iosxe]];
            let path = metadata["templates"]
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["id"] == asset.id)
                .unwrap()["path"]
                .as_str()
                .unwrap();
            let sample = manifest["samples"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["template"] == path.strip_prefix("templates/").unwrap())
                .unwrap();
            let context = FrameContext {
                workspace_id: "w".into(),
                target_id: "t".into(),
                revision: "r".into(),
                generation: 1,
            };
            let capture = Capture {
                capture_id: "c".into(),
                target_id: "t".into(),
                platform: Platform::Iosxe,
                command: commands[&Platform::Iosxe].clone(),
                parser_id: asset.id.clone(),
                revision: "r".into(),
                observed_at_ms: 1000,
                monotonic_ms: 1000,
                raw: std::fs::read_to_string(root.join(sample["file"].as_str().unwrap())).unwrap(),
            };
            let records = parser
                .parse(&capture, asset, tokio_util::sync::CancellationToken::new())
                .await
                .unwrap();
            let observed = ProtocolClassifier::normalize(&context, widget, &capture, records, None);
            if widget.widget == "bgp_vrf_peers" || widget.widget == "inventory" {
                assert_eq!(observed.state, CollectionState::Failed);
                let code = if widget.widget == "inventory" {
                    "duplicate_key"
                } else {
                    "missing_key"
                };
                assert!(observed.diagnostics.iter().any(|d| d.code == code));
            } else {
                assert_eq!(
                    observed.state,
                    CollectionState::Fresh,
                    "{}: {:?}",
                    widget.widget,
                    observed.diagnostics
                );
                assert!(!observed.rows.is_empty(), "{}", widget.widget);
            }
            if matches!(widget.widget.as_str(), "interfaces" | "interface_traffic") {
                let mut full = capture.clone();
                full.raw = std::fs::read_to_string(root.join("interfaces.raw")).unwrap();
                let records = parser
                    .parse(&full, asset, tokio_util::sync::CancellationToken::new())
                    .await
                    .unwrap();
                let duplicate =
                    ProtocolClassifier::normalize(&context, widget, &full, records, None);
                assert_eq!(duplicate.state, CollectionState::Failed);
                assert!(duplicate
                    .diagnostics
                    .iter()
                    .any(|d| d.code == "duplicate_key"));
            }
            if widget.widget == "bgp_peers" {
                let mut wrapped = capture.clone();
                wrapped.raw =
                    include_str!("../../../sidecar/tests/fixtures/show_ip_bgp_summary_iosxe.txt")
                        .into();
                let records = parser
                    .parse(&wrapped, asset, tokio_util::sync::CancellationToken::new())
                    .await
                    .unwrap();
                assert!(records.is_empty());
                let rejected =
                    ProtocolClassifier::normalize(&context, widget, &wrapped, records, None);
                assert_eq!(rejected.state, CollectionState::Failed);
                assert!(rejected
                    .diagnostics
                    .iter()
                    .any(|d| d.code == "parse_mismatch"));
            }
            if widget.widget == "trunks" {
                assert!(observed
                    .rows
                    .iter()
                    .any(|r| text(r, "mode") == "static access"));
                assert!(observed
                    .diagnostics
                    .iter()
                    .any(|d| d.code == "trunk_sets_unavailable"));
            }
            if widget.widget == "etherchannel" {
                assert!(text(&observed.rows[0], "members").starts_with('['));
            }
        }
        parser.shutdown().await.unwrap();
    }
    #[test]
    fn upstream_native_envelopes_and_unsafe_yaml_cannot_bypass_blocking() {
        let root = tempfile::tempdir().unwrap();
        let repo = repository(root.path());
        let before = repo.base_revision();
        let importer = UpstreamWidgetImporter::new(&repo, ConfigScope::Profile(Platform::Ios));
        for input in [
            "schema_version: 1\nwidgets: []\n".into(),
            format!("{IMPORT}requires: []\n"),
            IMPORT.replace("key: interface", "key: !custom interface"),
            IMPORT.replace("key: interface", "key: *unknown"),
            format!("{IMPORT}---\nwidget: x\n"),
        ] {
            let report = importer.import(&input);
            assert!(!report.diagnostics.is_empty());
            let draft = report.draft.unwrap();
            assert!(draft.widgets_yaml.starts_with(&input));
            assert!(!repo.validate(&draft).valid);
        }
        assert!(importer
            .import(&"x".repeat(MAX_YAML_BYTES + 1))
            .draft
            .is_none());
        assert_eq!(repo.base_revision(), before);
    }
    #[test]
    fn numeric_import_alerts_and_unsupported_view_semantics_have_precise_paths() {
        let root = tempfile::tempdir().unwrap();
        let repo = repository(root.path());
        let importer = UpstreamWidgetImporter::new(&repo, ConfigScope::Profile(Platform::Ios));
        let accepted=IMPORT.replace("labels: {interface: Interface}","labels: {interface: Interface}, alerts: [{field: pps, op: gt, value: 12, style: warn}]");
        let report = importer.import(&accepted);
        assert!(report
            .diagnostics
            .iter()
            .any(|d| d.path == "view.alerts[0]"));
        let draft = report.draft.unwrap();
        assert!(draft.widgets_yaml.starts_with(&accepted));
        assert!(!repo.validate(&draft).valid);
        for (extra, path) in [
            ("sort: interface", "view.sort"),
            ("limit: 12", "view.limit"),
            ("cells: {}", "view.cells"),
            (
                "alerts: [{field: pps, op: match, value: '^up', style: alert}]",
                "view.alerts[0]",
            ),
        ] {
            let input = IMPORT.replace(
                "labels: {interface: Interface}",
                &format!("labels: {{interface: Interface}}, {extra}"),
            );
            let report = importer.import(&input);
            assert!(
                report.diagnostics.iter().any(|d| d.path == path),
                "{:?}",
                report.diagnostics
            );
        }
        let unit_compute = IMPORT.replace("twice: pps * 2", "twice: interface * 2");
        assert!(importer
            .import(&unit_compute)
            .diagnostics
            .iter()
            .any(|d| d.path == "computes.twice"));
        let fractional=importer.import("layout: l\nplatforms: [cisco_ios]\nrows: [[version, cpu, memory, inventory, interfaces]]\n");
        assert!(fractional.diagnostics.iter().any(|d| d.path == "rows[0]"));
    }
    #[test]
    fn byte_rates_capacity_and_cli_rejection_keep_truthful_units_and_gaps() {
        let catalog = Catalog::builtin().unwrap();
        let def = &catalog.widgets["interface_traffic"];
        let WidgetSource::Ssh {
            commands,
            templates,
        } = &def.source
        else {
            panic!()
        };
        let context = FrameContext {
            workspace_id: "w".into(),
            target_id: "t".into(),
            revision: "r".into(),
            generation: 1,
        };
        let mut capture = Capture {
            capture_id: "c".into(),
            target_id: "t".into(),
            platform: Platform::Iosxe,
            command: commands[&Platform::Iosxe].clone(),
            parser_id: templates[&Platform::Iosxe].clone(),
            revision: "r".into(),
            observed_at_ms: 1000,
            monotonic_ms: 1000,
            raw: "source-grounded byte counters".into(),
        };
        let rows = |bytes: &str| {
            vec![row(&[
                ("interface", "Gi1"),
                ("input_bytes", bytes),
                ("output_bytes", bytes),
                ("capacity_kbit_s", "1000"),
            ])]
        };
        let first = ProtocolClassifier::normalize(&context, def, &capture, rows("1000"), None);
        capture.monotonic_ms = 2000;
        capture.observed_at_ms = 2000;
        let second = ProtocolClassifier::normalize(
            &context,
            def,
            &capture,
            rows("2000"),
            Some((&first.rows, 1000)),
        );
        assert_eq!(
            second.rows[0].fields["input_bit_s"],
            MetricValue::Number { value: 8000.0 }
        );
        assert_eq!(
            second.rows[0].fields["input_util_percent"],
            MetricValue::Number { value: 0.8 }
        );
        assert_eq!(second.units["input_bit_s"], "bit/s");
        let reset = ProtocolClassifier::normalize(
            &context,
            def,
            &capture,
            rows("0"),
            Some((&first.rows, 1000)),
        );
        assert!(
            matches!(&reset.rows[0].fields["input_bit_s"],MetricValue::Missing{reason} if reason=="counter_reset")
        );
        for (raw, state, code) in [
            (
                "% Invalid input detected at '^' marker.",
                CollectionState::Unsupported,
                "command_unsupported",
            ),
            (
                "Command authorization failed.",
                CollectionState::Failed,
                "command_permission",
            ),
        ] {
            capture.raw = raw.into();
            let frame = ProtocolClassifier::normalize(&context, def, &capture, vec![], None);
            assert_eq!(frame.state, state);
            assert!(frame.diagnostics.iter().any(|d| d.code == code));
            assert_eq!(frame.last_success_at_ms, None);
        }
    }
    #[test]
    fn explicit_first_matching_yaml_alert_takes_precedence_over_protocol_default() {
        let catalog = Catalog::builtin().unwrap();
        let mut definition = catalog.widgets["bgp_peers"].clone();
        definition.alerts = vec![
            AlertPredicate {
                field: "state".into(),
                op: PredicateOp::Eq,
                value: ThresholdValue::Text("Idle".into()),
                severity: ObservationSeverity::Ok,
                message: "Expected maintenance".into(),
            },
            AlertPredicate {
                field: "state".into(),
                op: PredicateOp::Eq,
                value: ThresholdValue::Text("Idle".into()),
                severity: ObservationSeverity::Alert,
                message: "Later must not win".into(),
            },
        ];
        let WidgetSource::Ssh {
            commands,
            templates,
        } = &definition.source
        else {
            panic!()
        };
        let context = FrameContext {
            workspace_id: "w".into(),
            target_id: "t".into(),
            revision: "r".into(),
            generation: 1,
        };
        let capture = Capture {
            capture_id: "c".into(),
            target_id: "t".into(),
            platform: Platform::Iosxe,
            command: commands[&Platform::Iosxe].clone(),
            parser_id: templates[&Platform::Iosxe].clone(),
            revision: "r".into(),
            observed_at_ms: 1000,
            monotonic_ms: 1000,
            raw: "offline classification policy input".into(),
        };
        let record = row(&[
            ("router_id", "192.0.2.254"),
            ("local_as", "65000"),
            ("address_family", "IPv4 Unicast"),
            ("bgp_neighbor", "192.0.2.1"),
            ("state_or_prefixes_received", "Idle"),
        ]);
        let classified =
            ProtocolClassifier::normalize(&context, &definition, &capture, vec![record], None);
        assert_eq!(classified.severity, ObservationSeverity::Ok);
    }
    #[test]
    fn alert_predicates_observe_the_canonical_protocol_fields_shown_to_the_user() {
        let catalog = Catalog::builtin().unwrap();
        let mut definition = catalog.widgets["bgp_peers"].clone();
        definition.alerts = vec![AlertPredicate {
            field: "state".into(),
            op: PredicateOp::Eq,
            value: ThresholdValue::Text("Established".into()),
            severity: ObservationSeverity::Alert,
            message: "Explicit user predicate".into(),
        }];
        let WidgetSource::Ssh {
            commands,
            templates,
        } = &definition.source
        else {
            panic!()
        };
        let context = FrameContext {
            workspace_id: "w".into(),
            target_id: "t".into(),
            revision: "r".into(),
            generation: 1,
        };
        let capture = Capture {
            capture_id: "c".into(),
            target_id: "t".into(),
            platform: Platform::Iosxe,
            command: commands[&Platform::Iosxe].clone(),
            parser_id: templates[&Platform::Iosxe].clone(),
            revision: "r".into(),
            observed_at_ms: 1000,
            monotonic_ms: 1000,
            raw: "offline numeric prefix token".into(),
        };
        let record = row(&[
            ("router_id", "192.0.2.254"),
            ("local_as", "65000"),
            ("address_family", "IPv4 Unicast"),
            ("bgp_neighbor", "192.0.2.1"),
            ("state_or_prefixes_received", "7"),
        ]);
        let classified =
            ProtocolClassifier::normalize(&context, &definition, &capture, vec![record], None);
        let matched = definition.first_alert(&classified.rows[0].fields).unwrap();
        assert_eq!(classified.severity, matched.severity);
    }
    #[test]
    fn canonical_protocol_keys_agree_with_displayed_fields_and_survive_prefix_changes() {
        let catalog = Catalog::builtin().unwrap();
        let mut definition = catalog.widgets["bgp_peers"].clone();
        definition.key = vec!["neighbor".into(), "state".into()];
        let records = |prefix: &str| {
            vec![row(&[
                ("router_id", "192.0.2.254"),
                ("local_as", "65000"),
                ("address_family", "IPv4 Unicast"),
                ("bgp_neighbor", "192.0.2.1"),
                ("state_or_prefixes_received", prefix),
            ])]
        };
        let first = frame_with_definition(&definition, records("7"));
        let next = frame_with_definition(&definition, records("5"));
        assert_eq!(
            first.rows[0].key,
            MetricRow::from_fields(first.rows[0].fields.clone(), &definition.key)
                .unwrap()
                .key
        );
        assert_eq!(first.rows[0].key, next.rows[0].key);
    }
    #[test]
    fn canonical_protocol_compute_inputs_do_not_retain_superseded_prefix_tokens() {
        let catalog = Catalog::builtin().unwrap();
        let mut definition = catalog.widgets["bgp_peers"].clone();
        definition
            .computes
            .insert("state_number".into(), "state * 2".into());
        definition
            .computes
            .insert("prefix_plus_one".into(), "prefixes_received + 1".into());
        let observed = frame_with_definition(
            &definition,
            vec![row(&[
                ("router_id", "192.0.2.254"),
                ("local_as", "65000"),
                ("address_family", "IPv4 Unicast"),
                ("bgp_neighbor", "192.0.2.1"),
                ("state_or_prefixes_received", "7"),
            ])],
        );
        assert!(matches!(
            observed.rows[0].fields["state_number"],
            MetricValue::Missing { .. }
        ));
        assert_eq!(
            observed.rows[0].fields["prefix_plus_one"],
            MetricValue::Number { value: 8.0 }
        );
    }
    #[test]
    fn protocol_classification_preserves_failed_limits_and_edited_source_meanings() {
        let catalog = Catalog::builtin().unwrap();
        let mut definition = catalog.widgets["bgp_peers"].clone();
        definition.fields.insert(
            "state".into(),
            vec!["neighbor_as".into(), "NEIGHBOR_AS".into()],
        );
        let observed = frame_with_definition(
            &definition,
            vec![row(&[
                ("router_id", "192.0.2.254"),
                ("local_as", "65000"),
                ("address_family", "IPv4 Unicast"),
                ("bgp_neighbor", "192.0.2.1"),
                ("neighbor_as", "65001"),
                ("state_or_prefixes_received", "7"),
            ])],
        );
        assert_eq!(
            observed.rows[0].fields["state"],
            MetricValue::Text {
                value: "65001".into()
            }
        );
        assert!(observed
            .diagnostics
            .iter()
            .any(|d| d.code == "classification_binding"));
        let mut failed = observed;
        failed.state = CollectionState::Failed;
        failed.diagnostics = vec![Diagnostic::new("normalization_limit", "Limited", "test")];
        let before = failed.clone();
        let capture = Capture {
            capture_id: "unused".into(),
            target_id: "t".into(),
            platform: Platform::Iosxe,
            command: "show ip bgp summary".into(),
            parser_id: "iosxe.show_ip_bgp_summary".into(),
            revision: "r".into(),
            observed_at_ms: 1000,
            monotonic_ms: 1000,
            raw: String::new(),
        };
        ProtocolClassifier::classify(&mut failed, &definition, &capture);
        assert_eq!(failed, before);
        let records = || {
            vec![row(&[
                ("router_id", "192.0.2.254"),
                ("local_as", "65000"),
                ("address_family", "IPv4 Unicast"),
                ("bgp_neighbor", "192.0.2.1"),
                ("neighbor_as", "65001"),
                ("state_or_prefixes_received", "7"),
            ])]
        };
        let mut platform_specific = catalog.widgets["bgp_peers"].clone();
        if let WidgetSource::Ssh {
            commands,
            templates,
        } = &mut platform_specific.source
        {
            commands.insert(Platform::Ios, "show version".into());
            templates.insert(Platform::Ios, "ios.show_version".into());
        }
        let selected = frame_with_definition(&platform_specific, records());
        assert_eq!(
            selected.rows[0].fields["state"],
            MetricValue::Text {
                value: "Established".into()
            }
        );
        // Only the actually selected parser alias receives canonical protocol meaning.
        definition.fields.insert(
            "state".into(),
            vec!["neighbor_as".into(), "state_or_prefixes_received".into()],
        );
        assert_eq!(
            frame_with_definition(&definition, records()).rows[0].fields["state"],
            MetricValue::Text {
                value: "65001".into()
            }
        );
        let mut local = catalog.widgets["bgp_peers"].clone();
        local.source = WidgetSource::Local {
            collector: LocalCollector::Cpu,
        };
        let local_sample = LocalSample {
            observed_at_ms: 1000,
            monotonic_ms: 1000,
            sources: BTreeMap::from([("local.cpu".into(), records())]),
            diagnostics: vec![],
        };
        let local_context = FrameContext {
            workspace_id: "w".into(),
            target_id: "local".into(),
            revision: "r".into(),
            generation: 1,
        };
        let local_frame = FrameNormalizer::local(&local_context, &local, &local_sample, None);
        assert_eq!(
            local_frame.rows[0].fields["state"],
            MetricValue::Text { value: "7".into() }
        );
        let network_context = FrameContext {
            target_id: "t".into(),
            ..local_context
        };
        let limited = ProtocolClassifier::normalize_bounded(
            &network_context,
            &catalog.widgets["bgp_peers"],
            &capture,
            records(),
            None,
            1,
        );
        assert_eq!(limited.state, CollectionState::Failed);
        assert!(limited
            .diagnostics
            .iter()
            .any(|d| d.code == "normalization_limit"));
    }
    #[tokio::test]
    async fn explicit_documented_rejections_are_classified_before_real_textfsm_errors() {
        let catalog = Catalog::builtin().unwrap();
        let asset = &catalog.templates["iosxe.show_processes_cpu"];
        let parser = TelemetryParser::new();
        for (raw, state, code) in [
            (
                "% Invalid input detected at '^' marker.\nREJECTED_RAW_PRIVATE_MARKER",
                CollectionState::Unsupported,
                "command_unsupported",
            ),
            (
                "Command authorization failed.\nREJECTED_RAW_PRIVATE_MARKER",
                CollectionState::Failed,
                "command_permission",
            ),
        ] {
            let capture = Capture {
                capture_id: "rejected".into(),
                target_id: "t".into(),
                platform: Platform::Iosxe,
                command: asset.command.clone(),
                parser_id: asset.id.clone(),
                revision: "r".into(),
                observed_at_ms: 1000,
                monotonic_ms: 1000,
                raw: raw.into(),
            };
            let parser_error = parser
                .parse(&capture, asset, tokio_util::sync::CancellationToken::new())
                .await
                .unwrap_err();
            assert_eq!(parser_error.code, "parser_template");
            let (observed, diagnostic) = ProtocolClassifier::capture_rejection(&capture).unwrap();
            assert_eq!(observed, state);
            assert_eq!(diagnostic.code, code);
            assert!(!serde_json::to_string(&diagnostic)
                .unwrap()
                .contains("PRIVATE_MARKER"));
        }
        parser.shutdown().await.unwrap();
    }
    #[test]
    fn fix1_numeric_ne_import_is_blocked_for_numeric_text_and_missing_inputs() {
        // Pinned upstream ne falls back to string inequality for nonnumeric/missing input.
        let predicate = AlertPredicate {
            field: "value".into(),
            op: PredicateOp::Ne,
            value: ThresholdValue::Number(0.0),
            severity: ObservationSeverity::Warn,
            message: "Native semantics are unchanged".into(),
        };
        for (value, native_matches, upstream_matches) in [
            (MetricValue::Number { value: 1.0 }, true, true),
            (MetricValue::Number { value: 0.0 }, false, false),
            (MetricValue::Text { value: "1".into() }, true, true),
            (
                MetricValue::Text {
                    value: "notconnect".into(),
                },
                false,
                true,
            ),
            (
                MetricValue::Missing {
                    reason: "field_missing".into(),
                },
                false,
                true,
            ),
        ] {
            assert_eq!(predicate.matches(&value), native_matches);
            if matches!(value, MetricValue::Missing { .. })
                || matches!(&value,MetricValue::Text{value} if value=="notconnect")
            {
                assert!(upstream_matches && !native_matches);
            }
        }
        let root = tempfile::tempdir().unwrap();
        let repo = repository(root.path());
        let input="widget: status_rule\ncommands: {cisco_ios: show interfaces status}\nkey: interface\nfields: {interface: [PORT], value: [STATUS]}\nview: {type: table, columns: [interface, value], alerts: [{field: value, op: ne, value: 0, style: warn}]}\n";
        let report =
            UpstreamWidgetImporter::new(&repo, ConfigScope::Profile(Platform::Iosxe)).import(input);
        assert!(
            report
                .diagnostics
                .iter()
                .any(|d| d.path == "view.alerts[0]"),
            "{:?}",
            report.diagnostics
        );
        let draft = report.draft.unwrap();
        assert!(draft.widgets_yaml.starts_with(input));
        assert!(!repo.validate(&draft).valid);
    }
    #[test]
    fn fix1_all_nonempty_upstream_alerts_are_blocked_while_native_predicates_remain_exact() {
        let root = tempfile::tempdir().unwrap();
        let repo = repository(root.path());
        let importer = UpstreamWidgetImporter::new(&repo, ConfigScope::Profile(Platform::Iosxe));
        for (op, threshold, numeric, expected) in [
            ("eq", 1, 1.0, true),
            ("eq", 1, 2.0, false),
            ("gt", 0, 1.0, true),
            ("gt", 1, 1.0, false),
            ("ge", 1, 1.0, true),
            ("ge", 2, 1.0, false),
            ("lt", 2, 1.0, true),
            ("lt", 1, 1.0, false),
            ("le", 1, 1.0, true),
            ("le", 0, 1.0, false),
        ] {
            let input=format!("widget: supported_rule\ncommands: {{cisco_ios: show interfaces status}}\nkey: interface\nfields: {{interface: [PORT], value: [STATUS]}}\nview: {{type: table, columns: [interface, value], alerts: [{{field: value, op: {op}, value: {threshold}, style: warn}}]}}\n");
            let report = importer.import(&input);
            assert!(
                report
                    .diagnostics
                    .iter()
                    .any(|d| d.path == "view.alerts[0]"),
                "{op}: {:?}",
                report.diagnostics
            );
            let draft = report.draft.unwrap();
            assert!(draft.widgets_yaml.starts_with(&input));
            assert!(!repo.validate(&draft).valid);
            let alert = AlertPredicate {
                field: "value".into(),
                op: match op {
                    "eq" => PredicateOp::Eq,
                    "gt" => PredicateOp::Gt,
                    "ge" => PredicateOp::Ge,
                    "lt" => PredicateOp::Lt,
                    "le" => PredicateOp::Le,
                    _ => unreachable!(),
                },
                value: ThresholdValue::Number(threshold as f64),
                severity: ObservationSeverity::Warn,
                message: "Native behavior is unchanged".into(),
            };
            assert_eq!(
                alert.matches(&MetricValue::Number { value: numeric }),
                expected,
                "{op}"
            );
            assert_eq!(
                alert.matches(&MetricValue::Text {
                    value: numeric.to_string()
                }),
                expected,
                "{op}"
            );
            assert!(
                !alert.matches(&MetricValue::Text {
                    value: "notconnect".into()
                }),
                "{op}"
            );
            assert!(
                !alert.matches(&MetricValue::Missing {
                    reason: "field_missing".into()
                }),
                "{op}"
            );
        }
        let threshold = 9007199254740992.0;
        let large = "9007199254740993";
        let exact = AlertPredicate {
            field: "counter".into(),
            op: PredicateOp::Eq,
            value: ThresholdValue::Number(threshold),
            severity: ObservationSeverity::Warn,
            message: "Exact native u64".into(),
        };
        assert!(!exact.matches(&MetricValue::Unsigned {
            value: large.into()
        }));
        assert_eq!(large.parse::<f64>().unwrap(), threshold); // Pinned upstream converts both operands to float.
        let numeric = AlertPredicate {
            op: PredicateOp::Gt,
            value: ThresholdValue::Number(500.0),
            ..exact
        };
        for text in ["1,000", " 1000 "] {
            assert!(!numeric.matches(&MetricValue::Text { value: text.into() }));
            assert!(text.trim().replace(',', "").parse::<f64>().unwrap() > 500.0);
        }
        for input in [
            IMPORT.to_string(),
            IMPORT.replace(
                "labels: {interface: Interface}",
                "labels: {interface: Interface}, alerts: []",
            ),
        ] {
            let report = importer.import(&input);
            assert!(report.diagnostics.is_empty(), "{:?}", report.diagnostics);
            let draft = report.draft.unwrap();
            assert!(repo.validate(&draft).valid);
            let parsed: WidgetDocument = serde_yaml::from_str(&draft.widgets_yaml).unwrap();
            assert!(parsed.widgets[0].alerts.is_empty());
        }
    }
    #[test]
    fn fix1_upstream_bgp_canonical_mappings_are_blocked_for_all_widget_ids() {
        let root = tempfile::tempdir().unwrap();
        let repo = repository(root.path());
        let importer = UpstreamWidgetImporter::new(&repo, ConfigScope::Profile(Platform::Iosxe));
        for id in ["bgp_peers", "copied_bgp", "unrelated_id"] {
            for field in ["state", "prefixes_received"] {
                for aliases in [
                    "[STATE_OR_PREFIXES_RECEIVED]",
                    "[NEIGHBOR_AS, state_or_prefixes_received]",
                ] {
                    let input=format!("widget: {id}\ncommands: {{cisco_ios: show ip bgp summary}}\ntemplates: {{cisco_ios: cisco_ios_show_ip_bgp_summary}}\nkey: neighbor\nfields: {{neighbor: [BGP_NEIGHBOR], {field}: {aliases}}}\nview: {{type: table, columns: [neighbor, {field}]}}\n");
                    let report = importer.import(&input);
                    assert!(
                        report
                            .diagnostics
                            .iter()
                            .any(|d| d.path == format!("fields.{field}")),
                        "{id}/{field}: {:?}",
                        report.diagnostics
                    );
                    let draft = report.draft.unwrap();
                    assert!(draft.widgets_yaml.starts_with(&input));
                    assert!(!repo.validate(&draft).valid);
                }
            }
            let raw=format!("widget: {id}\ncommands: {{cisco_ios: show ip bgp summary}}\nkey: neighbor\nfields: {{neighbor: [BGP_NEIGHBOR], raw_state: [STATE_OR_PREFIXES_RECEIVED]}}\nview: {{type: table, columns: [neighbor, raw_state]}}\n");
            assert!(importer.import(&raw).diagnostics.is_empty());
            let custom = raw
                .replace(
                    "raw_state: [STATE_OR_PREFIXES_RECEIVED]",
                    "state: [NEIGHBOR_AS]",
                )
                .replace("neighbor, raw_state", "neighbor, state");
            assert!(importer.import(&custom).diagnostics.is_empty());
        }
    }
    #[tokio::test]
    async fn fix1_real_parser_native_copies_and_renames_preserve_canonical_finalization() {
        let catalog = Catalog::builtin().unwrap();
        let parser = TelemetryParser::new();
        let asset = &catalog.templates["iosxe.show_ip_bgp_summary"];
        let original = include_str!("../../../sidecar/tests/telemetry/fixtures/bgp_summary.raw");
        let changed = original.replacen("00:20:06        7", "00:20:06        5", 1);
        assert_ne!(changed, original);
        let context = FrameContext {
            workspace_id: "rename".into(),
            target_id: "t".into(),
            revision: "r".into(),
            generation: 1,
        };
        let mut definition = catalog.widgets["bgp_peers"].clone();
        definition.key = vec!["neighbor".into(), "state".into()];
        definition.computes = BTreeMap::from([
            ("state_number".into(), "state * 2".into()),
            ("prefix_plus_one".into(), "prefixes_received + 1".into()),
        ]);
        definition.alerts = vec![
            AlertPredicate {
                field: "state".into(),
                op: PredicateOp::Eq,
                value: ThresholdValue::Text("Established".into()),
                severity: ObservationSeverity::Alert,
                message: "First canonical match".into(),
            },
            AlertPredicate {
                field: "state".into(),
                op: PredicateOp::Eq,
                value: ThresholdValue::Text("Established".into()),
                severity: ObservationSeverity::Warn,
                message: "Later must not win".into(),
            },
        ];
        let mut canonical = None;
        for id in ["bgp_peers", "copied_bgp", "renamed_bgp"] {
            definition.widget = id.into();
            let mut frames = Vec::new();
            for (index, raw) in [original, changed.as_str()].into_iter().enumerate() {
                let capture = Capture {
                    capture_id: format!("capture{index}"),
                    target_id: "t".into(),
                    platform: Platform::Iosxe,
                    command: asset.command.clone(),
                    parser_id: asset.id.clone(),
                    revision: "r".into(),
                    observed_at_ms: 1000 + index as i64 * 1000,
                    monotonic_ms: 1000 + index as u64 * 1000,
                    raw: raw.into(),
                };
                let records = parser
                    .parse(&capture, asset, tokio_util::sync::CancellationToken::new())
                    .await
                    .unwrap();
                let observed =
                    ProtocolClassifier::normalize(&context, &definition, &capture, records, None);
                assert_eq!(observed.state, CollectionState::Fresh);
                assert_eq!(
                    observed.rows[0].fields["state"],
                    MetricValue::Text {
                        value: "Established".into()
                    },
                    "{id}"
                );
                assert_eq!(observed.severity, ObservationSeverity::Alert);
                assert!(matches!(
                    observed.rows[0].fields["state_number"],
                    MetricValue::Missing { .. }
                ));
                assert_eq!(
                    observed.rows[0].fields["prefix_plus_one"],
                    MetricValue::Number {
                        value: if index == 0 { 8.0 } else { 6.0 }
                    }
                );
                frames.push(observed);
            }
            assert_eq!(frames[0].rows[0].key, frames[1].rows[0].key);
            let values = frames
                .into_iter()
                .map(|frame| (frame.rows, frame.units, frame.severity))
                .collect::<Vec<_>>();
            if let Some(expected) = &canonical {
                assert_eq!(&values, expected, "{id}");
            } else {
                canonical = Some(values);
            }
        }
        // A different parser ID has its own declared raw contract even with the same command/headers.
        definition.widget = "bgp_peers".into();
        let mut custom = asset.clone();
        custom.id = "custom_summary".into();
        if let WidgetSource::Ssh { templates, .. } = &mut definition.source {
            templates.insert(Platform::Iosxe, custom.id.clone());
        }
        let capture = Capture {
            capture_id: "custom".into(),
            target_id: "t".into(),
            platform: Platform::Iosxe,
            command: custom.command.clone(),
            parser_id: custom.id.clone(),
            revision: "r".into(),
            observed_at_ms: 1000,
            monotonic_ms: 1000,
            raw: original.into(),
        };
        let records = parser
            .parse(
                &capture,
                &custom,
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .unwrap();
        let observed =
            ProtocolClassifier::normalize(&context, &definition, &capture, records, None);
        assert_eq!(
            observed.rows[0].fields["state"],
            MetricValue::Text { value: "7".into() }
        );
        parser.shutdown().await.unwrap();
    }
}
