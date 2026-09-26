//! Target + endpoint catalog assembly. Lives between `manifest` / `openapi`
//! parsers and the Tauri command layer.

use super::manifest::{
    self, endpoints_from_manifest, load_dir, Endpoint, TargetManifest, TargetSummary,
};
use anyhow::Result;
use std::path::{Path, PathBuf};

/// Embedded built-in manifest files. Seeding is idempotent; we only write
/// the file if it doesn't exist, so user edits survive an app update unless
/// they explicitly use the "restore defaults" flow (Step 4).
const BUILTIN_FILES: &[(&str, &str)] = &[
    (
        "meraki.yaml",
        include_str!("../../resources/api-targets-builtin/meraki.yaml"),
    ),
    (
        "catalyst_center.yaml",
        include_str!("../../resources/api-targets-builtin/catalyst_center.yaml"),
    ),
    (
        "ise.yaml",
        include_str!("../../resources/api-targets-builtin/ise.yaml"),
    ),
    (
        "sna.yaml",
        include_str!("../../resources/api-targets-builtin/sna.yaml"),
    ),
];

/// Copy every built-in manifest into `builtin_dir`. Safe to call on every
/// app start.
///
/// Policy: **built-in files are authoritative.** If the file on disk differs
/// from the bundled copy (bug fix, new version, user edit), we overwrite it.
/// The `api-targets-builtin/` directory is considered app-owned. Users who
/// want to customize a target should put a separate YAML in the
/// neighboring `api-targets/` directory — `load_dir` loads both.
///
/// We don't touch files that don't appear in `BUILTIN_FILES` (so unknown
/// files a user drops into the builtin dir survive).
pub fn seed_builtin_manifests(builtin_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(builtin_dir)?;
    for (name, body) in BUILTIN_FILES {
        let dest = builtin_dir.join(name);
        let needs_write = match std::fs::read(&dest) {
            Ok(existing) => existing != body.as_bytes(),
            Err(_) => true,
        };
        if needs_write {
            std::fs::write(&dest, body)?;
        }
    }
    Ok(())
}

/// Summaries of every known target (builtin + user). The UI's TargetPicker
/// feeds off of this list.
pub struct LoadedTargets {
    pub builtin: Vec<(TargetManifest, PathBuf)>,
    pub user: Vec<(TargetManifest, PathBuf)>,
}

impl LoadedTargets {
    pub fn summaries(&self) -> Vec<TargetSummary> {
        let mut out = Vec::new();
        for (m, _) in &self.builtin {
            out.push(summarize(m, true));
        }
        for (m, _) in &self.user {
            out.push(summarize(m, false));
        }
        // Stable: builtins first, then users, alphabetical within each group.
        out
    }

    pub fn find(&self, id: &str) -> Option<&TargetManifest> {
        self.builtin
            .iter()
            .chain(self.user.iter())
            .find(|(m, _)| m.id == id)
            .map(|(m, _)| m)
    }
}

fn summarize(m: &TargetManifest, builtin: bool) -> TargetSummary {
    TargetSummary {
        id: m.id.clone(),
        display_name: m.display_name.clone(),
        base_url: m.base_url.clone(),
        builtin,
        has_openapi: m.openapi_url.is_some(),
        endpoint_count: m.endpoints.len(),
    }
}

/// Load both directories. Either may be missing.
pub fn load_all(builtin_dir: &Path, user_dir: &Path) -> Result<LoadedTargets> {
    let builtin = load_dir(builtin_dir)?;
    let user = load_dir(user_dir)?;
    Ok(LoadedTargets { builtin, user })
}

/// Endpoint catalog for one target. For Step 3 we use the inline list on the
/// manifest; OpenAPI-imported catalogs (via `api_import_openapi` command) are
/// returned directly to the frontend and stored in-memory per-tab.
pub fn catalog_for_manifest(m: &TargetManifest) -> Vec<Endpoint> {
    endpoints_from_manifest(m)
}

/// Convenience re-export so tests and command layer can reach the synth
/// helper without pulling in the full `manifest` module.
pub use manifest::synth_endpoint_id;
