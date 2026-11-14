//! Configured display histories; exact counters remain in the latest metric rows.
use super::{model::*, processing::MAX_WORKSPACE_BYTES};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const HOUR_MS: u64 = 3_600_000;
const MAX_SERIES: usize = 512;
type SeriesKey = (String, String, String, String);
struct Configuration {
    signature: String,
    fields: BTreeSet<String>,
    units: BTreeMap<String, String>,
}
struct RetainedPoint {
    monotonic_ms: u64,
    point: SeriesPoint,
}
struct HistorySeries {
    unit: Option<String>,
    points: BTreeMap<i64, RetainedPoint>,
    pending_gap: Option<&'static str>,
}

pub struct TelemetryHistory {
    workspace_id: String,
    now_ms: u64,
    configurations: BTreeMap<(String, String), Configuration>,
    series: BTreeMap<SeriesKey, HistorySeries>,
    used_bytes: usize,
    next_prune_ms: u64,
}

impl TelemetryHistory {
    pub fn new(workspace_id: &str) -> Self {
        Self {
            workspace_id: workspace_id.into(),
            now_ms: 0,
            used_bytes: workspace_id.len(),
            next_prune_ms: u64::MAX,
            configurations: BTreeMap::new(),
            series: BTreeMap::new(),
        }
    }

    /// Returns whether the baseline's source semantics changed.
    pub(crate) fn configure(
        &mut self,
        target: &str,
        definition: &WidgetDefinition,
        template_hash: &str,
    ) -> Result<bool, Diagnostic> {
        let units = definition.declared_units()?;
        let rates: BTreeMap<_, _> = definition
            .rates
            .iter()
            .map(|(name, transform)| (name, (&transform.field, transform.multiplier)))
            .collect();
        let deltas: BTreeMap<_, _> = definition
            .deltas
            .iter()
            .map(|(name, transform)| (name, (&transform.field, transform.multiplier)))
            .collect();
        let bytes = serde_json::to_vec(&(
            &definition.source,
            &definition.key,
            &definition.fields,
            rates,
            deltas,
            &definition.computes,
            template_hash,
        ))
        .map_err(|_| {
            Diagnostic::new(
                "history_binding",
                "Cannot identify history source",
                &definition.widget,
            )
        })?;
        let signature = format!("{:x}", Sha256::digest(bytes));
        let fields: BTreeSet<_> = definition
            .history
            .as_ref()
            .map(|h| h.fields.iter().cloned().collect())
            .unwrap_or_default();
        let key = (target.to_string(), definition.widget.clone());
        if self.configurations.get(&key).is_some_and(|old| {
            old.signature == signature && old.fields == fields && old.units == units
        }) {
            return Ok(false);
        }
        let changed = self
            .configurations
            .get(&key)
            .is_some_and(|old| old.signature != signature);
        self.series.retain(|(t, w, _, f), _| {
            t != target
                || w != &definition.widget
                || (!changed
                    && fields.contains(f)
                    && self
                        .configurations
                        .get(&key)
                        .is_none_or(|old| old.units.get(f) == units.get(f)))
        });
        self.configurations.insert(
            key,
            Configuration {
                signature,
                fields,
                units,
            },
        );
        self.used_bytes = self.calculate_bytes();
        Ok(changed)
    }

    pub(crate) fn retain_widgets(&mut self, selected: &BTreeSet<(String, String)>) {
        self.configurations.retain(|key, _| selected.contains(key));
        self.series.retain(|(target, widget, _, _), _| {
            selected.contains(&(target.clone(), widget.clone()))
        });
        self.used_bytes = self.calculate_bytes();
    }

