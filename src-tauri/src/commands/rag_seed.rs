//! Plan 12 Phase 6 — `rag_run_seed_script` command.
//!
//! Spawns `scripts/seed-rag/seed.py` (an opt-in helper that downloads
//! vendor reference docs to `~/.ccie-terminal/rag-seed/`). The script
//! is **not** bundled with the app; we shell out to the system
//! `python3` (or to the bundled-sidecar interpreter when one is
//! present). Each `seed: ...` stdout line is forwarded to the UI as a
//! `rag://seed-progress` Tauri event so the React component can render
//! live progress without polling.
//!
//! Boundary recap (matches Phase 6 plan, option B):
//! - This command ONLY downloads files to disk.
//! - The UI iterates the seed dir afterwards and calls `rag_upload`
//!   for each file. Idempotency is enforced UI-side via
//!   `rag_list_documents`.

use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const SEED_PROGRESS_EVENT: &str = "rag://seed-progress";

#[derive(Debug, Clone, Serialize)]
pub struct SeedProgressEvent {
    /// Raw line from the script's stdout (`seed: ...`). The UI is
    /// allowed to parse the verb but it can also just render the
    /// final `done` line as a status string.
    pub line: String,
    /// Optional structured fields lifted from the line for the common
    /// shapes (`start`, `download`, `skip`, `error`, `done`). Anything
    /// the parser doesn't understand is omitted; the UI falls back to
    /// rendering `line` verbatim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verb: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SeedRunResult {
    pub exit_code: i32,
    pub seed_dir: String,
    pub script_path: String,
}

