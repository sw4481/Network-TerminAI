//! Shared, stateless preview/live evaluation. The caller owns prior samples.
use super::{definition::ArithmeticExpression, model::*};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_FRAME_ROWS: usize = 10_000;
pub const MAX_WORKSPACE_BYTES: usize = 64 * 1024 * 1024;
pub struct FrameNormalizer;

impl FrameNormalizer {
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
            MAX_WORKSPACE_BYTES,
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
        let mut frame = Self::empty(context, definition, capture.observed_at_ms);
        let bound = match &definition.source {
            WidgetSource::Ssh {
                commands,
                templates,
            } => {
                commands.get(&capture.platform) == Some(&capture.command)
                    && templates.get(&capture.platform) == Some(&capture.parser_id)
            }
            _ => false,
        };
        if !bound || capture.target_id != context.target_id || capture.revision != context.revision
        {
            return Self::failed(
                frame,
                "source_binding",
                "Capture does not match the widget and context",
            );
        }
        Self::evaluate(
            &mut frame,
            definition,
            &records,
            capture.monotonic_ms,
            previous,
            maximum_bytes,
            Some(capture),
        );
        frame
    }

    pub fn local(
        context: &FrameContext,
        definition: &WidgetDefinition,
        sample: &LocalSample,
        previous: Option<(&[MetricRow], u64)>,
    ) -> WidgetFrame {
        Self::local_bounded(context, definition, sample, previous, MAX_WORKSPACE_BYTES)
    }
    pub(crate) fn local_bounded(
        context: &FrameContext,
        definition: &WidgetDefinition,
        sample: &LocalSample,
        previous: Option<(&[MetricRow], u64)>,
        maximum_bytes: usize,
    ) -> WidgetFrame {
        let mut frame = Self::empty(context, definition, sample.observed_at_ms);
        let WidgetSource::Local { collector } = definition.source else {
            return Self::failed(
                frame,
                "source_binding",
                "Local sample requires a local widget",
            );
        };
        if context.target_id != "local" {
            return Self::failed(
                frame,
                "source_binding",
                "Local sample requires the local target",
            );
        }
        if sample.observed_at_ms < 0 {
            return Self::failed(frame, "sample_binding", "Local sample timestamp is invalid");
        }
        let Some(records) = sample.sources.get(collector.as_str()) else {
            return Self::failed(
                frame,
                "source_missing",
                "Collector did not produce this source",
            );
        };
        let diagnostic_bytes = sample.diagnostics.iter().fold(0usize, |bytes, d| {
            bytes.saturating_add(128).saturating_add(
                d.code
                    .len()
                    .saturating_add(d.message.len())
                    .saturating_add(d.path.len())
                    .saturating_mul(6),
            )
        });
        if diagnostic_bytes > maximum_bytes {
            return Self::failed(
                frame,
                "normalization_limit",
                "Local diagnostics exceed the memory limit",
            );
        }
        Self::evaluate(
            &mut frame,
            definition,
            records,
            sample.monotonic_ms,
            previous,
            maximum_bytes - diagnostic_bytes,
            None,
        );
        if frame.state != CollectionState::Failed {
            frame.diagnostics = sample.diagnostics.clone();
        }
        frame
    }

    fn empty(
        context: &FrameContext,
        definition: &WidgetDefinition,
        observed_at_ms: i64,
    ) -> WidgetFrame {
        WidgetFrame {
            workspace_id: context.workspace_id.clone(),
            target_id: context.target_id.clone(),
            widget_id: definition.widget.clone(),
            revision: context.revision.clone(),
            generation: context.generation,
            observed_at_ms,
            last_success_at_ms: None,
            state: CollectionState::Fresh,
            severity: ObservationSeverity::Info,
            units: definition
                .rates
                .iter()
                .chain(&definition.deltas)
                .filter_map(|(name, transform)| {
                    transform
                        .unit
                        .as_ref()
                        .map(|unit| (name.clone(), unit.clone()))
                })
                .collect(),
            rows: vec![],
            diagnostics: vec![],
        }
    }

    fn failed(mut frame: WidgetFrame, code: &str, message: &str) -> WidgetFrame {
        frame.rows.clear();
        frame.state = CollectionState::Failed;
        frame.last_success_at_ms = None;
        frame.diagnostics = vec![Diagnostic::new(code, message, &frame.widget_id)];
        frame
    }

    fn evaluate(
        frame: &mut WidgetFrame,
        definition: &WidgetDefinition,
        records: &[MetricRow],
        at: u64,
        previous: Option<(&[MetricRow], u64)>,
        maximum_bytes: usize,
        capture: Option<&Capture>,
    ) {
        let result = Self::rows(definition, records, at, previous, maximum_bytes, capture);
        match result {
            Ok(rows) => {
                frame.rows = rows;
                frame.last_success_at_ms = Some(frame.observed_at_ms);
                if !frame.rows.is_empty() {
                    frame.severity = ObservationSeverity::Ok;
                }
                for row in &frame.rows {
                    if let Some(alert) = definition.first_alert(&row.fields) {
                        if severity_rank(alert.severity) > severity_rank(frame.severity) {
                            frame.severity = alert.severity;
                        }
                    }
                }
            }
            Err(diagnostic) => {
                frame.state = CollectionState::Failed;
                frame.diagnostics.push(diagnostic);
            }
        }
    }

    fn rows(
        definition: &WidgetDefinition,
        records: &[MetricRow],
        at: u64,
        previous: Option<(&[MetricRow], u64)>,
        maximum_bytes: usize,
        capture: Option<&Capture>,
    ) -> Result<Vec<MetricRow>, Diagnostic> {
        let limit = || {
            Diagnostic::new(
                "normalization_limit",
                "Normalized output exceeds the row or memory limit",
                &definition.widget,
            )
        };
        if records.len() > MAX_FRAME_ROWS {
            return Err(limit());
        }
        let expressions: BTreeMap<_, _> = definition
            .computes
            .iter()
            .map(|(name, text)| ArithmeticExpression::parse(text).map(|expr| (name, expr)))
            .collect::<Result<_, _>>()?;
        let mut budget = 0usize;
        let mut keys = BTreeSet::new();
        let mut output = Vec::new();
        let previous_rows: BTreeMap<_, _> = previous
            .map(|(rows, _)| rows.iter().map(|row| (&row.key, row)).collect())
            .unwrap_or_default();
        for record in records {
            let mut fields = BTreeMap::new();
            for (name, aliases) in &definition.fields {
                let selected = aliases
                    .iter()
                    .filter_map(|alias| record.fields.get(alias).map(|value| (alias, value)))
                    .find(|(_, value)| {
                        !matches!(value, MetricValue::Missing { .. })
                            && !matches!(value, MetricValue::Text { value } if value.is_empty())
                    });
                let canonical = capture.and_then(|capture| {
                    selected.and_then(|(alias, value)| {
                        super::catalog::ProtocolClassifier::field_value(
                            definition, capture, name, alias, value,
                        )
                    })
                });
                let value = canonical
                    .as_ref()
                    .or_else(|| selected.map(|(_, value)| value));
                let bytes = 128usize
                    .saturating_add(name.len().saturating_mul(6))
                    .saturating_add(value.map(value_bytes).unwrap_or(128));
                // Admit alias fanout before cloning a potentially large source value.
                budget =
                    budget.saturating_add(bytes.saturating_mul(if definition.key.contains(name) {
                        3
                    } else {
                        1
                    }));
                if budget > maximum_bytes {
                    return Err(limit());
                }
                let mut value = value.cloned().unwrap_or_else(|| gap("field_missing"));
                if !definition.key.contains(name)
                    && definition
                        .rates
                        .values()
                        .chain(definition.deltas.values())
                        .any(|transform| &transform.field == name)
                {
                    if let Some(counter) = counter(&value) {
                        value = MetricValue::Unsigned {
                            value: counter.to_string(),
                        };
                    }
                }
                fields.insert(name.clone(), value);
            }
            let mut row = MetricRow::from_fields(fields, &definition.key)?;
            if !keys.insert(row.key.clone()) {
                return Err(Diagnostic::new(
                    "duplicate_key",
                    "Source produced duplicate composite keys",
                    &definition.widget,
                ));
            }
            let prior = previous_rows.get(&row.key);
            for (name, transform, rate) in definition
                .rates
                .iter()
                .map(|(n, t)| (n, t, true))
                .chain(definition.deltas.iter().map(|(n, t)| (n, t, false)))
            {
                budget = budget.saturating_add(128 + name.len().saturating_mul(6));
                if budget > maximum_bytes {
                    return Err(limit());
                }
                let result = (|| {
                    let (_, before_at) = previous.ok_or("initial_sample")?;
                    let elapsed = at
                        .checked_sub(before_at)
                        .filter(|delta| *delta > 0)
                        .ok_or("clock_gap")?;
                    let before = prior
                        .and_then(|row| row.fields.get(&transform.field))
                        .ok_or("initial_sample")?;
                    let current = row.fields.get(&transform.field).ok_or("field_missing")?;
                    // Subtract integers first: adjacent u64 counters must never round to the same float.
                    let delta = counter(current)
                        .ok_or("counter_missing")?
                        .checked_sub(counter(before).ok_or("counter_missing")?)
                        .ok_or("counter_reset")?;
                    let value = delta as f64 / if rate { elapsed as f64 / 1000.0 } else { 1.0 }
                        * transform.multiplier;
                    if value.is_finite() {
                        Ok(value)
                    } else {
                        Err("nonfinite_result")
                    }
                })();
                row.fields.insert(
                    name.clone(),
                    result
                        .map(|value| MetricValue::Number { value })
                        .unwrap_or_else(gap),
                );
            }
            let numbers: BTreeMap<_, _> = row
                .fields
                .iter()
                .filter_map(|(name, value)| number(value).map(|value| (name.clone(), value)))
                .collect();
            for (name, expression) in &expressions {
                budget = budget.saturating_add(128 + name.len().saturating_mul(6));
                if budget > maximum_bytes {
                    return Err(limit());
                }
                row.fields.insert(
                    (*name).clone(),
                    expression
                        .evaluate(&numbers)
                        .map(|value| MetricValue::Number { value })
                        .unwrap_or_else(|_| gap("expression_gap")),
                );
            }
            output.push(row);
        }
        Ok(output)
    }
}