    pub(crate) fn advance(&mut self, monotonic_ms: u64) {
        self.now_ms = self.now_ms.max(monotonic_ms);
        if self.now_ms < self.next_prune_ms {
            return;
        }
        let cutoff = self.now_ms.saturating_sub(HOUR_MS);
        self.series.retain(|_, series| {
            let first_live = series
                .points
                .iter()
                .find(|(_, p)| p.monotonic_ms >= cutoff)
                .map(|(at, _)| *at);
            let Some(first_live) = first_live else {
                return false;
            };
            let boundary = series
                .points
                .range(..first_live)
                .next_back()
                .map(|(at, _)| *at);
            series
                .points
                .retain(|at, point| point.monotonic_ms >= cutoff || Some(*at) == boundary);
            true
        });
        self.used_bytes = self.calculate_bytes();
        self.next_prune_ms = self
            .series
            .values()
            .filter_map(|series| {
                let mut points = series.points.values();
                let first = points.next()?;
                Some(
                    points
                        .next()
                        .unwrap_or(first)
                        .monotonic_ms
                        .saturating_add(HOUR_MS)
                        .saturating_add(1),
                )
            })
            .min()
            .unwrap_or(u64::MAX);
    }

    pub fn append(&mut self, frame: &WidgetFrame) -> Result<(), Diagnostic> {
        self.append_bounded(frame, MAX_WORKSPACE_BYTES)
    }

    pub(crate) fn discontinuity(
        &mut self,
        target: Option<&str>,
        widgets: &BTreeSet<String>,
        observed_at_ms: i64,
        maximum_bytes: usize,
        reason: &'static str,
    ) -> Result<(), Diagnostic> {
        let resumed = if reason == "Monitoring stopped" {
            "Collection resumed after monitoring stopped"
        } else {
            "Collection resumed after collection failed"
        };
        let mut pending = Vec::new();
        let mut clock_gap = false;
        let mut bytes = self.bytes();
        for (key, series) in &mut self.series {
            if target.is_some_and(|target| key.0 != target)
                || (!widgets.is_empty() && !widgets.contains(&key.1))
            {
                continue;
            }
            let Some((last_at, last)) = series.points.last_key_value() else {
                continue;
            };
            if last.point.value.is_none() || series.pending_gap.is_some() {
                continue;
            }
            series.pending_gap = Some(resumed);
            if observed_at_ms <= *last_at {
                clock_gap = true;
                continue;
            }
            let point = SeriesPoint {
                at_ms: observed_at_ms,
                value: None,
                reason: Some(reason.into()),
            };
            bytes = bytes.saturating_add(point_bytes(&point));
            pending.push((key.clone(), point));
        }
        if bytes > maximum_bytes {
            return Err(Diagnostic::new(
                "history_memory_limit",
                "History gap is pending until another observation fits the workspace memory limit",
                "telemetry",
            ));
        }
        for (key, point) in pending {
            let series = self.series.get_mut(&key).unwrap();
            series.points.insert(
                point.at_ms,
                RetainedPoint {
                    monotonic_ms: self.now_ms,
                    point,
                },
            );
            series.pending_gap = None;
        }
        self.used_bytes = bytes;
        self.next_prune_ms = self
            .next_prune_ms
            .min(self.now_ms.saturating_add(HOUR_MS).saturating_add(1));
        if clock_gap {
            return Err(Diagnostic::new("history_clock", "Collection gap is pending: the event clock did not exceed the last observation; the next admissible observation will mark the discontinuity", "telemetry"));
        }
        Ok(())
    }

