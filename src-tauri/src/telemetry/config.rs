//! Validated asset overlays and atomic revision publication; no metric history.
use super::{
    catalog::ProtocolClassifier,
    definition::{parse_document, DefinitionValidator},
    model::*,
    parser::{validate_binding, TelemetryParser},
    processing::{FrameNormalizer, MAX_FRAME_ROWS, MAX_WORKSPACE_BYTES},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;

pub struct TelemetryConfigRepository {
    root: PathBuf,
    builtin: Catalog,
    parser: Arc<TelemetryParser>,
    state: Mutex<RepositoryState>,
    #[cfg(test)]
    test_now: std::sync::atomic::AtomicI64,
    #[cfg(test)]
    fail_write: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    pub(crate) publication_pause:
        Mutex<Option<Arc<(std::sync::atomic::AtomicBool, std::sync::atomic::AtomicBool)>>>,
}

/// Backend-only admission plan; neither this nor its sealed proof is an IPC value.
pub(crate) struct DraftSamplePlan {
    workspace: String,
    generation: u64,
    base: Revision,
    source: Revision,
    scope: ConfigScope,
    target: TargetRef,
    template: TemplateAsset,
    origin: String,
}
impl DraftSamplePlan {
    pub(crate) fn request(&self) -> Result<CaptureRequest, Diagnostic> {
        Ok(CaptureRequest {
            command: super::policy::CommandPolicy::admit(
                self.target.platform,
                &self.template.command,
            )?,
            parser_id: self.template.id.clone(),
            revision: self.source.clone(),
        })
    }
}
#[derive(Clone)]
pub(crate) struct DraftCaptureProof {
    workspace: String,
    generation: u64,
    base: Revision,
    source: Revision,
    scope: ConfigScope,
    target: TargetRef,
    command: String,
    capture_id: String,
    parser_id: String,
    raw_hash: String,
    observed_at_ms: i64,
    monotonic_ms: u64,
    origin: String,
    template_hash: String,
}
impl DraftCaptureProof {
    pub(crate) fn bytes(&self) -> usize {
        2048 + 4
            * (self.workspace.len()
                + self.base.len()
                + self.source.len()
                + self.target.connection_id.len()
                + self.command.len()
                + self.capture_id.len()
                + self.parser_id.len()
                + self.raw_hash.len()
                + self.origin.len()
                + self.template_hash.len())
    }
    fn matches(&self, capture: &Capture, context: &PreviewSourceContext<'_>) -> bool {
        self.workspace == context.workspace
            && self.generation == context.generation
            && self.base == context.base
            && &self.scope == context.scope
            && self.source == capture.revision
            && self.target.connection_id == capture.target_id
            && self.target.platform == capture.platform
            && self.command == capture.command
            && self.capture_id == capture.capture_id
            && self.parser_id == capture.parser_id
            && self.raw_hash == hash(capture.raw.as_bytes())
            && self.observed_at_ms == capture.observed_at_ms
            && self.monotonic_ms == capture.monotonic_ms
            && valid_hash(&self.origin)
            && valid_hash(&self.template_hash)
            && capture.raw.len() <= 2 * 1024 * 1024
    }
}
struct PreviewSourceContext<'a> {
    catalogs: &'a BTreeMap<String, Catalog>,
    revisions: &'a BTreeMap<String, Revision>,
    workspace: &'a str,
    generation: u64,
    base: &'a str,
    scope: &'a ConfigScope,
    proofs: &'a [DraftCaptureProof],
    retained_bytes: usize,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Overrides {
    local: Catalog,
    profiles: BTreeMap<Platform, Catalog>,
    devices: BTreeMap<String, DeviceOverride>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceOverride {
    platform: Platform,
    assets: Catalog,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RevisionBundle<T> {
    builtin_hash: String,
    overrides: T,
}
struct RepositoryState {
    overrides: Overrides,
    revision: Revision,
    pointer: Option<String>,
    targets: BTreeMap<String, Platform>,
    previews: BTreeMap<String, PreviewGrant>,
    attempts: BTreeMap<String, String>,
}
struct PreviewGrant {
    workspace_id: String,
    generation: u64,
    token: PreviewToken,
}

impl TelemetryConfigRepository {
    /// `root` is the backend app-data root, never a client-provided path.
    pub fn load(
        root: PathBuf,
        builtin: Catalog,
        parser: Arc<TelemetryParser>,
    ) -> Result<Self, Diagnostic> {
        let root = root.join("telemetry");
        let pointer = read_pointer(&root)?;
        let overrides = if let Some(revision) = &pointer {
            let bytes = read_bounded(
                &root.join("revisions").join(revision).join("bundle.json"),
                MAX_WORKSPACE_BYTES,
            )?;
            if hash(&bytes) != *revision {
                return Err(error(
                    "revision_corrupt",
                    "Revision bundle checksum does not match its pointer",
                ));
            }
            let bundle: RevisionBundle<Overrides> = serde_json::from_slice(&bytes)
                .map_err(|_| error("revision_corrupt", "Revision bundle is invalid"))?;
            if !valid_hash(&bundle.builtin_hash) {
                return Err(error(
                    "revision_corrupt",
                    "Bundled asset fingerprint is invalid",
                ));
            }
            bundle.overrides
        } else {
            Overrides::default()
        };
        let repo = Self {
            root,
            builtin,
            parser,
            state: Mutex::new(RepositoryState {
                revision: String::new(),
                overrides,
                pointer,
                targets: BTreeMap::new(),
                previews: BTreeMap::new(),
                attempts: BTreeMap::new(),
            }),
            #[cfg(test)]
            test_now: std::sync::atomic::AtomicI64::new(0),
            #[cfg(test)]
            fail_write: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            publication_pause: Mutex::new(None),
        };
        {
            let mut state = repo.lock();
            repo.validate_all(&state.overrides)?;
            state.revision = repo.revision(&state.overrides)?;
        }
        Ok(repo)
    }

    /// Replace backend-known references. This API never opens the connection inventory.
    pub fn register_targets(&self, targets: &[TargetRef]) -> Result<(), Diagnostic> {
        let mut known = BTreeMap::new();
        let mut state = self.lock();
        for target in targets {
            if target.connection_id.is_empty()
                || target.connection_id == "local"
                || known
                    .insert(target.connection_id.clone(), target.platform)
                    .is_some()
            {
                return Err(error(
                    "target_reference",
                    "Target IDs must be nonempty, unique and nonlocal",
                ));
            }
            if state
                .overrides
                .devices
                .get(&target.connection_id)
                .is_some_and(|stored| stored.platform != target.platform)
            {
                return Err(error(
                    "target_platform",
                    "Stored device override belongs to another platform",
                ));
            }
        }
        state.targets = known;
        state.previews.clear();
        state.attempts.clear();
        Ok(())
    }

    pub fn effective(&self, target: &TargetRef) -> EffectiveConfig {
        let state = self.lock();
        effective(self.network_catalog(&state.overrides, target, true))
    }
    pub fn effective_local(&self) -> EffectiveConfig {
        let state = self.lock();
        effective(self.local_catalog(&state.overrides))
    }

    /// Global bundle authority for draft/token CAS, independent of source content revisions.
    pub fn base_revision(&self) -> Revision {
        self.lock().revision.clone()
    }
    pub(crate) fn uses_parser(&self, parser: &Arc<TelemetryParser>) -> bool {
        Arc::ptr_eq(&self.parser, parser)
    }

    pub fn validate(&self, draft: &ConfigDraft) -> ValidationReport {
        let state = self.lock();
        let result = self.candidate(&state, draft);
        let (affected_targets, masked_device_overrides) = result
            .as_ref()
            .map(|candidate| self.affected(&state, candidate, &draft.scope))
            .unwrap_or_default();
        ValidationReport {
            valid: result.is_ok(),
            draft_hash: DefinitionValidator::draft_hash(draft),
            diagnostics: result.err().unwrap_or_default(),
            affected_targets,
            masked_device_overrides,
        }
    }

    pub fn import_draft(
        &self,
        scope: ConfigScope,
        widgets_yaml: String,
        layouts_yaml: String,
        templates: BTreeMap<TemplateId, String>,
    ) -> Result<ConfigDraft, Diagnostic> {
        let state = self.lock();
        self.scope_platform(&state, &scope)?;
        Ok(ConfigDraft {
            scope,
            widgets_yaml,
            layouts_yaml,
            templates,
            expected_revision: state.revision.clone(),
            reset_assets: vec![],
        })
    }

    pub fn reset_draft(
        &self,
        scope: ConfigScope,
        asset: ResetAsset,
    ) -> Result<ConfigDraft, Diagnostic> {
        let state = self.lock();
        let inherited = self.inherited(&state, &scope)?;
        let mut widgets = vec![];
        let mut layouts = vec![];
        let mut templates = BTreeMap::new();
        match &asset {
            ResetAsset::Widget(id) => widgets.push(
                inherited
                    .widgets
                    .get(id)
                    .ok_or_else(|| error("reset_missing", "Widget has no inherited definition"))?
                    .clone(),
            ),
            ResetAsset::Layout(id) => layouts.push(
                inherited
                    .layouts
                    .get(id)
                    .ok_or_else(|| error("reset_missing", "Layout has no inherited definition"))?
                    .clone(),
            ),
            ResetAsset::Template(id) => {
                templates.insert(
                    id.clone(),
                    inherited
                        .templates
                        .get(id)
                        .ok_or_else(|| {
                            error("reset_missing", "Template has no inherited definition")
                        })?
                        .text
                        .clone(),
                );
            }
        }
        Ok(ConfigDraft {
            scope,
            widgets_yaml: serde_yaml::to_string(&WidgetDocument {
                schema_version: 1,
                widgets,
            })
            .map_err(|_| error("encoding", "Cannot encode inherited widgets"))?,
            layouts_yaml: serde_yaml::to_string(&LayoutDocument {
                schema_version: 1,
                layouts,
            })
            .map_err(|_| error("encoding", "Cannot encode inherited layouts"))?,
            templates,
            expected_revision: state.revision.clone(),
            reset_assets: vec![asset],
        })
    }

    pub async fn preview(
        &self,
        workspace_id: &str,
        generation: u64,
        draft: &ConfigDraft,
        captures: Vec<Capture>,
        local_samples: Vec<LocalSample>,
    ) -> PreviewReport {
        self.preview_owned(
            workspace_id,
            generation,
            draft,
            captures,
            local_samples,
            vec![],
            0,
        )
        .await
    }

    pub(crate) fn prepare_draft_sample(
        &self,
        workspace: &str,
        generation: u64,
        target: &TargetRef,
        draft: &ConfigDraft,
        parser_id: &str,
    ) -> Result<DraftSamplePlan, Diagnostic> {
        let state = self.lock();
        if workspace.is_empty()
            || state.targets.get(&target.connection_id) != Some(&target.platform)
            || !match &draft.scope {
                ConfigScope::Local => false,
                ConfigScope::Profile(platform) => *platform == target.platform,
                ConfigScope::Device(id) => id == &target.connection_id,
            }
        {
            return Err(error(
                "sample_binding",
                "Draft sample requires a registered target in the selected scope",
            ));
        }
        let candidate = self
            .candidate(&state, draft)
            .map_err(|mut diagnostics| diagnostics.remove(0))?;
        let catalog = self.scoped_catalog(&state, &candidate, &draft.scope)?;
        let template = catalog
            .templates
            .get(parser_id)
            .filter(|asset| asset.platform == target.platform)
            .ok_or_else(|| {
                error(
                    "template_missing",
                    "Draft sample parser is not a validated candidate asset",
                )
            })?;
        if !catalog.widgets.values().any(|widget| matches!(&widget.source, WidgetSource::Ssh { commands, templates }
            if commands.get(&target.platform) == Some(&template.command) && templates.get(&target.platform).is_some_and(|id| id == parser_id))) {
            return Err(error("sample_binding", "Draft sample parser has no admitted widget binding"));
        }
        super::policy::CommandPolicy::admit(target.platform, &template.command)?;
        Ok(DraftSamplePlan {
            workspace: workspace.into(),
            generation,
            base: state.revision.clone(),
            source: effective(self.network_catalog(&state.overrides, target, true)).revision,
            scope: draft.scope.clone(),
            target: target.clone(),
            template: template.clone(),
            origin: DefinitionValidator::draft_hash(draft),
        })
    }

    pub(crate) fn seal_draft_sample(
        &self,
        plan: DraftSamplePlan,
        capture: &Capture,
    ) -> Result<DraftCaptureProof, Diagnostic> {
        let state = self.lock();
        if state.revision != plan.base
            || effective(self.network_catalog(&state.overrides, &plan.target, true)).revision
                != plan.source
            || capture.revision != plan.source
            || capture.target_id != plan.target.connection_id
        {
            return Err(error(
                "sample_binding",
                "Draft sample admission became obsolete during collection",
            ));
        }
        validate_binding(capture, &plan.template)?;
        Ok(DraftCaptureProof {
            workspace: plan.workspace,
            generation: plan.generation,
            base: plan.base,
            source: plan.source,
            scope: plan.scope,
            target: plan.target,
            command: capture.command.clone(),
            capture_id: capture.capture_id.clone(),
            parser_id: capture.parser_id.clone(),
            raw_hash: hash(capture.raw.as_bytes()),
            observed_at_ms: capture.observed_at_ms,
            monotonic_ms: capture.monotonic_ms,
            origin: plan.origin,
            template_hash: plan.template.sha256,
        })
    }

    pub(crate) async fn preview_owned(
        &self,
        workspace_id: &str,
        generation: u64,
        draft: &ConfigDraft,
        captures: Vec<Capture>,
        local_samples: Vec<LocalSample>,
        proofs: Vec<DraftCaptureProof>,
        retained_bytes: usize,
    ) -> PreviewReport {
        let mut report = PreviewReport {
            token: None,
            frames: vec![],
            diagnostics: vec![],
        };
        let attempt = uuid::Uuid::new_v4().to_string();
        let prepared = {
            let mut state = self.lock();
            state.previews.retain(|_, grant| {
                grant.workspace_id != workspace_id && grant.token.expires_at_ms > self.now()
            });
            state.attempts.insert(workspace_id.into(), attempt.clone());
            self.candidate(&state, draft).and_then(|candidate| {
                let catalog = self
                    .scoped_catalog(&state, &candidate, &draft.scope)
                    .map_err(|d| vec![d])?;
                let mut source_revisions = BTreeMap::new();
                let mut source_catalogs = BTreeMap::new();
                for capture in &captures {
                    if !source_revisions.contains_key(&capture.target_id) {
                        if let Some(platform) = state.targets.get(&capture.target_id) {
                            let target = TargetRef {
                                connection_id: capture.target_id.clone(),
                                platform: *platform,
                            };
                            let source = self.network_catalog(&state.overrides, &target, true);
                            source_revisions.insert(
                                target.connection_id.clone(),
                                effective(source.clone()).revision,
                            );
                            source_catalogs.insert(target.connection_id, source);
                        }
                    }
                }
                let local_revision = effective(self.local_catalog(&state.overrides)).revision;
                Ok((
                    catalog,
                    state.targets.clone(),
                    source_revisions,
                    local_revision,
                    source_catalogs,
                    state.revision.clone(),
                ))
            })
        };
        let (catalog, targets, source_revisions, local_revision, source_catalogs, base) =
            match prepared {
                Ok(value) => value,
                Err(diagnostics) => {
                    report.diagnostics = diagnostics;
                    return report;
                }
            };
        let source_context = PreviewSourceContext {
            catalogs: &source_catalogs,
            revisions: &source_revisions,
            workspace: workspace_id,
            generation,
            base: &base,
            scope: &draft.scope,
            proofs: &proofs,
            retained_bytes,
        };
        let captures = match preview_interpretations(captures, &catalog, &source_context) {
            Ok(captures) => captures,
            Err(diagnostic) => {
                report.diagnostics.push(diagnostic);
                return report;
            }
        };
        if workspace_id.is_empty() {
            report.diagnostics.push(error(
                "workspace",
                "Preview requires a backend workspace identity",
            ));
            return report;
        }
        let mut budget = ByteBudget::default();
        if let Err(diagnostic) = budget.reserve(retained_bytes) {
            report.diagnostics.push(diagnostic);
            return report;
        }
        let mut sample_hashes = BTreeMap::new();
        for capture in &captures {
            if source_revisions.get(&capture.target_id) != Some(&capture.revision)
                || capture.raw.len() > 2 * 1024 * 1024
                || [&capture.capture_id, &capture.target_id, &capture.command, &capture.parser_id].iter().any(|id| id.is_empty() || id.len() > 512)
                || capture.observed_at_ms < 0
                || targets.get(&capture.target_id) != Some(&capture.platform)
                || !catalog.templates.get(&capture.parser_id).is_some_and(|template| template.platform == capture.platform && template.command == capture.command)
                || !catalog.widgets.values().any(|widget| matches!(&widget.source, WidgetSource::Ssh { commands, templates } if commands.get(&capture.platform) == Some(&capture.command) && templates.get(&capture.platform) == Some(&capture.parser_id)))
                || matches!(draft.scope, ConfigScope::Profile(platform) if capture.platform != platform)
                || matches!(&draft.scope, ConfigScope::Device(id) if capture.target_id != *id)
            {
                report.diagnostics.push(error(
                    "sample_binding",
                    "Capture revision, target or size is invalid",
                ));
                return report;
            }
            let capture_hash = match sample_hash(capture, &mut budget) {
                Ok(hash) => hash,
                Err(d) => {
                    report.diagnostics.push(d);
                    return report;
                }
            };
            if let Err(d) =
                budget.reserve(256usize.saturating_add(capture.capture_id.len().saturating_mul(12)))
            {
                report.diagnostics.push(d);
                return report;
            }
            if sample_hashes
                .insert(
                    format!("capture:{}:{}", capture.capture_id, capture.parser_id),
                    capture_hash,
                )
                .is_some()
            {
                report.diagnostics.push(error(
                    "sample_identity",
                    "Capture identities must be unique",
                ));
                return report;
            }
        }
        for (index, sample) in local_samples.iter().enumerate() {
            if !matches!(draft.scope, ConfigScope::Local)
                || sample.observed_at_ms < 0
                || sample.sources.keys().any(|id| {
                    !matches!(
                        id.as_str(),
                        "local.cpu"
                            | "local.memory"
                            | "local.filesystems"
                            | "local.network"
                            | "local.processes"
                    )
                })
            {
                report.diagnostics.push(error(
                    "sample_binding",
                    "Local sample has invalid scope, timestamp or collector IDs",
                ));
                return report;
            }
            if sample
                .sources
                .values()
                .any(|rows| rows.len() > MAX_FRAME_ROWS)
            {
                report
                    .diagnostics
                    .push(error("sample_limit", "Local source exceeds the row limit"));
                return report;
            }
            match sample_hash(sample, &mut budget) {
                Ok(hash) => {
                    if let Err(d) = budget.reserve(512) {
                        report.diagnostics.push(d);
                        return report;
                    }
                    sample_hashes.insert(format!("local:{index}"), hash);
                }
                Err(d) => {
                    report.diagnostics.push(d);
                    return report;
                }
            }
        }
        // Candidate validation already checked bindings before platform filtering.
        let parsed = match (
            parse_document::<WidgetDocument>(&draft.widgets_yaml),
            parse_document::<LayoutDocument>(&draft.layouts_yaml),
        ) {
            (Ok(widgets), Ok(layouts)) => (widgets, layouts),
            (Err(d), _) | (_, Err(d)) => {
                report.diagnostics.push(d);
                return report;
            }
        };
        let mut selected: BTreeSet<String> =
            parsed.0.widgets.iter().map(|w| w.widget.clone()).collect();
        for layout in &parsed.1.layouts {
            for entry in layout.sections.iter().flat_map(|s| &s.rows).flatten() {
                selected.insert(entry.widget.clone());
            }
        }
        for widget in catalog.widgets.values() {
            if let WidgetSource::Ssh { templates, .. } = &widget.source {
                if templates
                    .values()
                    .any(|id| draft.templates.contains_key(id))
                {
                    selected.insert(widget.widget.clone());
                }
            }
        }
        let mut tested_templates = BTreeSet::new();
        for id in selected {
            let Some(definition) = catalog.widgets.get(&id) else {
                report
                    .diagnostics
                    .push(error("widget_missing", "Preview widget is missing"));
                return report;
            };
            let mut matched = false;
            let mut baseline: BTreeMap<String, (usize, u64)> = BTreeMap::new();
            match &definition.source {
                WidgetSource::Local { collector } => {
                    for sample in &local_samples {
                        if !sample.sources.contains_key(collector.as_str()) {
                            continue;
                        }
                        matched = true;
                        let context = FrameContext {
                            workspace_id: workspace_id.into(),
                            target_id: "local".into(),
                            revision: local_revision.clone(),
                            generation,
                        };
                        let previous = baseline
                            .get("local")
                            .map(|(index, at)| (report.frames[*index].rows.as_slice(), *at));
                        let frame = FrameNormalizer::local_bounded(
                            &context,
                            definition,
                            sample,
                            previous,
                            MAX_WORKSPACE_BYTES.saturating_sub(budget.used),
                        );
                        if frame.state == CollectionState::Failed {
                            admit_frame(&mut report, frame, &mut budget);
                            return report;
                        }
                        if sample.diagnostics.iter().any(|diagnostic| {
                            local_diagnostic_blocks(diagnostic, *collector, &frame)
                        }) {
                            report.diagnostics.push(error(
                                "sample_diagnostic",
                                "Local sample contains collection diagnostics",
                            ));
                            return report;
                        }
                        if !admit_frame(&mut report, frame, &mut budget) {
                            return report;
                        }
                        baseline.insert(
                            "local".into(),
                            (report.frames.len() - 1, sample.monotonic_ms),
                        );
                    }
                }
                WidgetSource::Ssh {
                    commands,
                    templates,
                } => {
                    for capture in &captures {
                        if commands.get(&capture.platform) != Some(&capture.command)
                            || templates.get(&capture.platform) != Some(&capture.parser_id)
                        {
                            continue;
                        }
                        if matches!(draft.scope, ConfigScope::Profile(p) if p != capture.platform)
                            || matches!(&draft.scope, ConfigScope::Device(id) if id != &capture.target_id)
                        {
                            continue;
                        }
                        matched = true;
                        let Some(template) = catalog.templates.get(&capture.parser_id) else {
                            report
                                .diagnostics
                                .push(error("template_missing", "Preview template is missing"));
                            return report;
                        };
                        if MAX_WORKSPACE_BYTES.saturating_sub(budget.used) < 2 * 1024 * 1024 {
                            report.diagnostics.push(error(
                                "sample_limit",
                                "Preview has no memory budget for another parser result",
                            ));
                            return report;
                        }
                        if let Some((_, diagnostic)) =
                            ProtocolClassifier::capture_rejection(capture)
                        {
                            report.diagnostics.push(diagnostic);
                            return report;
                        }
                        let records = match self
                            .parser
                            .parse_preview(capture, template, CancellationToken::new())
                            .await
                        {
                            Ok(rows) => rows,
                            Err(d) => {
                                report.diagnostics.push(d);
                                return report;
                            }
                        };
                        let retained_bytes = budget.used;
                        if let Err(d) = sample_hash(&records, &mut budget) {
                            report.diagnostics.push(d);
                            return report;
                        }
                        tested_templates.insert(template.id.clone());
                        let context = FrameContext {
                            workspace_id: workspace_id.into(),
                            target_id: capture.target_id.clone(),
                            revision: capture.revision.clone(),
                            generation,
                        };
                        let previous = baseline
                            .get(&capture.target_id)
                            .map(|(index, at)| (report.frames[*index].rows.as_slice(), *at));
                        let frame = ProtocolClassifier::normalize_bounded(
                            &context,
                            definition,
                            capture,
                            records,
                            previous,
                            MAX_WORKSPACE_BYTES.saturating_sub(budget.used),
                        );
                        budget.used = retained_bytes;
                        if !admit_frame(&mut report, frame, &mut budget) {
                            return report;
                        }
                        baseline.insert(
                            capture.target_id.clone(),
                            (report.frames.len() - 1, capture.monotonic_ms),
                        );
                    }
                }
            }
            if !matched {
                report.diagnostics.push(Diagnostic::new(
                    "fixture_missing",
                    "Every previewed widget needs an explicit matching sample",
                    id,
                ));
                return report;
            }
        }
        if draft
            .templates
            .keys()
            .any(|id| !tested_templates.contains(id))
        {
            report.diagnostics.push(error(
                "fixture_missing",
                "Every changed template needs an explicit parser sample",
            ));
            return report;
        }
        if !report.diagnostics.is_empty() {
            return report;
        }
        tokio::task::yield_now().await;
        let mut state = self.lock();
        if state.revision != draft.expected_revision
            || state.attempts.get(workspace_id) != Some(&attempt)
        {
            report.diagnostics.push(error(
                "preview_stale",
                "A newer preview or revision superseded this job",
            ));
            return report;
        }
        let token = PreviewToken {
            id: uuid::Uuid::new_v4().to_string(),
            draft_hash: DefinitionValidator::draft_hash(draft),
            base_revision: state.revision.clone(),
            sample_hashes,
            expires_at_ms: self.now().saturating_add(300_000),
        };
        state.previews.insert(
            token.id.clone(),
            PreviewGrant {
                workspace_id: workspace_id.into(),
                generation,
                token: token.clone(),
            },
        );
        report.token = Some(token);
        report
    }

    pub fn apply(
        &self,
        workspace_id: &str,
        generation: u64,
        draft: ConfigDraft,
        token: PreviewToken,
    ) -> Result<ApplyResult, Diagnostic> {
        let mut state = self.lock();
        let grant = state
            .previews
            .get(&token.id)
            .ok_or_else(|| error("preview_token", "Preview token is unknown or superseded"))?;
        if grant.token != token
            || grant.workspace_id != workspace_id
            || grant.generation != generation
            || token.expires_at_ms <= self.now()
            || token.base_revision != state.revision
            || token.draft_hash != DefinitionValidator::draft_hash(&draft)
        {
            return Err(error(
                "preview_token",
                "Preview token is expired or does not match this context, draft and revision",
            ));
        }
        let candidate = self
            .candidate(&state, &draft)
            .map_err(|mut diagnostics| diagnostics.remove(0))?;
        let (affected_targets, masked_device_overrides) =
            self.affected(&state, &candidate, &draft.scope);
        let revision = self.revision(&candidate)?;
        let pointer = self.persist(&candidate, state.pointer.as_deref())?;
        state.overrides = candidate;
        state.revision = revision.clone();
        state.pointer = Some(pointer);
        state.previews.clear();
        state.attempts.clear();
        Ok(ApplyResult {
            revision,
            affected_targets,
            masked_device_overrides,
        })
    }

    fn candidate(
        &self,
        state: &RepositoryState,
        draft: &ConfigDraft,
    ) -> Result<Overrides, Vec<Diagnostic>> {
        if draft.expected_revision != state.revision {
            return Err(vec![error(
                "revision_conflict",
                "Draft is based on another revision",
            )]);
        }
        let inherited = self.inherited(state, &draft.scope).map_err(|d| vec![d])?;
        let mut current = self
            .scoped_catalog(state, &state.overrides, &draft.scope)
            .map_err(|d| vec![d])?;
        for (id, template) in &self.builtin.templates {
            current
                .templates
                .entry(id.clone())
                .or_insert_with(|| template.clone());
        }
        let (widgets, layouts) = DefinitionValidator.parse(draft, &current)?;
        if let Some(platform) = self
            .scope_platform(state, &draft.scope)
            .map_err(|d| vec![d])?
        {
            if widgets.widgets.iter().any(|w| !matches!(&w.source, WidgetSource::Ssh { commands, .. } if commands.contains_key(&platform))) { return Err(vec![error("source_binding", "Widget must support the selected target platform")]); }
        }
        let mut overlay = Catalog {
            widgets: widgets
                .widgets
                .into_iter()
                .map(|w| (w.widget.clone(), w))
                .collect(),
            layouts: layouts
                .layouts
                .into_iter()
                .map(|l| (l.layout.clone(), l))
                .collect(),
            templates: BTreeMap::new(),
        };
        for (id, text) in &draft.templates {
            let binding = overlay
                .widgets
                .values()
                .chain(current.widgets.values())
                .find_map(|widget| match &widget.source {
                    WidgetSource::Ssh {
                        commands,
                        templates,
                    } => templates
                        .iter()
                        .find(|(_, name)| *name == id)
                        .map(|(platform, _)| (*platform, commands[platform].clone())),
                    _ => None,
                });
            let (platform, command) = binding
                .or_else(|| {
                    current
                        .templates
                        .get(id)
                        .map(|asset| (asset.platform, asset.command.clone()))
                })
                .ok_or_else(|| {
                    vec![error(
                        "template_binding",
                        "Template must have an explicit widget source binding",
                    )]
                })?;
            overlay.templates.insert(
                id.clone(),
                TemplateAsset {
                    id: id.clone(),
                    platform,
                    command,
                    text: text.clone(),
                    sha256: hash(text.as_bytes()),
                },
            );
        }
        for asset in &draft.reset_assets {
            let matches = match asset {
                ResetAsset::Widget(id) => {
                    overlay.widgets.get(id).is_some()
                        && overlay.widgets.get(id) == inherited.widgets.get(id)
                }
                ResetAsset::Layout(id) => {
                    overlay.layouts.get(id).is_some()
                        && overlay.layouts.get(id) == inherited.layouts.get(id)
                }
                ResetAsset::Template(id) => {
                    overlay.templates.get(id).is_some()
                        && overlay.templates.get(id) == inherited.templates.get(id)
                }
            };
            if !matches {
                return Err(vec![error("reset_mismatch", "Reset asset must exactly match its inherited definition; clear reset intent before editing")]);
            }
        }
        let mut candidate = state.overrides.clone();
        let platform = self
            .scope_platform(state, &draft.scope)
            .map_err(|d| vec![d])?;
        let stored = match &draft.scope {
            ConfigScope::Local => &mut candidate.local,
            ConfigScope::Profile(platform) => candidate.profiles.entry(*platform).or_default(),
            ConfigScope::Device(id) => {
                &mut candidate
                    .devices
                    .entry(id.clone())
                    .or_insert_with(|| DeviceOverride {
                        platform: platform.expect("device scope has a platform"),
                        assets: Catalog::default(),
                    })
                    .assets
            }
        };
        merge(stored, &overlay);
        for asset in &draft.reset_assets {
            match asset {
                ResetAsset::Widget(id) => {
                    stored.widgets.remove(id);
                }
                ResetAsset::Layout(id) => {
                    stored.layouts.remove(id);
                }
                ResetAsset::Template(id) => {
                    stored.templates.remove(id);
                }
            }
        }
        self.validate_all(&candidate).map_err(|d| vec![d])?;
        self.revision(&candidate).map_err(|d| vec![d])?;
        Ok(candidate)
    }

    fn scope_platform(
        &self,
        state: &RepositoryState,
        scope: &ConfigScope,
    ) -> Result<Option<Platform>, Diagnostic> {
        match scope {
            ConfigScope::Local => Ok(None),
            ConfigScope::Profile(platform) => Ok(Some(*platform)),
            ConfigScope::Device(id) => state.targets.get(id).copied().map(Some).ok_or_else(|| {
                error(
                    "target_unknown",
                    "Device scope needs a backend-known target reference",
                )
            }),
        }
    }
    fn inherited(
        &self,
        state: &RepositoryState,
        scope: &ConfigScope,
    ) -> Result<Catalog, Diagnostic> {
        Ok(match scope {
            ConfigScope::Local => filter_catalog(&self.builtin, None),
            ConfigScope::Profile(platform) => filter_catalog(&self.builtin, Some(*platform)),
            ConfigScope::Device(id) => {
                let platform = self.scope_platform(state, scope)?.expect("device platform");
                self.network_catalog(
                    &state.overrides,
                    &TargetRef {
                        connection_id: id.clone(),
                        platform,
                    },
                    false,
                )
            }
        })
    }
    fn scoped_catalog(
        &self,
        state: &RepositoryState,
        overrides: &Overrides,
        scope: &ConfigScope,
    ) -> Result<Catalog, Diagnostic> {
        Ok(match scope {
            ConfigScope::Local => self.local_catalog(overrides),
            ConfigScope::Profile(platform) => self.network_catalog(
                overrides,
                &TargetRef {
                    connection_id: String::new(),
                    platform: *platform,
                },
                false,
            ),
            ConfigScope::Device(id) => self.network_catalog(
                overrides,
                &TargetRef {
                    connection_id: id.clone(),
                    platform: self.scope_platform(state, scope)?.expect("device platform"),
                },
                true,
            ),
        })
    }
    fn local_catalog(&self, overrides: &Overrides) -> Catalog {
        let mut catalog = filter_catalog(&self.builtin, None);
        merge(&mut catalog, &overrides.local);
        catalog
    }
    fn network_catalog(&self, overrides: &Overrides, target: &TargetRef, device: bool) -> Catalog {
        let mut catalog = filter_catalog(&self.builtin, Some(target.platform));
        if let Some(overlay) = overrides.profiles.get(&target.platform) {
            merge(&mut catalog, overlay);
        }
        if device {
            if let Some(overlay) = overrides
                .devices
                .get(&target.connection_id)
                .filter(|d| d.platform == target.platform)
            {
                merge(&mut catalog, &overlay.assets);
            }
        }
        filter_catalog(&catalog, Some(target.platform))
    }
    fn validate_all(&self, overrides: &Overrides) -> Result<(), Diagnostic> {
        check_catalog_identity(&self.builtin)?;
        validate_scope_assets(&overrides.local, None)?;
        for (platform, assets) in &overrides.profiles {
            validate_scope_assets(assets, Some(*platform))?;
        }
        for (id, device) in &overrides.devices {
            if id.is_empty() || id == "local" {
                return Err(error(
                    "target_reference",
                    "Stored device ID must be nonempty and nonlocal",
                ));
            }
            validate_scope_assets(&device.assets, Some(device.platform))?;
        }
        validate_catalog(&self.local_catalog(overrides), ConfigScope::Local)?;
        for platform in [Platform::Ios, Platform::Iosxe] {
            validate_catalog(
                &self.network_catalog(
                    overrides,
                    &TargetRef {
                        connection_id: String::new(),
                        platform,
                    },
                    false,
                ),
                ConfigScope::Profile(platform),
            )?;
        }
        for (id, device) in &overrides.devices {
            validate_catalog(
                &self.network_catalog(
                    overrides,
                    &TargetRef {
                        connection_id: id.clone(),
                        platform: device.platform,
                    },
                    true,
                ),
                ConfigScope::Device(id.clone()),
            )?;
        }
        Ok(())
    }
    fn affected(
        &self,
        state: &RepositoryState,
        candidate: &Overrides,
        scope: &ConfigScope,
    ) -> (Vec<String>, Vec<String>) {
        if matches!(scope, ConfigScope::Local) {
            return (
                if self.local_catalog(&state.overrides) != self.local_catalog(candidate) {
                    vec!["local".into()]
                } else {
                    vec![]
                },
                vec![],
            );
        }
        let mut affected = vec![];
        let mut masked = vec![];
        for (id, platform) in &state.targets {
            let target = TargetRef {
                connection_id: id.clone(),
                platform: *platform,
            };
            let before = self.network_catalog(&state.overrides, &target, true);
            let after = self.network_catalog(candidate, &target, true);
            if before != after {
                affected.push(id.clone());
            }
            if matches!(scope, ConfigScope::Profile(p) if p == platform) {
                let lower_before = self.network_catalog(&state.overrides, &target, false);
                let lower_after = self.network_catalog(candidate, &target, false);
                if state
                    .overrides
                    .devices
                    .get(id)
                    .is_some_and(|d| masks_changed(&d.assets, &lower_before, &lower_after))
                {
                    masked.push(id.clone());
                }
            }
        }
        (affected, masked)
    }
    fn revision(&self, overrides: &Overrides) -> Result<String, Diagnostic> {
        bounded_hash(&RevisionBundle {
            builtin_hash: bounded_hash(&self.builtin)?,
            overrides,
        })
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, RepositoryState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    fn now(&self) -> i64 {
        #[cfg(test)]
        {
            let now = self.test_now.load(std::sync::atomic::Ordering::SeqCst);
            if now != 0 {
                return now;
            }
        }
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
            .unwrap_or(0)
    }
    fn persist(
        &self,
        overrides: &Overrides,
        expected_pointer: Option<&str>,
    ) -> Result<String, Diagnostic> {
        #[cfg(test)]
        if let Some(pause) = self.publication_pause.lock().unwrap().clone() {
            use std::sync::atomic::Ordering;
            pause.0.store(true, Ordering::SeqCst);
            while !pause.1.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        fs::create_dir_all(self.root.join("revisions")).map_err(io_error)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root.join("apply.lock"))
            .map_err(io_error)?;
        lock.try_lock().map_err(|_| {
            error(
                "revision_busy",
                "Another configuration publication owns the repository",
            )
        })?;
        if read_pointer(&self.root)?.as_deref() != expected_pointer {
            return Err(error(
                "revision_conflict",
                "Durable revision changed; reload configuration before applying",
            ));
        }
        let mut bytes = Vec::new();
        serde_json::to_writer(
            &mut BoundedWriter {
                writer: &mut bytes,
                remaining: MAX_WORKSPACE_BYTES,
            },
            &RevisionBundle {
                builtin_hash: bounded_hash(&self.builtin)?,
                overrides,
            },
        )
        .map_err(|_| error("config_limit", "Revision exceeds the memory limit"))?;
        let revision = hash(&bytes);
        let directory = self.root.join("revisions").join(&revision);
        fs::create_dir_all(&directory).map_err(io_error)?;
        let bundle = directory.join("bundle.json");
        if bundle.exists() {
            if read_bounded(&bundle, MAX_WORKSPACE_BYTES)? != bytes {
                return Err(error(
                    "revision_corrupt",
                    "Existing content-addressed bundle differs",
                ));
            }
        } else {
            atomic_write(&bundle, &bytes)?;
        }
        #[cfg(test)]
        if self.fail_write.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(error("config_io", "Injected publication failure"));
        }
        atomic_write(&self.root.join("current"), revision.as_bytes())?;
        Ok(revision)
    }
}

fn preview_interpretations(
    captures: Vec<Capture>,
    candidate: &Catalog,
    context: &PreviewSourceContext<'_>,
) -> Result<Vec<Capture>, Diagnostic> {
    let mut physical: BTreeMap<String, Capture> = BTreeMap::new();
    let mut bytes = context.retained_bytes;
    let mut identities = BTreeSet::new();
    for capture in captures {
        if matches!(context.scope, ConfigScope::Local)
            || matches!(context.scope, ConfigScope::Profile(platform) if capture.platform != *platform)
            || matches!(context.scope, ConfigScope::Device(target) if capture.target_id != *target)
        {
            return Err(error(
                "sample_binding",
                "Physical capture is outside the candidate scope",
            ));
        }
        bytes = bytes.saturating_add(capture.raw.len()).saturating_add(4096);
        if bytes > MAX_WORKSPACE_BYTES {
            return Err(error(
                "sample_limit",
                "Physical samples exceed the available workspace memory",
            ));
        }
        if !identities.insert((capture.capture_id.clone(), capture.parser_id.clone())) {
            return Err(error(
                "sample_identity",
                "Capture/parser identity must be unique",
            ));
        }
        if context.revisions.get(&capture.target_id) != Some(&capture.revision) {
            return Err(error(
                "sample_binding",
                "Physical capture source revision is obsolete",
            ));
        }
        if let Some(proof) = context
            .proofs
            .iter()
            .find(|proof| proof.capture_id == capture.capture_id)
        {
            if !proof.matches(&capture, context) {
                return Err(error(
                    "sample_binding",
                    "Owned draft capture proof is stale or does not match this context",
                ));
            }
        } else {
            let source = context.catalogs.get(&capture.target_id).and_then(|source| source.templates.get(&capture.parser_id))
                .ok_or_else(|| error("sample_binding", "Physical capture parser is not a current source asset or sealed draft sample"))?;
            validate_binding(&capture, source)?;
        }
        if let Some(before) = physical.get(&capture.capture_id) {
            if before.target_id != capture.target_id
                || before.platform != capture.platform
                || before.command != capture.command
                || before.revision != capture.revision
                || before.observed_at_ms != capture.observed_at_ms
                || before.monotonic_ms != capture.monotonic_ms
                || before.raw != capture.raw
            {
                return Err(error(
                    "sample_identity",
                    "Physical capture identity has conflicting observations",
                ));
            }
        } else {
            physical.insert(capture.capture_id.clone(), capture);
        }
    }
    let mut interpretations = vec![];
    for capture in physical.into_values() {
        let parsers: BTreeSet<_> = candidate
            .widgets
            .values()
            .filter_map(|widget| match &widget.source {
                WidgetSource::Ssh {
                    commands,
                    templates,
                } if commands.get(&capture.platform) == Some(&capture.command) => {
                    templates.get(&capture.platform)
                }
                _ => None,
            })
            .collect();
        // Source/proof, scope and physical identity checks above apply even when
        // this candidate no longer uses the retained command.
        for parser in parsers {
            bytes = bytes.saturating_add(capture.raw.len()).saturating_add(4096);
            if bytes > MAX_WORKSPACE_BYTES {
                return Err(error(
                    "sample_limit",
                    "Candidate capture interpretations exceed the memory limit",
                ));
            }
            let mut derived = capture.clone();
            derived.parser_id = parser.clone();
            let template = candidate
                .templates
                .get(parser)
                .ok_or_else(|| error("template_missing", "Candidate parser is missing"))?;
            validate_binding(&derived, template)?;
            interpretations.push(derived);
        }
    }
    Ok(interpretations)
}

fn error(code: &str, message: &str) -> Diagnostic {
    Diagnostic::new(code, message, "configuration")
}
fn io_error(_: std::io::Error) -> Diagnostic {
    error("config_io", "Configuration storage operation failed")
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn merge(base: &mut Catalog, overlay: &Catalog) {
    base.widgets.extend(overlay.widgets.clone());
    base.layouts.extend(overlay.layouts.clone());
    base.templates.extend(overlay.templates.clone());
}
fn effective(catalog: Catalog) -> EffectiveConfig {
    let mut writer = HashWriter(Sha256::new());
    serde_json::to_writer(&mut writer, &catalog)
        .expect("validated asset catalogs serialize to JSON");
    EffectiveConfig {
        revision: format!("{:x}", writer.0.finalize()),
        widgets: catalog.widgets.into_values().collect(),
        layouts: catalog.layouts.into_values().collect(),
        templates: catalog.templates,
    }
}
fn filter_catalog(catalog: &Catalog, platform: Option<Platform>) -> Catalog {
    Catalog {
        widgets: catalog
            .widgets
            .iter()
            .filter(|(_, w)| match (&w.source, platform) {
                (WidgetSource::Local { .. }, None) => true,
                (WidgetSource::Ssh { commands, .. }, Some(p)) => commands.contains_key(&p),
                _ => false,
            })
            .map(|(id, w)| {
                let mut widget = w.clone();
                if let (
                    WidgetSource::Ssh {
                        commands,
                        templates,
                    },
                    Some(p),
                ) = (&mut widget.source, platform)
                {
                    commands.retain(|key, _| *key == p);
                    templates.retain(|key, _| *key == p);
                }
                (id.clone(), widget)
            })
            .collect(),
        layouts: catalog
            .layouts
            .iter()
            .filter(|(_, l)| {
                platform
                    .map(|p| l.platforms.contains(&p))
                    .unwrap_or(l.platforms.is_empty())
            })
            .map(|(id, l)| (id.clone(), l.clone()))
            .collect(),
        templates: catalog
            .templates
            .iter()
            .filter(|(_, t)| Some(t.platform) == platform)
            .map(|(id, t)| (id.clone(), t.clone()))
            .collect(),
    }
}
fn validate_catalog(catalog: &Catalog, scope: ConfigScope) -> Result<(), Diagnostic> {
    check_catalog_identity(catalog)?;
    for (id, asset) in &catalog.templates {
        if id != &asset.id || hash(asset.text.as_bytes()) != asset.sha256 {
            return Err(error(
                "template_hash",
                "Template asset content or identity does not match its checksum",
            ));
        }
    }
    let draft = ConfigDraft {
        scope,
        widgets_yaml: serde_yaml::to_string(&WidgetDocument {
            schema_version: 1,
            widgets: catalog.widgets.values().cloned().collect(),
        })
        .map_err(|_| error("encoding", "Cannot encode widgets"))?,
        layouts_yaml: serde_yaml::to_string(&LayoutDocument {
            schema_version: 1,
            layouts: catalog.layouts.values().cloned().collect(),
        })
        .map_err(|_| error("encoding", "Cannot encode layouts"))?,
        templates: catalog
            .templates
            .iter()
            .map(|(id, asset)| (id.clone(), asset.text.clone()))
            .collect(),
        expected_revision: String::new(),
        reset_assets: vec![],
    };
    DefinitionValidator
        .parse(&draft, catalog)
        .map(|_| ())
        .map_err(|mut diagnostics| diagnostics.remove(0))
}
fn check_catalog_identity(catalog: &Catalog) -> Result<(), Diagnostic> {
    if catalog.widgets.values().any(|widget| matches!(&widget.source, WidgetSource::Ssh { commands, templates } if commands.is_empty() || !commands.keys().eq(templates.keys()))) {
        return Err(error("source_binding", "SSH commands and templates must bind the same nonempty platforms"));
    }
    if catalog
        .widgets
        .iter()
        .any(|(id, widget)| id != &widget.widget)
        || catalog
            .layouts
            .iter()
            .any(|(id, layout)| id != &layout.layout)
    {
        return Err(error(
            "asset_identity",
            "Catalog key does not match the asset identity",
        ));
    }
    Ok(())
}
fn validate_scope_assets(catalog: &Catalog, platform: Option<Platform>) -> Result<(), Diagnostic> {
    check_catalog_identity(catalog)?;
    if catalog
        .widgets
        .values()
        .any(|widget| match (&widget.source, platform) {
            (WidgetSource::Local { .. }, None) => false,
            (WidgetSource::Ssh { commands, .. }, Some(p)) => !commands.contains_key(&p),
            _ => true,
        })
        || catalog
            .templates
            .values()
            .any(|asset| Some(asset.platform) != platform)
        || catalog.layouts.values().any(|layout| {
            platform
                .map(|p| !layout.platforms.contains(&p))
                .unwrap_or(!layout.platforms.is_empty())
        })
    {
        return Err(error(
            "scope",
            "Stored assets do not support their configuration scope",
        ));
    }
    Ok(())
}
fn masks_changed(overlay: &Catalog, before: &Catalog, after: &Catalog) -> bool {
    overlay
        .widgets
        .keys()
        .any(|id| before.widgets.get(id) != after.widgets.get(id))
        || overlay
            .layouts
            .keys()
            .any(|id| before.layouts.get(id) != after.layouts.get(id))
        || overlay
            .templates
            .keys()
            .any(|id| before.templates.get(id) != after.templates.get(id))
}
fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>, Diagnostic> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(io_error)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > limit {
        return Err(error(
            "config_limit",
            "Configuration file exceeds its size limit",
        ));
    }
    Ok(bytes)
}
fn read_pointer(root: &Path) -> Result<Option<String>, Diagnostic> {
    let file = match fs::File::open(root.join("current")) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_error(e)),
    };
    let mut bytes = Vec::new();
    file.take(65).read_to_end(&mut bytes).map_err(io_error)?;
    let pointer = String::from_utf8(bytes)
        .map_err(|_| error("revision_corrupt", "Current revision is not a checksum"))?;
    if !valid_hash(&pointer) {
        return Err(error(
            "revision_corrupt",
            "Current revision is not a checksum",
        ));
    }
    Ok(Some(pointer))
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), Diagnostic> {
    let temp = path.with_file_name(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(io_error)
}
struct BoundedWriter<W> {
    writer: W,
    remaining: usize,
}
impl<W: Write> Write for BoundedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.remaining {
            return Err(std::io::Error::other("memory limit"));
        }
        self.writer.write_all(bytes)?;
        self.remaining -= bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.writer.flush()
    }
}
#[derive(Default)]
struct ByteBudget {
    used: usize,
}
impl ByteBudget {
    fn reserve(&mut self, bytes: usize) -> Result<(), Diagnostic> {
        self.used = self.used.saturating_add(bytes);
        if self.used > MAX_WORKSPACE_BYTES {
            return Err(error(
                "sample_limit",
                "Preview metadata exceeds the memory limit",
            ));
        }
        Ok(())
    }
}
struct HashWriter(Sha256);
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn sample_hash(value: &impl Serialize, budget: &mut ByteBudget) -> Result<String, Diagnostic> {
    let mut writer = BoundedWriter {
        writer: HashWriter(Sha256::new()),
        remaining: MAX_WORKSPACE_BYTES.saturating_sub(budget.used),
    };
    let available = writer.remaining;
    serde_json::to_writer(&mut writer, value).map_err(|_| {
        error(
            "sample_limit",
            "Preview inputs and output exceed the memory limit",
        )
    })?;
    budget.used += available - writer.remaining;
    Ok(format!("{:x}", writer.writer.0.finalize()))
}
fn bounded_hash(value: &impl Serialize) -> Result<String, Diagnostic> {
    sample_hash(value, &mut ByteBudget::default())
}
fn local_diagnostic_blocks(
    diagnostic: &Diagnostic,
    collector: LocalCollector,
    frame: &WidgetFrame,
) -> bool {
    let known_source = [
        LocalCollector::Cpu,
        LocalCollector::Memory,
        LocalCollector::Filesystems,
        LocalCollector::Network,
        LocalCollector::Processes,
    ]
    .into_iter()
    .any(|source| source.as_str() == diagnostic.path);
    if !known_source {
        return true;
    }
    if diagnostic.path != collector.as_str() {
        return false;
    }
    let partial = diagnostic.code == "local_rows_disappeared"
        || (diagnostic.code == "local_process_access_limited"
            && collector == LocalCollector::Processes);
    // Fresh rows have already passed composite-key and arithmetic validation.
    !partial || frame.state != CollectionState::Fresh || frame.rows.is_empty()
}