fn gap(reason: &str) -> MetricValue {
    MetricValue::Missing {
        reason: reason.into(),
    }
}
fn counter(value: &MetricValue) -> Option<u64> {
    match value {
        MetricValue::Unsigned { value } | MetricValue::Text { value } => value.parse().ok(),
        _ => None,
    }
}
fn number(value: &MetricValue) -> Option<f64> {
    match value {
        MetricValue::Number { value } if value.is_finite() => Some(*value),
        MetricValue::Text { value } | MetricValue::Unsigned { value } => {
            value.parse::<f64>().ok().filter(|v| v.is_finite())
        }
        _ => None,
    }
}
fn value_bytes(value: &MetricValue) -> usize {
    128usize.saturating_add(match value {
        MetricValue::Text { value } | MetricValue::Unsigned { value } => {
            value.len().saturating_mul(6)
        }
        MetricValue::Missing { reason } => reason.len().saturating_mul(6),
        _ => 0,
    })
}
fn severity_rank(severity: ObservationSeverity) -> u8 {
    match severity {
        ObservationSeverity::Info => 0,
        ObservationSeverity::Ok => 1,
        ObservationSeverity::Warn => 2,
        ObservationSeverity::Alert => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn definition() -> WidgetDefinition {
        serde_yaml::from_str("widget: traffic\ntitle: Traffic\nsource: {kind: local, collector: local.network}\ninterval: 2\nkey: [interface]\nfields: {interface: [IFACE], bytes: [BYTES], usage: [USAGE]}\nview: {type: stat, field: bits, aggregation: first, label: Traffic}\nrates: {bits: {field: bytes, multiplier: 8, unit: bit/s}}\ndeltas: {change: {field: bytes}}\ncomputes: {twice: bits * 2}\nalerts: [{field: twice, op: gt, value: 10, severity: warn, message: Busy}, {field: twice, op: gt, value: 10, severity: alert, message: Later}]").unwrap()
    }
    fn context() -> FrameContext {
        FrameContext {
            workspace_id: "workspace".into(),
            target_id: "local".into(),
            revision: "revision".into(),
            generation: 9,
        }
    }
    fn sample(counter: u64, at: u64) -> LocalSample {
        LocalSample {
            observed_at_ms: at as i64,
            monotonic_ms: at,
            diagnostics: vec![],
            sources: BTreeMap::from([(
                "local.network".into(),
                vec![MetricRow {
                    key: String::new(),
                    fields: BTreeMap::from([
                        (
                            "IFACE".into(),
                            MetricValue::Text {
                                value: "001".into(),
                            },
                        ),
                        (
                            "BYTES".into(),
                            MetricValue::Text {
                                value: counter.to_string(),
                            },
                        ),
                        (
                            "USAGE".into(),
                            MetricValue::Text {
                                value: "12.5".into(),
                            },
                        ),
                    ]),
                }],
            )]),
        }
    }
    #[test]
    fn exact_counter_delta_alias_compute_and_first_alert() {
        let def = definition();
        let ctx = context();
        let first = FrameNormalizer::local(&ctx, &def, &sample(u64::MAX - 2, 1000), None);
        assert!(matches!(
            first.rows[0].fields["bits"],
            MetricValue::Missing { .. }
        ));
        let second = FrameNormalizer::local(
            &ctx,
            &def,
            &sample(u64::MAX, 2000),
            Some((&first.rows, 1000)),
        );
        assert_eq!(
            second.rows[0].fields["change"],
            MetricValue::Number { value: 2.0 }
        );
        assert_eq!(
            second.rows[0].fields["bits"],
            MetricValue::Number { value: 16.0 }
        );
        assert_eq!(
            second.rows[0].fields["twice"],
            MetricValue::Number { value: 32.0 }
        );
        assert_eq!(
            second.rows[0].fields["interface"],
            MetricValue::Text {
                value: "001".into()
            }
        );
        assert_eq!(
            second.rows[0].fields["usage"],
            MetricValue::Text {
                value: "12.5".into()
            }
        );
        assert_eq!(second.severity, ObservationSeverity::Warn);
        assert_eq!(second.generation, 9);
        assert_eq!(second.units["bits"], "bit/s");
    }
    #[test]
    fn reset_clock_missing_and_empty_are_gaps_not_unconfigured() {
        let def = definition();
        let ctx = context();
        let first = FrameNormalizer::local(&ctx, &def, &sample(9, 1000), None);
        for (value, at) in [(1, 2000), (10, 1000), (10, 900)] {
            let frame =
                FrameNormalizer::local(&ctx, &def, &sample(value, at), Some((&first.rows, 1000)));
            assert!(matches!(
                frame.rows[0].fields["bits"],
                MetricValue::Missing { .. }
            ));
        }
        let mut empty = sample(0, 2000);
        empty.sources.get_mut("local.network").unwrap().clear();
        assert_eq!(
            FrameNormalizer::local(&ctx, &def, &empty, None).state,
            CollectionState::Fresh
        );
        empty.sources.clear();
        assert_eq!(
            FrameNormalizer::local(&ctx, &def, &empty, None).state,
            CollectionState::Failed
        );
    }
    #[test]
    fn duplicate_keys_and_actual_alias_fanout_are_refused() {
        let mut def = definition();
        let mut input = sample(0, 1000);
        let duplicate = input.sources["local.network"][0].clone();
        input
            .sources
            .get_mut("local.network")
            .unwrap()
            .push(duplicate);
        let frame = FrameNormalizer::local(&context(), &def, &input, None);
        assert_eq!(frame.state, CollectionState::Failed);
        assert!(frame.rows.is_empty());
        input.sources.get_mut("local.network").unwrap().truncate(1);
        input.sources.get_mut("local.network").unwrap()[0]
            .fields
            .insert(
                "HUGE".into(),
                MetricValue::Text {
                    value: "x".repeat(1024 * 1024),
                },
            );
        for n in 0..80 {
            def.fields.insert(format!("copy{n}"), vec!["HUGE".into()]);
        }
        let frame = FrameNormalizer::local(&context(), &def, &input, None);
        assert_eq!(frame.state, CollectionState::Failed);
        assert!(frame.rows.is_empty());
        assert_eq!(frame.diagnostics[0].code, "normalization_limit");
    }
    #[test]
    fn numeric_alerts_are_explicit_and_identity_aliases_stay_distinct() {
        let mut def = definition();
        def.alerts = vec![AlertPredicate {
            field: "usage".into(),
            op: PredicateOp::Gt,
            value: ThresholdValue::Number(10.0),
            severity: ObservationSeverity::Warn,
            message: "High usage".into(),
        }];
        def.fields
            .get_mut("interface")
            .unwrap()
            .insert(0, "EMPTY".into());
        let mut input = sample(1, 1000);
        input.sources.get_mut("local.network").unwrap()[0]
            .fields
            .insert(
                "EMPTY".into(),
                MetricValue::Text {
                    value: String::new(),
                },
            );
        let mut another = input.sources["local.network"][0].clone();
        another
            .fields
            .insert("IFACE".into(), MetricValue::Text { value: "1".into() });
        input
            .sources
            .get_mut("local.network")
            .unwrap()
            .push(another);
        let frame = FrameNormalizer::local(&context(), &def, &input, None);
        assert_eq!(frame.rows.len(), 2);
        assert_ne!(frame.rows[0].key, frame.rows[1].key);
        assert_eq!(
            frame.rows[0].fields["usage"],
            MetricValue::Text {
                value: "12.5".into()
            }
        );
        assert_eq!(frame.severity, ObservationSeverity::Warn);
        input.sources.get_mut("local.network").unwrap()[0]
            .fields
            .remove("BYTES");
        let frame = FrameNormalizer::local(&context(), &def, &input, None);
        assert!(matches!(
            frame.rows[0].fields["bytes"],
            MetricValue::Missing { .. }
        ));
    }
    #[test]
    fn row_admission_and_capture_identity_are_enforced() {
        let mut def = definition();
        let mut input = sample(1, 1000);
        let row = input.sources["local.network"][0].clone();
        input.sources.insert(
            "local.network".into(),
            vec![row.clone(); MAX_FRAME_ROWS + 1],
        );
        let frame = FrameNormalizer::local(&context(), &def, &input, None);
        assert_eq!(frame.state, CollectionState::Failed);
        assert!(frame.rows.is_empty());
        def.source = WidgetSource::Ssh {
            commands: BTreeMap::from([(Platform::Iosxe, "show interfaces".into())]),
            templates: BTreeMap::from([(Platform::Iosxe, "traffic".into())]),
        };
        let mut ctx = context();
        ctx.target_id = "one".into();
        let mut capture = Capture {
            capture_id: "sample".into(),
            target_id: "one".into(),
            platform: Platform::Iosxe,
            command: "show interfaces".into(),
            parser_id: "traffic".into(),
            revision: ctx.revision.clone(),
            observed_at_ms: 1,
            monotonic_ms: 1,
            raw: String::new(),
        };
        assert_eq!(
            FrameNormalizer::normalize(&ctx, &def, &capture, vec![row.clone()], None).state,
            CollectionState::Fresh
        );
        capture.target_id = "other".into();
        assert_eq!(
            FrameNormalizer::normalize(&ctx, &def, &capture, vec![row], None).state,
            CollectionState::Failed
        );
    }
    #[test]
    fn rate_scaling_does_not_overflow_a_finite_result() {
        let mut def = definition();
        def.rates.get_mut("bits").unwrap().multiplier = 1e308;
        let first = FrameNormalizer::local(&context(), &def, &sample(0, 1000), None);
        let second = FrameNormalizer::local(
            &context(),
            &def,
            &sample(2, 3000),
            Some((&first.rows, 1000)),
        );
        assert_eq!(
            second.rows[0].fields["bits"],
            MetricValue::Number { value: 1e308 }
        );
    }
    #[test]
    fn computes_can_read_declared_unsigned_base_fields() {
        let mut def = definition();
        def.computes.insert("half".into(), "bytes / 2".into());
        let frame = FrameNormalizer::local(&context(), &def, &sample(4, 1000), None);
        assert_eq!(
            frame.rows[0].fields["half"],
            MetricValue::Number { value: 2.0 }
        );
        assert_eq!(
            frame.rows[0].fields["bytes"],
            MetricValue::Unsigned { value: "4".into() }
        );
    }
    #[test]
    fn counter_transform_alerts_keep_counter_and_key_identity_and_first_match() {
        let mut def = definition();
        let first = AlertPredicate {
            field: "bytes".into(),
            op: PredicateOp::Gt,
            value: ThresholdValue::Number(100.0),
            severity: ObservationSeverity::Warn,
            message: "First counter alert".into(),
        };
        def.alerts = vec![
            first.clone(),
            AlertPredicate {
                severity: ObservationSeverity::Alert,
                message: "Later counter alert".into(),
                ..first
            },
        ];
        let frame = FrameNormalizer::local(&context(), &def, &sample(101, 1000), None);
        assert_eq!(frame.severity, ObservationSeverity::Warn);
        assert_eq!(
            frame.rows[0].fields["bytes"],
            MetricValue::Unsigned {
                value: "101".into()
            }
        );
        assert_eq!(
            def.first_alert(&frame.rows[0].fields).unwrap().message,
            "First counter alert"
        );
        def.key.push("bytes".into());
        let frame = FrameNormalizer::local(&context(), &def, &sample(101, 1000), None);
        assert_eq!(frame.severity, ObservationSeverity::Warn);
        assert_eq!(
            frame.rows[0].fields["bytes"],
            MetricValue::Text {
                value: "101".into()
            }
        );
        assert_eq!(
            frame.rows[0].fields["interface"],
            MetricValue::Text {
                value: "001".into()
            }
        );
    }
}
