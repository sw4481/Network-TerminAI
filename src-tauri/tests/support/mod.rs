use tempfile::TempDir;

pub struct SidecarTestCommand {
    pub program: String,
    pub args: Vec<String>,
    _home: TempDir,
}

impl SidecarTestCommand {
    pub fn new(program: String) -> Self {
        let home = tempfile::tempdir().expect("isolated sidecar home");
        // Configure only this child before importing the real sidecar entry point.
        let bootstrap = r#"
import os, runpy, sys
from pathlib import Path
home = Path(sys.argv[1])
os.environ.update(
    HOME=str(home), USERPROFILE=str(home),
    APPDATA=str(home / 'AppData' / 'Roaming'),
    LOCALAPPDATA=str(home / 'AppData' / 'Local'),
    XDG_CONFIG_HOME=str(home / '.config'),
    CCIE_LOG_DIR=str(home / 'logs'),
)
sys.argv = ['ccie_sidecar']
runpy.run_module('ccie_sidecar', run_name='__main__')
"#;
        Self {
            program,
            args: vec![
                "-c".into(),
                bootstrap.into(),
                home.path().to_string_lossy().into_owned(),
            ],
            _home: home,
        }
    }
}

#[test]
fn sidecar_fixture_isolates_child_config_and_keeps_home_until_exit() {
    let program = if cfg!(windows) { "python" } else { "python3" };
    let fixture = SidecarTestCommand::new(program.into());
    let home = fixture._home.path().to_path_buf();
    let parent = tempfile::tempdir().unwrap();
    let modules = tempfile::tempdir().unwrap();
    std::fs::write(
        modules.path().join("ccie_sidecar.py"),
        r#"
import os
from pathlib import Path
home = Path(os.environ['EXPECTED_TEST_HOME'])
assert Path.home() == home
for key, relative in [('USERPROFILE', ''), ('APPDATA', 'AppData/Roaming'), ('LOCALAPPDATA', 'AppData/Local'), ('XDG_CONFIG_HOME', '.config'), ('CCIE_LOG_DIR', 'logs')]:
    assert Path(os.environ[key]) == home / relative
(home / 'child-finished').touch()
"#,
    )
    .unwrap();
    let mut command = std::process::Command::new(&fixture.program);
    command
        .args(&fixture.args)
        .current_dir(modules.path())
        .env("EXPECTED_TEST_HOME", &home);
    for key in [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "CCIE_LOG_DIR",
    ] {
        command.env(key, parent.path());
    }
    assert!(command.status().unwrap().success());
    assert!(home.join("child-finished").is_file());
    assert!(parent.path().is_dir());
    drop(fixture);
    assert!(!home.exists());
}
