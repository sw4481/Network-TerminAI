//! Shared telemetry wire and validated asset contracts. Counters remain decimal strings.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type TargetId = String;
pub type WorkspaceId = String;
pub type Revision = String;
pub type Generation = u64;
pub type TemplateId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Ios,
    Iosxe,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigScope {
    Local,
    Profile(Platform),
    Device(String),
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectionState {
    Stopped,
    Collecting,
    Fresh,
    Stale,
    Unsupported,
    NotConfigured,
    Failed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationSeverity {
    Info,
    Ok,
    Warn,
    Alert,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MetricValue {
    Unsigned {
        #[serde(with = "counter_wire")]
        value: String,
    },
    Number {
        #[serde(with = "finite")]
        value: f64,
    },
    Text {
        value: String,
    },
    Bool {
        value: bool,
    },
    Missing {
        reason: String,
    },
}
impl MetricValue {
    pub fn numeric(&self) -> Option<f64> {
        match self {
            Self::Number { value } if value.is_finite() => Some(*value),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
    pub path: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetRef {
    pub connection_id: String,
    pub platform: Platform,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Capture {
    pub capture_id: String,
    pub target_id: TargetId,
    pub platform: Platform,
    pub command: String,
    pub parser_id: TemplateId,
    pub revision: Revision,
    pub observed_at_ms: i64,
    pub monotonic_ms: u64,
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MetricRow {
    pub key: String,
    pub fields: BTreeMap<String, MetricValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WidgetFrame {
    pub workspace_id: WorkspaceId,
    pub target_id: TargetId,
    pub widget_id: String,
    pub revision: Revision,
    pub generation: Generation,
    pub observed_at_ms: i64,
    pub last_success_at_ms: Option<i64>,
    pub state: CollectionState,
    pub severity: ObservationSeverity,
    pub units: BTreeMap<String, String>,
    pub rows: Vec<MetricRow>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetStatus {
    pub target_id: TargetId,
    pub display_name: String,
    pub platform: Option<Platform>,
    pub state: CollectionState,
    pub last_success_at_ms: Option<i64>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WidgetSummary {
    pub workspace_id: WorkspaceId,
    pub target_id: TargetId,
    pub widget_id: String,
    pub revision: Revision,
    pub generation: Generation,
    pub observed_at_ms: i64,
    pub last_success_at_ms: Option<i64>,
    pub state: CollectionState,
    pub severity: ObservationSeverity,
    pub units: BTreeMap<String, String>,
    pub row_count: u32,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeriesSummary {
    pub target_id: TargetId,
    pub widget_id: String,
    pub row_key: String,
    pub field: String,
    pub unit: Option<String>,
    pub point_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TelemetrySnapshot {
    pub workspace_id: WorkspaceId,
    pub generation: Generation,
    pub sequence: u64,
    pub running: bool,
    pub targets: Vec<TargetStatus>,
    pub widgets: Vec<WidgetSummary>,
    pub series: Vec<SeriesSummary>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateAsset {
    pub id: TemplateId,
    pub platform: Platform,
    pub command: String,
    pub text: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectiveConfig {
    pub revision: Revision,
    pub widgets: Vec<WidgetDefinition>,
    pub layouts: Vec<LayoutDefinition>,
    pub templates: BTreeMap<TemplateId, TemplateAsset>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeriesQuery {
    pub workspace_id: WorkspaceId,
    pub target_id: TargetId,
    pub widget_id: String,
    pub row_key: String,
    pub field: String,
    pub after_ms: Option<i64>,
    pub limit: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeriesPage {
    pub points: Vec<SeriesPoint>,
    pub next_after_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeriesPoint {
    pub at_ms: i64,
    #[serde(default, with = "optional_finite")]
    pub value: Option<f64>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WidgetQuery {
    pub workspace_id: WorkspaceId,
    pub target_id: TargetId,
    pub widget_id: String,
    pub offset: u32,
    pub limit: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WidgetPage {
    pub metadata: WidgetSummary,
    pub rows: Vec<MetricRow>,
    pub next_offset: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigDraft {
    pub scope: ConfigScope,
    pub widgets_yaml: String,
    pub layouts_yaml: String,
    pub templates: BTreeMap<TemplateId, String>,
    pub expected_revision: Revision,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ValidationReport {
    pub valid: bool,
    pub draft_hash: String,
    pub diagnostics: Vec<Diagnostic>,
    pub affected_targets: Vec<TargetId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewToken {
    pub draft_hash: String,
    pub base_revision: Revision,
    pub sample_hashes: BTreeMap<String, String>,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewReport {
    pub token: Option<PreviewToken>,
    pub frames: Vec<WidgetFrame>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplyResult {
    pub revision: Revision,
    pub affected_targets: Vec<TargetId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartRequest {
    pub workspace_id: WorkspaceId,
    pub targets: Vec<TargetRef>,
    #[serde(default = "enabled")]
    pub local_enabled: bool,
    pub monitored_interfaces: BTreeMap<TargetId, Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrameContext {
    pub workspace_id: WorkspaceId,
    pub target_id: TargetId,
    pub revision: Revision,
    pub generation: Generation,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalSample {
    pub observed_at_ms: i64,
    pub monotonic_ms: u64,
    pub sources: BTreeMap<String, Vec<MetricRow>>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone)]
pub struct CaptureRequest {
    pub command: super::policy::AdmittedCommand,
    pub parser_id: TemplateId,
    pub revision: Revision,
}

impl Diagnostic {
    pub fn new(code: &str, message: impl Into<String>, path: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            path: path.into(),
            line: None,
            column: None,
        }
    }
}
impl MetricRow {
    pub fn from_fields(
        fields: BTreeMap<String, MetricValue>,
        key_fields: &[String],
    ) -> Result<Self, Diagnostic> {
        let values: Result<Vec<_>, _> = key_fields
            .iter()
            .map(|key| match fields.get(key) {
                Some(MetricValue::Missing { .. }) | None => Err(Diagnostic::new(
                    "missing_key",
                    "Composite key field is missing",
                    key,
                )),
                Some(value) => Ok(value),
            })
            .collect();
        let key = serde_json::to_string(&values?)
            .map_err(|_| Diagnostic::new("invalid_key", "Key must contain finite values", "key"))?;
        Ok(Self { key, fields })
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Catalog {
    pub widgets: BTreeMap<String, WidgetDefinition>,
    pub layouts: BTreeMap<String, LayoutDefinition>,
    pub templates: BTreeMap<TemplateId, TemplateAsset>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WidgetDocument {
    pub schema_version: u32,
    pub widgets: Vec<WidgetDefinition>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LayoutDocument {
    pub schema_version: u32,
    pub layouts: Vec<LayoutDefinition>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WidgetDefinition {
    pub widget: String,
    pub title: String,
    pub source: WidgetSource,
    pub interval: u32,
    pub key: Vec<String>,
    pub fields: BTreeMap<String, Vec<String>>,
    pub view: WidgetView,
    #[serde(default)]
    pub rates: BTreeMap<String, NumericTransform>,
    #[serde(default)]
    pub deltas: BTreeMap<String, NumericTransform>,
    #[serde(default)]
    pub computes: BTreeMap<String, String>,
    #[serde(default)]
    pub alerts: Vec<AlertPredicate>,
    #[serde(default)]
    pub history: Option<HistoryDefinition>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WidgetSource {
    Local {
        collector: LocalCollector,
    },
    Ssh {
        commands: BTreeMap<Platform, String>,
        templates: BTreeMap<Platform, TemplateId>,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LocalCollector {
    #[serde(rename = "local.cpu")]
    Cpu,
    #[serde(rename = "local.memory")]
    Memory,
    #[serde(rename = "local.filesystems")]
    Filesystems,
    #[serde(rename = "local.network")]
    Network,
    #[serde(rename = "local.processes")]
    Processes,
}
impl LocalCollector {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cpu => "local.cpu",
            Self::Memory => "local.memory",
            Self::Filesystems => "local.filesystems",
            Self::Network => "local.network",
            Self::Processes => "local.processes",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NumericTransform {
    pub field: String,
    #[serde(default = "one")]
    #[serde(with = "finite")]
    pub multiplier: f64,
    pub unit: Option<String>,
}
fn one() -> f64 {
    1.0
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryDefinition {
    pub fields: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ViewField {
    pub field: String,
    pub label: String,
    pub unit: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum WidgetView {
    Table {
        columns: Vec<ViewField>,
    },
    Kv {
        columns: Vec<ViewField>,
    },
    Stat {
        field: Option<String>,
        label: String,
        aggregation: Aggregation,
    },
    Chart {
        series: Vec<ViewField>,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Aggregation {
    First,
    Sum,
    Mean,
    Min,
    Max,
    Count,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ThresholdValue {
    Number(#[serde(with = "finite")] f64),
    Bool(bool),
    Text(String),
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PredicateOp {
    Eq,
    Ne,
    Gt,
    Ge,
    Lt,
    Le,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AlertPredicate {
    pub field: String,
    pub op: PredicateOp,
    pub value: ThresholdValue,
    pub severity: ObservationSeverity,
    pub message: String,
}
impl AlertPredicate {
    pub fn matches(&self, value: &MetricValue) -> bool {
        use std::cmp::Ordering;
        let order = match (&self.value, value) {
            (ThresholdValue::Number(a), MetricValue::Number { value: b })
                if a.is_finite() && b.is_finite() =>
            {
                b.partial_cmp(a)
            }
            (ThresholdValue::Bool(a), MetricValue::Bool { value: b }) => Some(b.cmp(a)),
            (ThresholdValue::Text(a), MetricValue::Text { value: b }) => Some(b.cmp(a)),
            _ => None,
        };
        match (self.op, order) {
            (PredicateOp::Eq, Some(Ordering::Equal))
            | (PredicateOp::Ne, Some(Ordering::Less | Ordering::Greater))
            | (PredicateOp::Gt, Some(Ordering::Greater))
            | (PredicateOp::Ge, Some(Ordering::Equal | Ordering::Greater))
            | (PredicateOp::Lt, Some(Ordering::Less))
            | (PredicateOp::Le, Some(Ordering::Equal | Ordering::Less)) => true,
            _ => false,
        }
    }
}
impl WidgetDefinition {
    pub fn first_alert(&self, fields: &BTreeMap<String, MetricValue>) -> Option<&AlertPredicate> {
        self.alerts.iter().find(|alert| {
            fields
                .get(&alert.field)
                .is_some_and(|value| alert.matches(value))
        })
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LayoutDefinition {
    pub layout: String,
    pub platforms: Vec<Platform>,
    pub sections: Vec<LayoutSection>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LayoutSection {
    pub id: String,
    pub title: String,
    pub rows: Vec<Vec<LayoutEntry>>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LayoutEntry {
    pub widget: String,
    pub span: u8,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn counter_wire_roundtrip_preserves_u64() {
        let counter = MetricValue::Unsigned {
            value: u64::MAX.to_string(),
        };
        let wire = serde_json::to_string(&counter).unwrap();
        assert!(wire.contains("\"18446744073709551615\""));
        assert_eq!(serde_json::from_str::<MetricValue>(&wire).unwrap(), counter);
    }

    #[test]
    fn numeric_wire_values_reject_nonfinite_and_invalid_counters() {
        for yaml in [
            "{kind: number, value: .nan}",
            "{kind: number, value: .inf}",
            "{kind: unsigned, value: '-1'}",
            "{kind: unsigned, value: '18446744073709551616'}",
        ] {
            assert!(serde_yaml::from_str::<MetricValue>(yaml).is_err(), "{yaml}");
        }
        assert!(serde_json::to_string(&MetricValue::Number { value: f64::NAN }).is_err());
        assert!(
            serde_json::from_str::<SeriesPoint>(r#"{"at_ms":0,"value":1e999,"reason":null}"#)
                .is_err()
        );
    }
    #[test]
    fn alert_predicates_keep_order_and_missing_gaps() {
        let alert = AlertPredicate {
            field: "usage".into(),
            op: PredicateOp::Gt,
            value: ThresholdValue::Number(80.0),
            severity: ObservationSeverity::Warn,
            message: "high".into(),
        };
        assert!(alert.matches(&MetricValue::Number { value: 81.0 }));
        assert!(!alert.matches(&MetricValue::Missing {
            reason: "gap".into()
        }));
        let mut widget: WidgetDefinition = serde_yaml::from_str("widget: cpu\ntitle: CPU\nsource: {kind: local, collector: local.cpu}\ninterval: 2\nkey: []\nfields: {usage: [usage]}\nview: {type: stat, aggregation: count, label: Count}").unwrap();
        widget.alerts = vec![
            alert.clone(),
            AlertPredicate {
                severity: ObservationSeverity::Alert,
                ..alert
            },
        ];
        assert_eq!(
            widget
                .first_alert(&BTreeMap::from([(
                    "usage".into(),
                    MetricValue::Number { value: 90.0 }
                )]))
                .unwrap()
                .severity,
            ObservationSeverity::Warn
        );
    }
    #[test]
    fn composite_key_keeps_vrf_and_interface() {
        let fields = |vrf: &str| {
            BTreeMap::from([
                (
                    "neighbor".into(),
                    MetricValue::Text {
                        value: "192.0.2.1".into(),
                    },
                ),
                ("vrf".into(), MetricValue::Text { value: vrf.into() }),
                (
                    "interface".into(),
                    MetricValue::Text {
                        value: "Gi1/0/1".into(),
                    },
                ),
            ])
        };
        let key = vec!["neighbor".into(), "vrf".into(), "interface".into()];
        let rows = [
            MetricRow::from_fields(fields("blue"), &key).unwrap(),
            MetricRow::from_fields(fields("red"), &key).unwrap(),
        ];
        assert_ne!(rows[0].key, rows[1].key);
        assert!(MetricRow::from_fields(BTreeMap::new(), &key).is_err());
    }
}

fn enabled() -> bool {
    true
}
mod finite {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
        let value = f64::deserialize(deserializer)?;
        if value.is_finite() {
            Ok(value)
        } else {
            Err(serde::de::Error::custom("Number must be finite"))
        }
    }
    pub fn serialize<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
        if value.is_finite() {
            serializer.serialize_f64(*value)
        } else {
            Err(serde::ser::Error::custom("Number must be finite"))
        }
    }
}
mod optional_finite {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<f64>, D::Error> {
        let value = Option::<f64>::deserialize(deserializer)?;
        if value.is_none_or(f64::is_finite) {
            Ok(value)
        } else {
            Err(serde::de::Error::custom("Number must be finite"))
        }
    }
    pub fn serialize<S: Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(value) => super::finite::serialize(value, serializer),
            None => serializer.serialize_none(),
        }
    }
}
mod counter_wire {
    use serde::{Deserialize, Deserializer, Serializer};
    fn valid(value: &str) -> bool {
        !value.is_empty()
            && value.bytes().all(|c| c.is_ascii_digit())
            && value.parse::<u64>().is_ok()
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
        let value = String::deserialize(deserializer)?;
        if valid(&value) {
            Ok(value)
        } else {
            Err(serde::de::Error::custom(
                "Counter must be a decimal u64 string",
            ))
        }
    }
    pub fn serialize<S: Serializer>(value: &str, serializer: S) -> Result<S::Ok, S::Error> {
        if valid(value) {
            serializer.serialize_str(value)
        } else {
            Err(serde::ser::Error::custom(
                "Counter must be a decimal u64 string",
            ))
        }
    }
}