    pub(crate) fn append_bounded(
        &mut self,
        frame: &WidgetFrame,
        maximum_bytes: usize,
    ) -> Result<(), Diagnostic> {
        let fail = |code, message| Diagnostic::new(code, message, &frame.widget_id);
        if frame.workspace_id != self.workspace_id {
            return Err(fail(
                "history_workspace",
                "Frame belongs to another workspace",
            ));
        }
        if self.bytes() > maximum_bytes {
            return Err(fail(
                "history_memory_limit",
                "Workspace history memory limit reached",
            ));
        }
        let Some(configuration) = self
            .configurations
            .get(&(frame.target_id.clone(), frame.widget_id.clone()))
        else {
            return Ok(());
        };
        let mut pending = BTreeMap::new();
        for row in &frame.rows {
            for field in &configuration.fields {
                let key = (
                    frame.target_id.clone(),
                    frame.widget_id.clone(),
                    row.key.clone(),
                    field.clone(),
                );
                let (value, reason) = match row.fields.get(field) {
                    Some(MetricValue::Number { value }) if value.is_finite() => {
                        (Some(*value), None)
                    }
                    Some(MetricValue::Unsigned { value } | MetricValue::Text { value }) => {
                        let value = value.parse::<f64>().ok().filter(|v| v.is_finite());
                        (
                            value,
                            value.is_none().then_some("numeric_unavailable".to_string()),
                        )
                    }
                    Some(MetricValue::Missing { reason }) => (None, Some(reason.clone())),
                    _ => (None, Some("numeric_unavailable".to_string())),
                };
                pending.insert(
                    key,
                    (
                        frame.units.get(field).cloned(),
                        SeriesPoint {
                            at_ms: frame.observed_at_ms,
                            value,
                            reason,
                        },
                    ),
                );
            }
        }
        for (key, existing) in &self.series {
            if key.0 == frame.target_id && key.1 == frame.widget_id && !pending.contains_key(key) {
                pending.insert(
                    key.clone(),
                    (
                        existing.unit.clone(),
                        SeriesPoint {
                            at_ms: frame.observed_at_ms,
                            value: None,
                            reason: Some(
                                if frame.state == CollectionState::Fresh {
                                    "row_missing"
                                } else {
                                    "collection_gap"
                                }
                                .into(),
                            ),
                        },
                    ),
                );
            }
        }
        let mut bytes = self.bytes();
        let mut count = self.series.len();
        for (key, (unit, point)) in &mut pending {
            if point.value.is_some() {
                if let Some(reason) = self
                    .series
                    .get(key)
                    .filter(|series| &series.unit == unit)
                    .and_then(|series| series.pending_gap)
                {
                    point.reason = Some(reason.into());
                }
            }
            if self
                .series
                .get(key)
                .filter(|existing| &existing.unit == unit)
                .and_then(|existing| existing.points.last_key_value())
                .is_some_and(|(at, _)| *at >= point.at_ms)
            {
                return Err(fail("history_clock", "History paused: observed wall time must exceed the last retained timestamp; resumes when time exceeds it or the workspace closes/reopens"));
            }
            match self.series.get(key) {
                Some(existing) if &existing.unit != unit => {
                    bytes = bytes.saturating_sub(series_bytes(key, existing));
                    bytes = bytes.saturating_add(series_base_bytes(key, unit));
                }
                None => {
                    count += 1;
                    bytes = bytes.saturating_add(series_base_bytes(key, unit));
                }
                _ => {}
            }
            bytes = bytes.saturating_add(point_bytes(point));
        }
        if bytes > maximum_bytes {
            return Err(fail(
                "history_memory_limit",
                "Workspace history memory limit reached",
            ));
        }
        if count > MAX_SERIES {
            return Err(fail(
                "history_series_limit",
                "Workspace numeric series limit reached",
            ));
        }
        for (key, (unit, point)) in pending {
            let series = self.series.entry(key).or_insert_with(|| HistorySeries {
                unit: unit.clone(),
                points: BTreeMap::new(),
                pending_gap: None,
            });
            if series.unit != unit {
                series.points.clear();
                series.unit = unit;
            }
            series.pending_gap = None;
            series.points.insert(
                point.at_ms,
                RetainedPoint {
                    monotonic_ms: self.now_ms,
                    point,
                },
            );
        }
        self.used_bytes = bytes;
        self.next_prune_ms = self
            .next_prune_ms
            .min(self.now_ms.saturating_add(HOUR_MS).saturating_add(1));
        Ok(())
    }