/// Locate the seed script on disk. Priority:
/// 1. `$CCIE_REPO_ROOT/scripts/seed-rag/seed.py` (dev / from-source).
/// 2. `<exe_dir>/scripts/seed-rag/seed.py` (sibling to the binary —
///    only present if the user manually copied the repo dir; we don't
///    bundle it).
/// 3. Walk upward from `current_exe()` looking for the same path.
fn locate_seed_script() -> Result<PathBuf, String> {
    if let Ok(repo_root) = std::env::var("CCIE_REPO_ROOT") {
        let p = PathBuf::from(repo_root)
            .join("scripts")
            .join("seed-rag")
            .join("seed.py");
        if p.is_file() {
            return Ok(p);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let mut probe = cwd.clone();
        for _ in 0..6 {
            let p = probe.join("scripts").join("seed-rag").join("seed.py");
            if p.is_file() {
                return Ok(p);
            }
            if !probe.pop() {
                break;
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut probe = exe.clone();
        for _ in 0..8 {
            if !probe.pop() {
                break;
            }
            let p = probe.join("scripts").join("seed-rag").join("seed.py");
            if p.is_file() {
                return Ok(p);
            }
        }
    }
    Err("Could not locate scripts/seed-rag/seed.py. \
         Set CCIE_REPO_ROOT to the repo root or run from a dev build."
        .to_string())
}

/// Pick the python interpreter to execute the seed script with. We
/// prefer the sidecar's bundled interpreter (or dev .venv) so the
/// `httpx` install matches what the rest of the app uses; we fall
/// back to system `python3`.
fn locate_python_interpreter() -> Result<String, String> {
    let (path, _args) = crate::commands::sidecar_spawn_target();
    if std::path::Path::new(&path).is_file() {
        return Ok(path);
    }
    // Fall back to the system interpreter. We don't probe with
    // `which`; the OS will surface ENOENT through `Command::spawn`
    // which we translate into a clearer error below.
    if cfg!(windows) {
        Ok("python.exe".to_string())
    } else {
        Ok("python3".to_string())
    }
}

fn parse_seed_line(line: &str) -> SeedProgressEvent {
    let mut ev = SeedProgressEvent {
        line: line.to_string(),
        verb: None,
        index: None,
        total: None,
    };
    if let Some(rest) = line.strip_prefix("seed:") {
        let mut parts = rest.split_whitespace();
        if let Some(verb) = parts.next() {
            ev.verb = Some(verb.to_string());
            // The next token after `start`/`download`/etc. is either
            // `total=N` or `i/N`. Try both shapes.
            if let Some(tok) = parts.next() {
                if let Some(n) = tok.strip_prefix("total=") {
                    if let Ok(t) = n.parse::<u32>() {
                        ev.total = Some(t);
                    }
                } else if let Some((i, t)) = tok.split_once('/') {
                    if let (Ok(i), Ok(t)) = (i.parse::<u32>(), t.parse::<u32>()) {
                        ev.index = Some(i);
                        ev.total = Some(t);
                    }
                }
            }
        }
    }
    ev
}

/// Resolve the seed-pack directory. Honors `CCIE_RAG_SEED_DIR` env var
/// for tests; falls back to `~/.ccie-terminal/rag-seed`.
fn resolve_seed_dir() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("CCIE_RAG_SEED_DIR") {
        let pb = PathBuf::from(p);
        std::fs::create_dir_all(&pb).map_err(|e| format!("create seed dir: {e}"))?;
        return Ok(pb);
    }
    let home = dirs::home_dir().ok_or("home dir not resolvable")?;
    let p = home.join(".ccie-terminal").join("rag-seed");
    std::fs::create_dir_all(&p).map_err(|e| format!("create seed dir: {e}"))?;
    Ok(p)
}

#[tauri::command]
pub async fn rag_run_seed_script(app: AppHandle) -> Result<SeedRunResult, String> {
    let script = locate_seed_script()?;
    let python = locate_python_interpreter()?;
    let seed_dir = resolve_seed_dir()?;

    let mut child = Command::new(&python)
        .arg(&script)
        .env("CCIE_RAG_SEED_DIR", &seed_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "python interpreter '{python}' not found. \
                     Install Python 3 (e.g. `brew install python3`) \
                     or build the sidecar (sidecar/scripts/build_sidecar.sh)."
                )
            } else {
                format!("spawn seed.py: {e}")
            }
        })?;

    // Drain stdout line-by-line, emitting events as we go. We also
    // capture stderr so a Python traceback surfaces in the result on
    // failure.
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "child stdout missing".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "child stderr missing".to_string())?;

    let app_for_stdout = app.clone();
    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let ev = parse_seed_line(&line);
            let _ = app_for_stdout.emit(SEED_PROGRESS_EVENT, &ev);
        }
    });
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut buf = String::new();
        while let Ok(Some(line)) = reader.next_line().await {
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    });

    // Bound the subprocess at 10 minutes. If `seed.py` ever wedges on a
    // network deadlock the UI must not stay stuck on "Downloading…"
    // forever. On timeout we kill the child; the streaming reader task
    // exits naturally once the stdout pipe closes.
    let status = match tokio::time::timeout(std::time::Duration::from_secs(600), child.wait()).await
    {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(format!("wait seed.py: {e}")),
        Err(_) => {
            let _ = child.kill().await;
            // Drain the reader tasks so their futures don't leak.
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err("seed script timed out after 10 minutes".to_string());
        }
    };
    let _ = stdout_task.await;
    let stderr_text = stderr_task.await.unwrap_or_default();

    let exit_code = status.code().unwrap_or(-1);
    if exit_code != 0 && !stderr_text.trim().is_empty() {
        // Surface stderr as a final synthetic line so the UI sees it.
        let line = format!(
            "seed: error 0/0 url=- message=stderr text={}",
            stderr_text.trim()
        );
        let ev = parse_seed_line(&line);
        let _ = app.emit(SEED_PROGRESS_EVENT, &ev);
    }

    Ok(SeedRunResult {
        exit_code,
        seed_dir: seed_dir.to_string_lossy().to_string(),
        script_path: script.to_string_lossy().to_string(),
    })
}