fn admit_frame(report: &mut PreviewReport, frame: WidgetFrame, budget: &mut ByteBudget) -> bool {
    if frame.state == CollectionState::Failed {
        report.diagnostics.extend(frame.diagnostics);
        return false;
    }
    if let Err(d) = sample_hash(&frame, budget) {
        report.diagnostics.push(d);
        return false;
    }
    report.frames.push(frame);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    const TEMPLATE: &str =
        "Value IFACE (\\S+)\nValue BYTES (\\d+)\n\nStart\n  ^${IFACE} ${BYTES} -> Record\n";
    fn network(title: &str) -> WidgetDefinition {
        serde_yaml::from_str(&format!("widget: traffic\ntitle: {title}\nsource: {{kind: ssh, commands: {{iosxe: show interfaces}}, templates: {{iosxe: traffic}}}}\ninterval: 30\nkey: [interface]\nfields: {{interface: [iface], bytes: [bytes]}}\nview: {{type: stat, field: bits, aggregation: first, label: Traffic}}\nrates: {{bits: {{field: bytes, multiplier: 8}}}}\ncomputes: {{twice: bits * 2}}\n")).unwrap()
    }
    fn builtin() -> Catalog {
        let widget = network("Builtin");
        Catalog {
            widgets: BTreeMap::from([("traffic".into(), widget)]),
            layouts: BTreeMap::new(),
            templates: BTreeMap::from([(
                "traffic".into(),
                TemplateAsset {
                    id: "traffic".into(),
                    platform: Platform::Iosxe,
                    command: "show interfaces".into(),
                    text: TEMPLATE.into(),
                    sha256: hash(TEMPLATE.as_bytes()),
                },
            )]),
        }
    }
    fn target(id: &str) -> TargetRef {
        TargetRef {
            connection_id: id.into(),
            platform: Platform::Iosxe,
        }
    }
    fn repository(root: &Path) -> TelemetryConfigRepository {
        let repo = TelemetryConfigRepository::load(
            root.into(),
            builtin(),
            Arc::new(TelemetryParser::new()),
        )
        .unwrap();
        repo.register_targets(&[target("one"), target("two")])
            .unwrap();
        repo
    }
    fn draft(repo: &TelemetryConfigRepository, scope: ConfigScope, title: &str) -> ConfigDraft {
        ConfigDraft {
            scope,
            widgets_yaml: serde_yaml::to_string(&WidgetDocument {
                schema_version: 1,
                widgets: vec![network(title)],
            })
            .unwrap(),
            layouts_yaml: "schema_version: 1\nlayouts: []".into(),
            templates: BTreeMap::new(),
            expected_revision: repo.base_revision(),
            reset_assets: vec![],
        }
    }
    fn captures(revision: &str) -> Vec<Capture> {
        [1000, 2000]
            .into_iter()
            .map(|at| Capture {
                capture_id: format!("sample{at}"),
                target_id: "one".into(),
                platform: Platform::Iosxe,
                command: "show interfaces".into(),
                parser_id: "traffic".into(),
                revision: revision.into(),
                observed_at_ms: at as i64,
                monotonic_ms: at,
                raw: format!("Gi1 {}\n", if at == 1000 { u64::MAX - 2 } else { u64::MAX }),
            })
            .collect()
    }
    #[tokio::test]
    async fn preview_coalesced_interpretations_preserve_physical_identity() {
        let directory = tempfile::tempdir().unwrap();
        let mut catalog = builtin();
        let mut alternate = catalog.widgets["traffic"].clone();
        alternate.widget = "alternate".into();
        if let WidgetSource::Ssh { templates, .. } = &mut alternate.source {
            templates.insert(Platform::Iosxe, "alternate".into());
        }
        let mut asset = catalog.templates["traffic"].clone();
        asset.id = "alternate".into();
        catalog.templates.insert(asset.id.clone(), asset);
        catalog.widgets.insert(alternate.widget.clone(), alternate);
        let widgets = catalog.widgets.values().cloned().collect();
        let repo = TelemetryConfigRepository::load(
            directory.path().into(),
            catalog,
            Arc::new(TelemetryParser::new()),
        )
        .unwrap();
        repo.register_targets(&[target("one")]).unwrap();
        let mut draft = draft(&repo, ConfigScope::Profile(Platform::Iosxe), "Traffic");
        draft.widgets_yaml = serde_yaml::to_string(&WidgetDocument {
            schema_version: 1,
            widgets,
        })
        .unwrap();
        let source = captures(&repo.effective(&target("one")).revision);
        let mut interpretations = source.clone();
        interpretations.extend(source.iter().cloned().map(|mut capture| {
            capture.parser_id = "alternate".into();
            capture
        }));
        let preview = repo
            .preview("ws", 1, &draft, interpretations.clone(), vec![])
            .await;
        assert!(preview.token.is_some(), "{:?}", preview.diagnostics);
        assert_eq!(preview.frames.len(), 4);
        assert_eq!(preview.frames[1].rows, preview.frames[3].rows);
        interpretations[2].raw.push_str("different");
        let conflict = repo.preview("ws", 1, &draft, interpretations, vec![]).await;
        assert!(conflict.token.is_none());
        assert!(conflict
            .diagnostics
            .iter()
            .any(|d| d.code == "sample_identity"));
        let duplicate = repo
            .preview(
                "ws",
                1,
                &draft,
                vec![source[0].clone(), source[0].clone()],
                vec![],
            )
            .await;
        assert!(duplicate.token.is_none());
        repo.parser.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn review_unused_source_samples_are_checked_before_candidate_filtering() {
        let directory = tempfile::tempdir().unwrap();
        let repo = repository(directory.path());
        let mut draft = draft(&repo, ConfigScope::Device("one".into()), "Changed command");
        draft.widgets_yaml = draft
            .widgets_yaml
            .replace("show interfaces", "show version")
            .replace("iosxe: traffic", "iosxe: new.version");
        draft
            .templates
            .insert("new.version".into(), TEMPLATE.into());
        let old = captures(&repo.effective(&target("one")).revision).remove(0);
        assert!(repo
            .preview("ws", 1, &draft, vec![old.clone()], vec![])
            .await
            .token
            .is_none());
        let plan = repo
            .prepare_draft_sample("ws", 1, &target("one"), &draft, "new.version")
            .unwrap();
        let request = plan.request().unwrap();
        let mut fresh = old.clone();
        fresh.capture_id = "new-command".into();
        fresh.command = request.command.as_str().into();
        fresh.parser_id = request.parser_id;
        let proof = repo.seal_draft_sample(plan, &fresh).unwrap();
        let preview = repo
            .preview_owned(
                "ws",
                1,
                &draft,
                vec![old.clone(), fresh.clone()],
                vec![],
                vec![proof.clone()],
                0,
            )
            .await;
        assert!(preview.token.is_some(), "{:?}", preview.diagnostics);
        assert!(preview
            .frames
            .iter()
            .all(|frame| frame.revision == old.revision));
        let mut foreign = old.clone();
        foreign.target_id = "two".into();
        let mut obsolete = old.clone();
        obsolete.revision = "obsolete".into();
        let mut unknown_parser = old.clone();
        unknown_parser.parser_id = "unknown".into();
        let mut oversized = old.clone();
        oversized.raw = "x".repeat(2 * 1024 * 1024 + 1);
        let mut bad_time = old.clone();
        bad_time.observed_at_ms = -1;
        let mut empty_id = old.clone();
        empty_id.capture_id.clear();
        let mut bad_platform = old.clone();
        bad_platform.platform = Platform::Ios;
        for bad in [
            foreign,
            obsolete,
            unknown_parser,
            oversized,
            bad_time,
            empty_id,
            bad_platform,
        ] {
            let rejected = repo
                .preview_owned(
                    "ws",
                    1,
                    &draft,
                    vec![bad, fresh.clone()],
                    vec![],
                    vec![proof.clone()],
                    0,
                )
                .await;
            assert!(
                rejected.token.is_none(),
                "unused malformed/foreign samples must still fail"
            );
        }
        let duplicate = repo
            .preview_owned(
                "ws",
                1,
                &draft,
                vec![old.clone(), old, fresh],
                vec![],
                vec![proof],
                0,
            )
            .await;
        assert!(duplicate.token.is_none());
        assert!(duplicate
            .diagnostics
            .iter()
            .any(|d| d.code == "sample_identity"));
        repo.parser.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn draft_capture_proofs_reject_wrong_context_base_raw_and_command() {
        let directory = tempfile::tempdir().unwrap();
        let repo = repository(directory.path());
        let mut draft = draft(&repo, ConfigScope::Profile(Platform::Iosxe), "Draft source");
        draft.widgets_yaml = draft
            .widgets_yaml
            .replace("show interfaces", "show version")
            .replace("iosxe: traffic", "iosxe: new.version");
        draft
            .templates
            .insert("new.version".into(), TEMPLATE.into());
        let plan = repo
            .prepare_draft_sample("ws", 1, &target("one"), &draft, "new.version")
            .unwrap();
        let request = plan.request().unwrap();
        let mut capture = captures(&request.revision).remove(0);
        capture.command = request.command.as_str().into();
        capture.parser_id = request.parser_id;
        let proof = repo.seal_draft_sample(plan, &capture).unwrap();
        let report = repo
            .preview_owned(
                "ws",
                1,
                &draft,
                vec![capture.clone()],
                vec![],
                vec![proof.clone()],
                0,
            )
            .await;
        assert!(report.token.is_some(), "{:?}", report.diagnostics);
        let mut wrong_base = proof.clone();
        wrong_base.base = "0".repeat(64);
        let mut wrong_scope = proof.clone();
        wrong_scope.scope = ConfigScope::Device("one".into());
        let mut changed_raw = capture.clone();
        changed_raw.raw.push_str("private changed bytes");
        let mut changed_command = capture.clone();
        changed_command.command = "show inventory".into();
        for (workspace, generation, capture, proof) in [
            ("other", 1, capture.clone(), proof.clone()),
            ("ws", 2, capture.clone(), proof.clone()),
            ("ws", 1, capture.clone(), wrong_base),
            ("ws", 1, capture.clone(), wrong_scope),
            ("ws", 1, changed_raw, proof.clone()),
            ("ws", 1, changed_command, proof.clone()),
        ] {
            let report = repo
                .preview_owned(
                    workspace,
                    generation,
                    &draft,
                    vec![capture],
                    vec![],
                    vec![proof],
                    0,
                )
                .await;
            assert!(report.token.is_none());
            assert!(report
                .diagnostics
                .iter()
                .any(|d| d.code == "sample_binding"));
        }
        let report = repo
            .preview_owned(
                "ws",
                1,
                &draft,
                vec![capture],
                vec![],
                vec![proof],
                MAX_WORKSPACE_BYTES,
            )
            .await;
        assert!(report.token.is_none());
        assert!(report.diagnostics.iter().any(|d| d.code == "sample_limit"));
        repo.parser.shutdown().await.unwrap();
    }
    async fn token(repo: &TelemetryConfigRepository, draft: &ConfigDraft) -> PreviewToken {
        let preview = repo
            .preview(
                "ws",
                1,
                draft,
                captures(&repo.effective(&target("one")).revision),
                vec![],
            )
            .await;
        assert!(preview.diagnostics.is_empty(), "{:?}", preview.diagnostics);
        preview.token.unwrap()
    }

    #[test]
    fn invalid_draft_keeps_effective_revision() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(dir.path());
        let target = target("one");
        let before = repo.effective(&target).revision;
        let mut draft = draft(&repo, ConfigScope::Profile(Platform::Iosxe), "Valid");
        draft.widgets_yaml.push_str("unknown: true\n");
        let report = repo.validate(&draft);
        assert!(!report.valid);
        assert_eq!(repo.effective(&target).revision, before);
    }
    #[tokio::test]
    async fn stale_preview_token_cannot_apply() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(dir.path());
        let draft = draft(&repo, ConfigScope::Profile(Platform::Iosxe), "A");
        let old_token = token(&repo, &draft).await;
        let mut changed_draft = draft.clone();
        changed_draft.widgets_yaml = changed_draft.widgets_yaml.replace("title: A", "title: B");
        assert!(repo
            .apply("ws", 1, changed_draft, old_token.clone())
            .is_err());
        assert!(repo
            .apply("other", 1, draft.clone(), old_token.clone())
            .is_err());
        assert!(repo
            .apply("ws", 2, draft.clone(), old_token.clone())
            .is_err());
        let mut forged = old_token.clone();
        forged
            .sample_hashes
            .insert("capture:sample1000".into(), "changed".into());
        assert!(repo.apply("ws", 1, draft.clone(), forged).is_err());
        let mut changed_template = draft.clone();
        changed_template
            .templates
            .insert("traffic".into(), format!("{TEMPLATE}\n"));
        assert!(repo
            .apply("ws", 1, changed_template, old_token.clone())
            .is_err());
        repo.test_now.store(
            old_token.expires_at_ms + 1,
            std::sync::atomic::Ordering::SeqCst,
        );
        assert!(repo.apply("ws", 1, draft, old_token).is_err());
        repo.parser.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn profile_override_precedence_and_affected_targets() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(dir.path());
        let device = draft(&repo, ConfigScope::Device("one".into()), "Device");
        repo.apply("ws", 1, device.clone(), token(&repo, &device).await)
            .unwrap();
        let profile = draft(&repo, ConfigScope::Profile(Platform::Iosxe), "Profile");
        let masked_before = repo.effective(&target("one"));
        let affected_before = repo.effective(&target("two"));
        let report = repo.validate(&profile);
        assert_eq!(report.affected_targets, vec!["two"]);
        assert_eq!(report.masked_device_overrides, vec!["one"]);
        let applied = repo
            .apply("ws", 1, profile.clone(), token(&repo, &profile).await)
            .unwrap();
        assert_eq!(applied.affected_targets, vec!["two"]);
        assert_eq!(repo.effective(&target("one")).widgets[0].title, "Device");
        assert_eq!(repo.effective(&target("two")).widgets[0].title, "Profile");
        assert_eq!(
            repo.effective(&target("one")).revision,
            masked_before.revision
        );
        assert_ne!(
            repo.effective(&target("two")).revision,
            affected_before.revision
        );
        let loaded = repository(dir.path());
        assert_eq!(
            loaded.effective(&target("one")),
            repo.effective(&target("one"))
        );
        repo.parser.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn atomic_save_failure_keeps_old_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(dir.path());
        let a = draft(&repo, ConfigScope::Profile(Platform::Iosxe), "A");
        repo.apply("ws", 1, a.clone(), token(&repo, &a).await)
            .unwrap();
        let before = repo.effective(&target("one"));
        let pointer = fs::read(dir.path().join("telemetry/current")).unwrap();
        let b = draft(&repo, ConfigScope::Profile(Platform::Iosxe), "B");
        let preview = token(&repo, &b).await;
        repo.fail_write
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(repo.apply("ws", 1, b, preview).is_err());
        assert_eq!(repo.effective(&target("one")), before);
        assert_eq!(
            fs::read(dir.path().join("telemetry/current")).unwrap(),
            pointer
        );
        assert_eq!(repository(dir.path()).effective(&target("one")), before);
        repo.parser.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn reset_loads_draft_without_applying() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(dir.path());
        let mut a = draft(&repo, ConfigScope::Device("one".into()), "Custom");
        let mut custom = network("Unrelated custom widget");
        custom.widget = "z_custom".into();
        a.widgets_yaml = serde_yaml::to_string(&WidgetDocument {
            schema_version: 1,
            widgets: vec![network("Custom"), custom],
        })
        .unwrap();
        repo.apply("ws", 1, a.clone(), token(&repo, &a).await)
            .unwrap();
        let reset = repo
            .reset_draft(
                ConfigScope::Device("one".into()),
                ResetAsset::Widget("traffic".into()),
            )
            .unwrap();
        assert_eq!(repo.effective(&target("one")).widgets[0].title, "Custom");
        let mut edited = reset.clone();
        edited.widgets_yaml = edited.widgets_yaml.replace("Builtin", "Edited");
        assert!(!repo.validate(&edited).valid);
        repo.apply("ws", 1, reset.clone(), token(&repo, &reset).await)
            .unwrap();
        let profile = draft(
            &repo,
            ConfigScope::Profile(Platform::Iosxe),
            "UpdatedProfile",
        );
        repo.apply("ws", 1, profile.clone(), token(&repo, &profile).await)
            .unwrap();
        assert_eq!(
            repo.effective(&target("one")).widgets[0].title,
            "UpdatedProfile"
        );
        assert!(repo
            .effective(&target("one"))
            .widgets
            .iter()
            .any(|w| w.widget == "z_custom"));
        assert!(repo
            .reset_draft(
                ConfigScope::Profile(Platform::Iosxe),
                ResetAsset::Widget("unknown".into())
            )
            .is_err());
        repo.parser.shutdown().await.unwrap();
    }
    #[test]
    fn external_import_never_hot_applies() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(dir.path());
        let before = repo.effective(&target("one"));
        let input = draft(&repo, ConfigScope::Profile(Platform::Iosxe), "Imported");
        let imported = repo
            .import_draft(
                input.scope,
                input.widgets_yaml,
                input.layouts_yaml,
                input.templates,
            )
            .unwrap();
        assert!(repo.validate(&imported).valid);
        assert_eq!(repo.effective(&target("one")), before);
        assert!(!dir.path().join("telemetry/current").exists());
    }
    #[tokio::test]
    async fn local_preview_needs_no_network_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(dir.path());
        let mut local = draft(&repo, ConfigScope::Local, "Unused");
        local.widgets_yaml = "schema_version: 1\nwidgets: [{widget: cpu, title: CPU, source: {kind: local, collector: local.cpu}, interval: 2, key: [], fields: {usage: [usage]}, view: {type: stat, field: usage, aggregation: first, label: CPU}}]".into();
        let sample = LocalSample {
            observed_at_ms: 10,
            monotonic_ms: 10,
            diagnostics: vec![],
            sources: BTreeMap::from([(
                "local.cpu".into(),
                vec![MetricRow {
                    key: String::new(),
                    fields: BTreeMap::from([("usage".into(), MetricValue::Number { value: 5.0 })]),
                }],
            )]),
        };
        let preview = repo
            .preview("local_ws", 12, &local, vec![], vec![sample])
            .await;
        assert!(preview.diagnostics.is_empty(), "{:?}", preview.diagnostics);
        assert_eq!(preview.frames[0].target_id, "local");
        assert_eq!(preview.frames[0].generation, 12);
        repo.apply("local_ws", 12, local, preview.token.unwrap())
            .unwrap();
        assert_eq!(repo.effective_local().widgets[0].widget, "cpu");
    }
    #[tokio::test]
    async fn preview_and_live_share_alias_rate_compute_pipeline() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(dir.path());
        let draft = draft(&repo, ConfigScope::Profile(Platform::Iosxe), "Preview");
        let samples = captures(&repo.effective(&target("one")).revision);
        let preview = repo.preview("ws", 1, &draft, samples.clone(), vec![]).await;
        assert!(preview.token.is_some(), "{:?}", preview.diagnostics);
        let ctx = FrameContext {
            workspace_id: "ws".into(),
            generation: 1,
            target_id: "one".into(),
            revision: samples[0].revision.clone(),
        };
        let def = network("Preview");
        let asset = &builtin().templates["traffic"];
        let first = FrameNormalizer::normalize(
            &ctx,
            &def,
            &samples[0],
            repo.parser
                .parse(&samples[0], asset, CancellationToken::new())
                .await
                .unwrap(),
            None,
        );
        let second = FrameNormalizer::normalize(
            &ctx,
            &def,
            &samples[1],
            repo.parser
                .parse(&samples[1], asset, CancellationToken::new())
                .await
                .unwrap(),
            Some((&first.rows, 1000)),
        );
        assert_eq!(preview.frames, vec![first, second]);
        assert_eq!(
            preview.frames[1].rows[0].fields["twice"],
            MetricValue::Number { value: 32.0 }
        );
        assert!(repo
            .preview("ws", 1, &draft, vec![], vec![])
            .await
            .token
            .is_none());
        repo.parser.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn changed_samples_and_failed_metadata_supersede_old_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(dir.path());
        let draft = draft(&repo, ConfigScope::Profile(Platform::Iosxe), "A");
        let old = token(&repo, &draft).await;
        let mut samples = captures(&repo.effective(&target("one")).revision);
        samples[1].raw = "Gi1 100\n".into();
        let newer = repo
            .preview("ws", 1, &draft, samples.clone(), vec![])
            .await
            .token
            .unwrap();
        assert_ne!(old.sample_hashes, newer.sample_hashes);
        assert!(repo.apply("ws", 1, draft.clone(), old).is_err());
        samples[0].command = "show version".into();
        assert!(repo
            .preview("ws", 1, &draft, samples, vec![])
            .await
            .token
            .is_none());
        assert!(repo.apply("ws", 1, draft, newer).is_err());
        repo.parser.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn partially_masked_target_is_also_affected() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(dir.path());
        let device = draft(&repo, ConfigScope::Device("one".into()), "Device");
        repo.apply("ws", 1, device.clone(), token(&repo, &device).await)
            .unwrap();
        let mut profile = draft(&repo, ConfigScope::Profile(Platform::Iosxe), "Profile");
        let mut additional = network("Additional");
        additional.widget = "additional".into();
        profile.widgets_yaml = serde_yaml::to_string(&WidgetDocument {
            schema_version: 1,
            widgets: vec![network("Profile"), additional],
        })
        .unwrap();
        let report = repo.validate(&profile);
        assert!(report.valid);
        assert_eq!(report.affected_targets, vec!["one", "two"]);
        assert_eq!(report.masked_device_overrides, vec!["one"]);
        repo.parser.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn multiplatform_widget_preview_uses_validated_draft_selection() {
        let dir = tempfile::tempdir().unwrap();
        let mut catalog = builtin();
        let definition = catalog.widgets.get_mut("traffic").unwrap();
        if let WidgetSource::Ssh {
            commands,
            templates,
        } = &mut definition.source
        {
            commands.insert(Platform::Ios, "show interfaces".into());
            templates.insert(Platform::Ios, "traffic_ios".into());
        }
        catalog.templates.insert(
            "traffic_ios".into(),
            TemplateAsset {
                id: "traffic_ios".into(),
                platform: Platform::Ios,
                command: "show interfaces".into(),
                text: TEMPLATE.into(),
                sha256: hash(TEMPLATE.as_bytes()),
            },
        );
        let mut both = network("Both");
        both.source = catalog.widgets["traffic"].source.clone();
        let repo = TelemetryConfigRepository::load(
            dir.path().into(),
            catalog,
            Arc::new(TelemetryParser::new()),
        )
        .unwrap();
        repo.register_targets(&[target("one")]).unwrap();
        let mut draft = draft(&repo, ConfigScope::Profile(Platform::Iosxe), "Unused");
        draft.widgets_yaml = serde_yaml::to_string(&WidgetDocument {
            schema_version: 1,
            widgets: vec![both],
        })
        .unwrap();
        assert!(repo.validate(&draft).valid);
        let preview = repo
            .preview(
                "ws",
                1,
                &draft,
                captures(&repo.effective(&target("one")).revision),
                vec![],
            )
            .await;
        assert!(preview.token.is_some(), "{:?}", preview.diagnostics);
        repo.parser.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn template_and_layout_reset_remove_only_selected_override_and_follow_upgrades() {
        let dir = tempfile::tempdir().unwrap();
        let mut catalog = builtin();
        let layout: LayoutDefinition = serde_yaml::from_str("layout: overview\nplatforms: [iosxe]\nsections: [{id: main, title: Builtin, rows: [[{widget: traffic, span: 12}]]}]").unwrap();
        catalog.layouts.insert("overview".into(), layout.clone());
        let repo = TelemetryConfigRepository::load(
            dir.path().into(),
            catalog.clone(),
            Arc::new(TelemetryParser::new()),
        )
        .unwrap();
        repo.register_targets(&[target("one")]).unwrap();
        let mut custom = draft(&repo, ConfigScope::Profile(Platform::Iosxe), "Custom");
        let mut custom_layout = layout.clone();
        custom_layout.sections[0].title = "Custom".into();
        custom.layouts_yaml = serde_yaml::to_string(&LayoutDocument {
            schema_version: 1,
            layouts: vec![custom_layout],
        })
        .unwrap();
        custom
            .templates
            .insert("traffic".into(), format!("{TEMPLATE}\n"));
        repo.apply("ws", 1, custom.clone(), token(&repo, &custom).await)
            .unwrap();
        for selected in [
            ResetAsset::Layout("overview".into()),
            ResetAsset::Template("traffic".into()),
        ] {
            let reset = repo
                .reset_draft(ConfigScope::Profile(Platform::Iosxe), selected)
                .unwrap();
            repo.apply("ws", 1, reset.clone(), token(&repo, &reset).await)
                .unwrap();
        }
        assert_eq!(repo.effective(&target("one")).widgets[0].title, "Custom");
        {
            let state = repo.lock();
            let stored = &state.overrides.profiles[&Platform::Iosxe];
            assert!(stored.layouts.is_empty());
            assert!(stored.templates.is_empty());
        }
        catalog.layouts.get_mut("overview").unwrap().sections[0].title =
            "New bundled default".into();
        let asset = catalog.templates.get_mut("traffic").unwrap();
        asset.text.push('\n');
        asset.sha256 = hash(asset.text.as_bytes());
        let upgraded = TelemetryConfigRepository::load(
            dir.path().into(),
            catalog,
            Arc::new(TelemetryParser::new()),
        )
        .unwrap();
        assert_eq!(
            upgraded.effective(&target("one")).layouts[0].sections[0].title,
            "New bundled default"
        );
        assert_eq!(
            upgraded.effective(&target("one")).widgets[0].title,
            "Custom"
        );
        assert_ne!(
            upgraded.effective(&target("one")).revision,
            repo.effective(&target("one")).revision
        );
        repo.parser.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn actual_alias_fanout_rejection_preserves_working_revision() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(dir.path());
        let valid = draft(&repo, ConfigScope::Profile(Platform::Iosxe), "Working");
        repo.apply("ws", 1, valid.clone(), token(&repo, &valid).await)
            .unwrap();
        let before = repo.effective(&target("one"));
        let pointer = fs::read(dir.path().join("telemetry/current")).unwrap();
        let mut large = draft(&repo, ConfigScope::Local, "Unused");
        let mut widget: WidgetDefinition = serde_yaml::from_str("widget: local_big\ntitle: Big\nsource: {kind: local, collector: local.cpu}\ninterval: 2\nkey: []\nfields: {value: [huge]}\nview: {type: stat, field: value, aggregation: first, label: Big}").unwrap();
        for n in 0..80 {
            widget
                .fields
                .insert(format!("copy{n}"), vec!["huge".into()]);
        }
        large.widgets_yaml = serde_yaml::to_string(&WidgetDocument {
            schema_version: 1,
            widgets: vec![widget],
        })
        .unwrap();
        let sample = LocalSample {
            observed_at_ms: 1,
            monotonic_ms: 1,
            diagnostics: vec![],
            sources: BTreeMap::from([(
                "local.cpu".into(),
                vec![MetricRow {
                    key: String::new(),
                    fields: BTreeMap::from([(
                        "huge".into(),
                        MetricValue::Text {
                            value: "x".repeat(1024 * 1024),
                        },
                    )]),
                }],
            )]),
        };
        let preview = repo.preview("ws", 1, &large, vec![], vec![sample]).await;
        assert!(preview.token.is_none());
        assert_eq!(preview.diagnostics[0].code, "normalization_limit");
        assert_eq!(repo.effective(&target("one")), before);
        assert_eq!(
            fs::read(dir.path().join("telemetry/current")).unwrap(),
            pointer
        );
        repo.parser.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn durable_compare_and_swap_and_os_lock_refuse_other_writers() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(dir.path());
        let other = repository(dir.path());
        let a = draft(&repo, ConfigScope::Profile(Platform::Iosxe), "A");
        let a_token = token(&repo, &a).await;
        let b = draft(&other, ConfigScope::Profile(Platform::Iosxe), "B");
        let b_token = token(&other, &b).await;
        fs::create_dir_all(dir.path().join("telemetry")).unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.path().join("telemetry/apply.lock"))
            .unwrap();
        lock.try_lock().unwrap();
        assert_eq!(
            other
                .apply("ws", 1, b.clone(), b_token.clone())
                .unwrap_err()
                .code,
            "revision_busy"
        );
        std::fs::File::unlock(&lock).unwrap();
        drop(lock);
        let applied = other.apply("ws", 1, b, b_token).unwrap();
        assert_eq!(
            String::from_utf8(fs::read(dir.path().join("telemetry/current")).unwrap()).unwrap(),
            applied.revision
        );
        assert_eq!(
            repo.apply("ws", 1, a, a_token).unwrap_err().code,
            "revision_conflict"
        );
        assert_eq!(repo.effective(&target("one")).widgets[0].title, "Builtin");
        assert_eq!(
            repository(dir.path()).effective(&target("one")).widgets[0].title,
            "B"
        );
        repo.parser.shutdown().await.unwrap();
        other.parser.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn newer_preview_fences_an_older_async_reply() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(dir.path());
        let mut local = draft(&repo, ConfigScope::Local, "Unused");
        local.widgets_yaml = "schema_version: 1\nwidgets: [{widget: cpu, title: CPU, source: {kind: local, collector: local.cpu}, interval: 2, key: [], fields: {usage: [usage]}, view: {type: stat, field: usage, aggregation: first, label: CPU}}]".into();
        let sample = LocalSample {
            observed_at_ms: 1,
            monotonic_ms: 1,
            diagnostics: vec![],
            sources: BTreeMap::from([(
                "local.cpu".into(),
                vec![MetricRow {
                    key: String::new(),
                    fields: BTreeMap::from([("usage".into(), MetricValue::Number { value: 5.0 })]),
                }],
            )]),
        };
        let (older, newer) = tokio::join!(
            repo.preview("ws", 1, &local, vec![], vec![sample.clone()]),
            repo.preview("ws", 2, &local, vec![], vec![sample])
        );
        assert!(older.token.is_none());
        assert_eq!(older.diagnostics[0].code, "preview_stale");
        assert!(newer.token.is_some());
    }
    #[test]
    fn atomic_pointer_replacement_and_corrupt_referenced_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let pointer = dir.path().join("current");
        atomic_write(&pointer, b"one").unwrap();
        atomic_write(&pointer, b"two").unwrap();
        assert_eq!(fs::read(&pointer).unwrap(), b"two");
        fs::create_dir_all(dir.path().join("telemetry/revisions").join("a".repeat(64))).unwrap();
        fs::write(dir.path().join("telemetry/current"), "a".repeat(64)).unwrap();
        fs::write(
            dir.path()
                .join("telemetry/revisions")
                .join("a".repeat(64))
                .join("bundle.json"),
            "corrupt",
        )
        .unwrap();
        assert!(TelemetryConfigRepository::load(
            dir.path().into(),
            builtin(),
            Arc::new(TelemetryParser::new())
        )
        .is_err());
    }
    #[test]
    fn corrupt_pointer_is_an_error_and_unreferenced_revisions_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("telemetry/revisions").join("b".repeat(64))).unwrap();
        let _repo = repository(dir.path());
        fs::write(dir.path().join("telemetry/current"), "../../outside").unwrap();
        assert!(TelemetryConfigRepository::load(
            dir.path().into(),
            builtin(),
            Arc::new(TelemetryParser::new())
        )
        .is_err());
    }
    fn local_fixture(repo: &TelemetryConfigRepository) -> (ConfigDraft, LocalSample) {
        let mut draft = draft(repo, ConfigScope::Local, "Unused");
        draft.widgets_yaml = "schema_version: 1\nwidgets: [{widget: cpu, title: CPU, source: {kind: local, collector: local.cpu}, interval: 2, key: [], fields: {usage: [usage]}, view: {type: stat, field: usage, aggregation: first, label: CPU}}]".into();
        (
            draft,
            LocalSample {
                observed_at_ms: 1,
                monotonic_ms: 1,
                diagnostics: vec![],
                sources: BTreeMap::from([(
                    "local.cpu".into(),
                    vec![MetricRow {
                        key: String::new(),
                        fields: BTreeMap::from([(
                            "usage".into(),
                            MetricValue::Number { value: 5.0 },
                        )]),
                    }],
                )]),
            },
        )
    }
    #[tokio::test]
    async fn local_quality_warnings_preserve_facts_without_granting_invalid_samples() {
        let directory = tempfile::tempdir().unwrap();
        let repo = repository(directory.path());
        let (draft, original) = local_fixture(&repo);
        for (code, path, valid) in [
            ("local_process_access_limited", "local.processes", true),
            ("local_rows_disappeared", "local.cpu", true),
            ("local_process_access_limited", "local.cpu", false),
            ("source_unavailable", "local.cpu", false),
            ("local_rows_disappeared", "local", false),
            ("local_rows_disappeared", "unknown", false),
        ] {
            let mut sample = original.clone();
            sample
                .diagnostics
                .push(Diagnostic::new(code, "Visible partial-data quality", path));
            let report = repo.preview("local", 1, &draft, vec![], vec![sample]).await;
            assert_eq!(
                report.token.is_some(),
                valid,
                "{code}/{path}: {:?}",
                report.diagnostics
            );
            if valid {
                assert!(report.frames[0]
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == code && diagnostic.path == path));
            }
        }
        let mut empty = original.clone();
        empty.sources.get_mut("local.cpu").unwrap().clear();
        empty.diagnostics.push(Diagnostic::new(
            "local_rows_disappeared",
            "No current facts",
            "local.cpu",
        ));
        assert!(repo
            .preview("empty", 1, &draft, vec![], vec![empty])
            .await
            .token
            .is_none());
        let mut invalid = draft.clone();
        invalid.widgets_yaml = invalid.widgets_yaml.replace("key: []", "key: [usage]");
        let mut sample = original;
        sample.sources.get_mut("local.cpu").unwrap()[0]
            .fields
            .clear();
        sample.diagnostics.push(Diagnostic::new(
            "local_rows_disappeared",
            "Missing keyed fact",
            "local.cpu",
        ));
        let report = repo
            .preview("missing", 1, &invalid, vec![], vec![sample])
            .await;
        assert!(report.token.is_none());
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "missing_key"));
        repo.parser.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn unrelated_scope_applies_preserve_effective_content_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(dir.path());
        let local_before = repo.effective_local();
        let network = draft(&repo, ConfigScope::Profile(Platform::Iosxe), "Network");
        repo.apply("ws", 1, network.clone(), token(&repo, &network).await)
            .unwrap();
        let local_after_network = repo.effective_local();
        let network_before_local = repo.effective(&target("one"));
        let (local, sample) = local_fixture(&repo);
        let preview = repo
            .preview("local_ws", 1, &local, vec![], vec![sample])
            .await;
        assert_eq!(preview.frames[0].revision, local_after_network.revision);
        repo.apply("local_ws", 1, local, preview.token.unwrap())
            .unwrap();
        assert_eq!(local_after_network, local_before);
        assert_eq!(repo.effective(&target("one")), network_before_local);
        repo.parser.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn preview_uses_source_content_revision_and_global_grant_authority() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repository(dir.path());
        let source_revision = {
            let state = repo.lock();
            bounded_hash(&repo.network_catalog(&state.overrides, &target("one"), true)).unwrap()
        };
        let mut network = draft(&repo, ConfigScope::Profile(Platform::Iosxe), "Network");
        let samples = captures(&source_revision);
        assert!(repo
            .preview(
                "ws",
                1,
                &network,
                captures(&network.expected_revision),
                vec![]
            )
            .await
            .token
            .is_none());
        let preview = repo
            .preview("ws", 1, &network, samples.clone(), vec![])
            .await;
        assert!(preview.token.is_some(), "{:?}", preview.diagnostics);
        assert!(preview
            .frames
            .iter()
            .all(|frame| frame.revision == source_revision));
        let old_token = preview.token.unwrap();
        assert_eq!(old_token.base_revision, network.expected_revision);
        let (local, sample) = local_fixture(&repo);
        let local_preview = repo
            .preview("local_ws", 1, &local, vec![], vec![sample])
            .await;
        repo.apply("local_ws", 1, local, local_preview.token.unwrap())
            .unwrap();
        assert!(repo.apply("ws", 1, network.clone(), old_token).is_err());
        network.expected_revision = repo.base_revision();
        let refreshed = repo
            .preview("ws", 1, &network, samples.clone(), vec![])
            .await;
        assert!(refreshed.token.is_some(), "{:?}", refreshed.diagnostics);
        repo.apply("ws", 1, network.clone(), refreshed.token.unwrap())
            .unwrap();
        network.expected_revision = repo.base_revision();
        assert!(repo
            .preview("ws", 1, &network, samples, vec![])
            .await
            .token
            .is_none());
        let fresh = captures(&repo.effective(&target("one")).revision);
        assert!(repo
            .preview("ws", 1, &network, fresh, vec![])
            .await
            .token
            .is_some());
        repo.parser.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn network_preview_preserves_protocol_classification_and_empty_rejection() {
        use crate::telemetry::catalog::ProtocolClassifier;
        let dir = tempfile::tempdir().unwrap();
        let builtin = Catalog::builtin().unwrap();
        let definition = builtin.widgets["bgp_peers"].clone();
        let repo = TelemetryConfigRepository::load(
            dir.path().into(),
            builtin,
            Arc::new(TelemetryParser::new()),
        )
        .unwrap();
        repo.register_targets(&[target("one")]).unwrap();
        let effective = repo.effective(&target("one"));
        let draft = repo
            .import_draft(
                ConfigScope::Profile(Platform::Iosxe),
                serde_yaml::to_string(&WidgetDocument {
                    schema_version: 1,
                    widgets: vec![definition.clone()],
                })
                .unwrap(),
                "schema_version: 1\nlayouts: []".into(),
                BTreeMap::new(),
            )
            .unwrap();
        let WidgetSource::Ssh {
            commands,
            templates,
        } = &definition.source
        else {
            panic!()
        };
        let asset = &effective.templates[&templates[&Platform::Iosxe]];
        let mut capture = Capture {
            capture_id: "bgp".into(),
            target_id: "one".into(),
            platform: Platform::Iosxe,
            command: commands[&Platform::Iosxe].clone(),
            parser_id: asset.id.clone(),
            revision: effective.revision.clone(),
            observed_at_ms: 1000,
            monotonic_ms: 1000,
            raw: include_str!("../../../sidecar/tests/telemetry/fixtures/bgp_summary.raw").into(),
        };
        let records = repo
            .parser
            .parse(&capture, asset, CancellationToken::new())
            .await
            .unwrap();
        let context = FrameContext {
            workspace_id: "protocol".into(),
            target_id: "one".into(),
            revision: effective.revision,
            generation: 3,
        };
        let expected =
            ProtocolClassifier::normalize(&context, &definition, &capture, records, None);
        let report = repo
            .preview("protocol", 3, &draft, vec![capture.clone()], vec![])
            .await;
        assert!(report.token.is_some(), "{:?}", report.diagnostics);
        assert_eq!(report.frames, vec![expected]);
        assert!(report.frames[0]
            .diagnostics
            .iter()
            .any(|d| d.code == "routing_context_missing"));
        assert!(report.frames[0].rows.iter().any(
            |r| matches!(&r.fields["state"],MetricValue::Text{value} if value=="Established")
        ));
        capture.capture_id = "empty".into();
        capture.raw.clear();
        let empty = repo
            .preview("protocol", 3, &draft, vec![capture], vec![])
            .await;
        assert!(empty.token.is_none());
        assert!(empty.diagnostics.iter().any(|d| d.code == "parse_mismatch"));
        repo.parser.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn network_preview_rejection_does_not_test_changed_templates_or_issue_apply_grants() {
        let dir = tempfile::tempdir().unwrap();
        let builtin = Catalog::builtin().unwrap();
        let definition = builtin.widgets["cpu"].clone();
        let asset = builtin.templates["iosxe.show_processes_cpu"].clone();
        let repo = TelemetryConfigRepository::load(
            dir.path().into(),
            builtin,
            Arc::new(TelemetryParser::new()),
        )
        .unwrap();
        repo.register_targets(&[target("one")]).unwrap();
        let mut draft = repo
            .import_draft(
                ConfigScope::Profile(Platform::Iosxe),
                serde_yaml::to_string(&WidgetDocument {
                    schema_version: 1,
                    widgets: vec![definition],
                })
                .unwrap(),
                "schema_version: 1\nlayouts: []".into(),
                BTreeMap::from([(
                    asset.id.clone(),
                    format!(
                        "{}\n# Changed template must be tested before Apply\n",
                        asset.text
                    ),
                )]),
            )
            .unwrap();
        assert!(repo.validate(&draft).valid);
        let before = repo.base_revision();
        for (index, raw, code) in [
            (
                0,
                "% Invalid input detected at '^' marker.",
                "command_unsupported",
            ),
            (1, "Command authorization failed.", "command_permission"),
        ] {
            let capture = Capture {
                capture_id: format!("reject{index}"),
                target_id: "one".into(),
                platform: Platform::Iosxe,
                command: asset.command.clone(),
                parser_id: asset.id.clone(),
                revision: repo.effective(&target("one")).revision,
                observed_at_ms: 1000,
                monotonic_ms: 1000,
                raw: raw.into(),
            };
            let report = repo
                .preview("rejected", 4, &draft, vec![capture.clone()], vec![])
                .await;
            assert!(report.token.is_none());
            assert!(report.frames.is_empty());
            assert!(
                report.diagnostics.iter().any(|d| d.code == code),
                "{:?}",
                report.diagnostics
            );
            // Invalid metadata must fail before interpreting device text.
            let mut wrong = capture;
            wrong.revision = "not-the-source-revision".into();
            let metadata = repo
                .preview("rejected", 4, &draft, vec![wrong], vec![])
                .await;
            assert_eq!(metadata.diagnostics[0].code, "sample_binding");
        }
        assert_eq!(repo.base_revision(), before);
        // No matching sample leaves the changed template untested; no token is manufactured.
        draft.widgets_yaml = "schema_version: 1\nwidgets: []".into();
        let untested = repo.preview("rejected", 4, &draft, vec![], vec![]).await;
        assert!(untested.token.is_none());
        assert!(untested
            .diagnostics
            .iter()
            .any(|d| d.code == "fixture_missing"));
        repo.parser.shutdown().await.unwrap();
    }
}