    pub fn series(&self, query: SeriesQuery) -> SeriesPage {
        let empty = || SeriesPage {
            points: vec![],
            next_after_ms: None,
        };
        if query.workspace_id != self.workspace_id || query.limit == 0 {
            return empty();
        }
        let Some(series) =
            self.series
                .get(&(query.target_id, query.widget_id, query.row_key, query.field))
        else {
            return empty();
        };
        let mut points = series
            .points
            .values()
            .filter(|p| query.after_ms.is_none_or(|after| p.point.at_ms > after));
        let page: Vec<_> = points
            .by_ref()
            .take(query.limit.min(1000) as usize)
            .map(|p| p.point.clone())
            .collect();
        let next_after_ms = points.next().and_then(|_| page.last().map(|p| p.at_ms));
        SeriesPage {
            points: page,
            next_after_ms,
        }
    }

    pub(crate) fn summaries(&self) -> Vec<SeriesSummary> {
        self.series
            .iter()
            .map(|((target, widget, row, field), series)| SeriesSummary {
                target_id: target.clone(),
                widget_id: widget.clone(),
                row_key: row.clone(),
                field: field.clone(),
                unit: series.unit.clone(),
                point_count: series.points.len() as u32,
            })
            .collect()
    }

    /// Conservative node/string accounting includes retained B-tree allocation overhead.
    pub(crate) fn bytes(&self) -> usize {
        self.used_bytes
    }
    fn calculate_bytes(&self) -> usize {
        self.workspace_id.len()
            + self
                .configurations
                .iter()
                .map(|((target, widget), c)| {
                    512 + 2
                        * (target.len()
                            + widget.len()
                            + c.signature.len()
                            + c.fields.iter().map(|f| f.len() + 128).sum::<usize>()
                            + c.units
                                .iter()
                                .map(|(field, unit)| field.len() + unit.len() + 128)
                                .sum::<usize>())
                })
                .sum::<usize>()
            + self
                .series
                .iter()
                .map(|(key, series)| series_bytes(key, series))
                .sum::<usize>()
    }
}