/// Companion command: list the files currently sitting in the seed
/// directory. The UI iterates this after `rag_run_seed_script`
/// returns and uploads each entry via the existing `rag_upload`. When
/// `manifest.json` (written by `seed.py`) exists, each row gets
/// hydrated with the proper title and tag set from `sources.json`;
/// otherwise we fall back to the filename stem and a `["generic"]`
/// tag set so a manually-dropped file still ingests cleanly.
#[derive(Debug, Serialize)]
pub struct SeedFile {
    pub path: String,
    pub filename: String,
    pub bytes: u64,
    pub kind: String,
    pub title: String,
    pub tags: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
struct ManifestEntry {
    title: String,
    tags: Vec<String>,
    #[serde(default)]
    #[allow(dead_code)]
    url: String,
    #[serde(default)]
    #[allow(dead_code)]
    kind: String,
}

fn read_manifest(dir: &std::path::Path) -> std::collections::HashMap<String, ManifestEntry> {
    let manifest_path = dir.join("manifest.json");
    if !manifest_path.is_file() {
        return std::collections::HashMap::new();
    }
    let text = match std::fs::read_to_string(&manifest_path) {
        Ok(t) => t,
        Err(_) => return std::collections::HashMap::new(),
    };
    serde_json::from_str(&text).unwrap_or_default()
}

#[tauri::command]
pub async fn rag_list_seed_files() -> Result<Vec<SeedFile>, String> {
    let dir = resolve_seed_dir()?;
    let manifest = read_manifest(&dir);
    let mut out = Vec::new();
    let read = std::fs::read_dir(&dir).map_err(|e| format!("read seed dir: {e}"))?;
    for entry in read.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let filename = p
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        // Skip the manifest itself.
        if filename == "manifest.json" {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        let kind = match ext.as_str() {
            "pdf" => "pdf",
            "html" | "htm" => "html",
            "md" | "markdown" => "md",
            "txt" => "txt",
            _ => continue, // unknown extensions can't be ingested
        };
        let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let (title, tags) = match manifest.get(&filename) {
            Some(m) => (m.title.clone(), m.tags.clone()),
            None => {
                // Fallback for manually-dropped files: derive a title
                // from the stem and tag as `generic` so the upload
                // doesn't fail on the empty-tags validation.
                let stem = p
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&filename)
                    .replace(['-', '_'], " ");
                (stem, vec!["generic".to_string()])
            }
        };
        out.push(SeedFile {
            path: p.to_string_lossy().to_string(),
            filename,
            bytes,
            kind: kind.to_string(),
            title,
            tags,
        });
    }
    out.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_start_line() {
        let ev = parse_seed_line("seed: start total=2");
        assert_eq!(ev.verb.as_deref(), Some("start"));
        assert_eq!(ev.total, Some(2));
        assert_eq!(ev.index, None);
    }

    #[test]
    fn parse_progress_line() {
        let ev = parse_seed_line("seed: download 1/2 url=https://example.com/x.pdf");
        assert_eq!(ev.verb.as_deref(), Some("download"));
        assert_eq!(ev.index, Some(1));
        assert_eq!(ev.total, Some(2));
    }

    #[test]
    fn parse_skip_line() {
        let ev = parse_seed_line("seed: skip 3/4 url=https://x reason=already-on-disk");
        assert_eq!(ev.verb.as_deref(), Some("skip"));
        assert_eq!(ev.index, Some(3));
        assert_eq!(ev.total, Some(4));
    }

    #[test]
    fn parse_unknown_line_passthrough() {
        let ev = parse_seed_line("hello world");
        assert_eq!(ev.line, "hello world");
        assert!(ev.verb.is_none());
        assert!(ev.index.is_none());
        assert!(ev.total.is_none());
    }

    /// Mirrors the timeout/kill pattern used in `rag_run_seed_script`.
    /// Spawns `sleep 60` and asserts the call returns Err with
    /// "timed out" well before 60 seconds elapse. If `sleep` is not
    /// available (very unlikely on Unix; absent on Windows) the test
    /// is skipped rather than failing the suite.
    #[tokio::test]
    async fn seed_subprocess_times_out_and_kills_child() {
        // `sleep` exists on every supported dev platform (macOS, Linux).
        // On Windows the equivalent isn't `sleep`, so just skip there —
        // the production code path is exercised via the macOS/Linux CI.
        if cfg!(windows) {
            return;
        }
        let spawn = tokio::process::Command::new("sleep")
            .arg("60")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        let mut child = match spawn {
            Ok(c) => c,
            Err(_) => return, // `sleep` missing — skip.
        };

        let started = std::time::Instant::now();
        let result: Result<(), String> =
            match tokio::time::timeout(std::time::Duration::from_secs(1), child.wait()).await {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(e)) => Err(format!("wait: {e}")),
                Err(_) => {
                    let _ = child.kill().await;
                    Err("seed script timed out after 10 minutes".to_string())
                }
            };
        let elapsed = started.elapsed();

        let err = result.expect_err("expected timeout error, got Ok");
        assert!(
            err.contains("timed out"),
            "error did not mention timeout: {err}"
        );
        // Sanity: must finish well under the `sleep 60` ceiling. The
        // 1s timeout itself eats ~1s; bound generously at 5s to avoid
        // CI flake but still prove the timeout fired (not the sleep).
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "timeout did not fire promptly; elapsed={elapsed:?}"
        );
    }
}
