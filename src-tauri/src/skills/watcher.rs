use super::loader::SkillsLoader;
use anyhow::Result;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, serde::Serialize)]
pub struct SkillReloadedEvent {
    pub skill_id: String,
}

pub struct SkillsWatcher {
    _watcher: RecommendedWatcher,
}

impl SkillsWatcher {
    pub fn new(
        skills_dir: PathBuf,
        loader: Arc<SkillsLoader>,
    ) -> Result<(Self, mpsc::Receiver<SkillReloadedEvent>)> {
        let (tx, rx) = mpsc::channel::<SkillReloadedEvent>(32);

        let skills_dir_clone = skills_dir.clone();
        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                        for path in &event.paths {
                            if let Some(skill_id) = extract_skill_id(&skills_dir_clone, path) {
                                if let Err(e) = loader.reload_skill(&skill_id) {
                                    eprintln!("Failed to reload skill '{}': {}", skill_id, e);
                                } else {
                                    let _ = tx.blocking_send(SkillReloadedEvent { skill_id });
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        })?;

        watcher.watch(&skills_dir, RecursiveMode::Recursive)?;

        Ok((Self { _watcher: watcher }, rx))
    }
}

/// Extract skill ID from a file path within the skills directory
fn extract_skill_id(skills_dir: &PathBuf, file_path: &Path) -> Option<String> {
    // Get the relative path from skills_dir
    let relative = file_path.strip_prefix(skills_dir).ok()?;

    // Get the first component (should be the skill directory name)
    let first_component = relative.components().next()?;

    // Convert to string
    first_component.as_os_str().to_str().map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_skill_id() {
        let skills_dir = PathBuf::from("/home/user/.ccie-terminal/skills");
        let file_path = PathBuf::from("/home/user/.ccie-terminal/skills/bgp-troubleshoot/SKILL.md");

        let skill_id = extract_skill_id(&skills_dir, &file_path);
        assert_eq!(skill_id, Some("bgp-troubleshoot".to_string()));
    }

    #[test]
    fn test_extract_skill_id_nested() {
        let skills_dir = PathBuf::from("/home/user/.ccie-terminal/skills");
        let file_path =
            PathBuf::from("/home/user/.ccie-terminal/skills/bgp-troubleshoot/scripts/check.sh");

        let skill_id = extract_skill_id(&skills_dir, &file_path);
        assert_eq!(skill_id, Some("bgp-troubleshoot".to_string()));
    }
}