fn point_bytes(point: &SeriesPoint) -> usize {
    192 + 2 * point.reason.as_ref().map_or(0, |r| r.len())
}
fn series_base_bytes(key: &SeriesKey, unit: &Option<String>) -> usize {
    512 + 2
        * (key.0.len()
            + key.1.len()
            + key.2.len()
            + key.3.len()
            + unit.as_ref().map_or(0, |u| u.len()))
}
fn series_bytes(key: &SeriesKey, series: &HistorySeries) -> usize {
    series_base_bytes(key, &series.unit)
        + series
            .points
            .values()
            .map(|p| point_bytes(&p.point))
            .sum::<usize>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn definition() -> WidgetDefinition {
        serde_yaml::from_str("widget: traffic\ntitle: Traffic\nsource: {kind: local, collector: local.network}\ninterval: 2\nkey: [interface]\nfields: {interface: [interface], rate: [rate]}\nview: {type: chart, series: [{field: rate, label: Traffic, unit: bit/s}]}\nhistory: {fields: [rate]}\n").unwrap()
    }

    fn frame(at: i64, value: MetricValue) -> WidgetFrame {
        WidgetFrame {
            workspace_id: "workspace".into(),
            target_id: "local".into(),
            widget_id: "traffic".into(),
            revision: "source-v1".into(),
            generation: 1,
            observed_at_ms: at,
            last_success_at_ms: Some(at),
            state: CollectionState::Fresh,
            severity: ObservationSeverity::Ok,
            units: BTreeMap::from([("rate".into(), "bit/s".into())]),
            rows: vec![MetricRow {
                key: "eth0".into(),
                fields: BTreeMap::from([
                    ("rate".into(), value),
                    ("unconfigured".into(), MetricValue::Number { value: 99.0 }),
                ]),
            }],
            diagnostics: vec![],
        }
    }

    fn query(limit: u32) -> SeriesQuery {
        SeriesQuery {
            workspace_id: "workspace".into(),
            target_id: "local".into(),
            widget_id: "traffic".into(),
            row_key: "eth0".into(),
            field: "rate".into(),
            after_ms: None,
            limit,
        }
    }

    fn history() -> TelemetryHistory {
        let mut history = TelemetryHistory::new("workspace");
        history
            .configure("local", &definition(), "source-v1")
            .unwrap();
        history
    }

    #[test]
    fn memory_hour_and_capacity_are_bounded() {
        let mut history = history();
        for at in [0, 1_000, 3_600_000, 3_601_000] {
            history.advance(at as u64);
            history
                .append(&frame(at, MetricValue::Number { value: at as f64 }))
                .unwrap();
        }
        assert_eq!(
            history
                .series(query(1000))
                .points
                .iter()
                .map(|p| p.at_ms)
                .collect::<Vec<_>>(),
            vec![0, 1_000, 3_600_000, 3_601_000]
        );
        history.advance(3_602_000);
        assert_eq!(
            history
                .series(query(1000))
                .points
                .iter()
                .map(|p| p.at_ms)
                .collect::<Vec<_>>(),
            vec![1_000, 3_600_000, 3_601_000]
        );
        history.advance(7_202_000);
        assert!(history.series(query(1000)).points.is_empty());

        let mut sample = frame(7_202_001, MetricValue::Number { value: 1.0 });
        sample.rows = (0..512)
            .map(|n| MetricRow {
                key: n.to_string(),
                fields: BTreeMap::from([("rate".into(), MetricValue::Number { value: 1.0 })]),
            })
            .collect();
        history.advance(7_202_001);
        history.append(&sample).unwrap();
        assert_eq!(history.summaries().len(), 512);
        sample.observed_at_ms += 1;
        sample.rows.push(MetricRow {
            key: "overflow".into(),
            fields: BTreeMap::from([("rate".into(), MetricValue::Number { value: 1.0 })]),
        });
        assert_eq!(
            history.append(&sample).unwrap_err().code,
            "history_series_limit"
        );
        assert_eq!(history.summaries().len(), 512);
        assert!(history.bytes() <= 64 * 1024 * 1024);
        assert_eq!(
            history.append_bounded(&sample, 1).unwrap_err().code,
            "history_memory_limit"
        );
    }

    #[test]
    fn configured_numeric_values_and_gaps_keep_the_source_meaning() {
        let mut history = history();
        for (at, value) in [
            (
                0,
                MetricValue::Unsigned {
                    value: "18446744073709551615".into(),
                },
            ),
            (
                1,
                MetricValue::Text {
                    value: "1234".into(),
                },
            ),
            (
                2,
                MetricValue::Missing {
                    reason: "counter_reset".into(),
                },
            ),
        ] {
            history.advance(at as u64);
            history.append(&frame(at, value)).unwrap();
        }
        let points = history.series(query(1000)).points;
        assert!(points[0].value.unwrap().is_finite());
        assert_eq!(points[1].value, Some(1234.0));
        let reset_point = &points[2];
        assert_eq!(reset_point.value, None);
        assert_eq!(reset_point.reason.as_deref(), Some("counter_reset"));
        assert_eq!(history.summaries().len(), 1);
        let mut missing = frame(3, MetricValue::Number { value: 1.0 });
        missing.rows.clear();
        history.advance(3);
        history.append(&missing).unwrap();
        assert_eq!(
            history
                .series(query(1000))
                .points
                .last()
                .unwrap()
                .reason
                .as_deref(),
            Some("row_missing")
        );
    }

    #[test]
    fn presentation_preserves_history_source_key_and_unit_changes_reset_it() {
        let mut history = history();
        history
            .append(&frame(0, MetricValue::Number { value: 1.0 }))
            .unwrap();
        let mut changed = definition();
        changed.title = "Renamed".into();
        changed.interval = 10;
        changed.view = WidgetView::Chart {
            series: vec![ViewField {
                field: "rate".into(),
                label: "New label".into(),
                unit: Some("bit/s".into()),
            }],
        };
        history.configure("local", &changed, "source-v1").unwrap();
        assert_eq!(history.series(query(1000)).points.len(), 1);
        changed.key = vec!["other_identity".into()];
        history.configure("local", &changed, "source-v1").unwrap();
        assert!(history.series(query(1000)).points.is_empty());
        history
            .append(&frame(1, MetricValue::Number { value: 2.0 }))
            .unwrap();
        let mut unit_changed = frame(2, MetricValue::Number { value: 3.0 });
        unit_changed.units.insert("rate".into(), "packet/s".into());
        history.advance(2);
        history.append(&unit_changed).unwrap();
        assert_eq!(history.series(query(1000)).points.len(), 1);
        history
            .configure("local", &changed, "different-template-hash")
            .unwrap();
        assert!(history.series(query(1000)).points.is_empty());
    }

    #[test]
    fn exact_points_are_paged_at_one_thousand_and_clock_jumps_do_not_expire_them() {
        let mut history = history();
        for at in 0..1005 {
            history.advance(at as u64);
            history
                .append(&frame(at, MetricValue::Number { value: at as f64 }))
                .unwrap();
        }
        let first = history.series(query(50_000));
        assert_eq!(first.points.len(), 1000);
        assert_eq!(first.next_after_ms, Some(999));
        let mut next = query(1000);
        next.after_ms = first.next_after_ms;
        assert_eq!(history.series(next).points.len(), 5);
        history
            .append(&frame(9_000_000_000, MetricValue::Number { value: 1.0 }))
            .unwrap();
        assert_eq!(history.series(query(1000)).points.len(), 1000);
        history.advance(3_602_000);
        assert!(history.series(query(1000)).points.is_empty());
    }

    #[test]
    fn duplicate_and_backward_wall_times_refuse_atomic_append_until_recovery() {
        let mut history = history();
        history
            .append(&frame(100, MetricValue::Number { value: 1.0 }))
            .unwrap();
        for at in [100, 99] {
            history.advance(1000);
            let diagnostic = history
                .append(&frame(at, MetricValue::Number { value: 2.0 }))
                .unwrap_err();
            assert_eq!(diagnostic.code, "history_clock");
            assert!(diagnostic.message.contains("exceeds"));
            assert_eq!(history.series(query(1000)).points.len(), 1);
        }
        history
            .append(&frame(101, MetricValue::Number { value: 3.0 }))
            .unwrap();
        assert_eq!(
            history
                .series(query(1000))
                .points
                .iter()
                .map(|p| p.at_ms)
                .collect::<Vec<_>>(),
            vec![100, 101]
        );
    }
    #[test]
    fn final_pending_gap_survives_clock_and_memory_rejection_without_changing_exact_paging() {
        for event_at in [100, 99] {
            let mut history = history();
            history
                .append(&frame(100, MetricValue::Number { value: 4.0 }))
                .unwrap();
            assert_eq!(
                history
                    .discontinuity(
                        Some("local"),
                        &BTreeSet::new(),
                        event_at,
                        MAX_WORKSPACE_BYTES,
                        "Monitoring stopped"
                    )
                    .unwrap_err()
                    .code,
                "history_clock"
            );
            let next = frame(101, MetricValue::Number { value: 8.0 });
            assert_eq!(
                history
                    .append_bounded(&next, history.bytes())
                    .unwrap_err()
                    .code,
                "history_memory_limit"
            );
            assert_eq!(history.series(query(100)).points.len(), 1);
            history.append(&next).unwrap();
            let first = history.series(query(1));
            assert_eq!(first.points[0].value, Some(4.0));
            assert_eq!(first.next_after_ms, Some(100));
            let mut second = query(1);
            second.after_ms = first.next_after_ms;
            let second = history.series(second);
            assert_eq!(second.points[0].at_ms, 101);
            assert_eq!(second.points[0].value, Some(8.0));
            assert_eq!(
                second.points[0].reason.as_deref(),
                Some("Collection resumed after monitoring stopped")
            );
            assert_eq!(second.next_after_ms, None);
            let mut title = definition();
            title.title = "Renamed".into();
            history.configure("local", &title, "source-v1").unwrap();
            assert_eq!(history.series(query(100)).points.len(), 2);
            let WidgetView::Chart { series } = &mut title.view else {
                unreachable!()
            };
            series[0].unit = Some("new-unit".into());
            history.configure("local", &title, "source-v1").unwrap();
            assert!(history.series(query(100)).points.is_empty());
        }
    }
    #[test]
    fn cached_charge_matches_admission_unit_reset_configuration_and_expiry() {
        let mut history = history();
        for at in 0..10 {
            history.advance(at as u64);
            history
                .append(&frame(
                    at,
                    MetricValue::Missing {
                        reason: format!("gap\u{0}\"ß{at}"),
                    },
                ))
                .unwrap();
            assert_eq!(history.bytes(), history.calculate_bytes());
        }
        let mut changed = frame(10, MetricValue::Number { value: 1.0 });
        changed.units.insert("rate".into(), "packet/s".into());
        history.advance(10);
        history.append(&changed).unwrap();
        assert_eq!(history.bytes(), history.calculate_bytes());
        history.advance(3_600_011);
        assert!(history.summaries().is_empty());
        assert_eq!(history.bytes(), history.calculate_bytes());
        history
            .configure("local", &definition(), "another-source")
            .unwrap();
        assert_eq!(history.bytes(), history.calculate_bytes());
    }
    #[test]
    fn changing_one_transform_unit_resets_only_its_series() {
        let mut definition = definition();
        let WidgetView::Chart { series } = &mut definition.view else {
            unreachable!()
        };
        series[0].unit = Some("B/s".into());
        definition.fields.remove("rate");
        definition
            .fields
            .insert("bytes".into(), vec!["bytes".into()]);
        for field in ["rate", "other"] {
            definition.rates.insert(
                field.into(),
                NumericTransform {
                    field: "bytes".into(),
                    multiplier: 1.0,
                    unit: Some("B/s".into()),
                },
            );
        }
        definition
            .history
            .as_mut()
            .unwrap()
            .fields
            .push("other".into());
        let mut history = TelemetryHistory::new("workspace");
        history.configure("local", &definition, "source").unwrap();
        let mut sample = frame(0, MetricValue::Number { value: 1.0 });
        sample.units.insert("rate".into(), "B/s".into());
        sample.units.insert("other".into(), "B/s".into());
        sample.rows[0]
            .fields
            .insert("other".into(), MetricValue::Number { value: 2.0 });
        history.append(&sample).unwrap();
        definition.rates.get_mut("rate").unwrap().unit = Some("kB/s".into());
        let WidgetView::Chart { series } = &mut definition.view else {
            unreachable!()
        };
        series[0].unit = Some("kB/s".into());
        history.configure("local", &definition, "source").unwrap();
        assert_eq!(history.summaries().len(), 1);
        sample.observed_at_ms = 1;
        sample.units.insert("rate".into(), "kB/s".into());
        history.advance(1);
        history.append(&sample).unwrap();
        let summaries = history.summaries();
        assert_eq!(
            summaries
                .iter()
                .find(|s| s.field == "rate")
                .unwrap()
                .point_count,
            1
        );
        assert_eq!(
            summaries
                .iter()
                .find(|s| s.field == "other")
                .unwrap()
                .point_count,
            2
        );
        assert_eq!(history.bytes(), history.calculate_bytes());
    }
}
