fn main() {
    // GitHub's OAuth client ID is public (device flow embeds no client secret),
    // but release builds still supply it explicitly through CI. Ensure Cargo
    // rebuilds when a developer override or release variable changes.
    println!("cargo:rerun-if-env-changed=TERMINAI_GITHUB_CLIENT_ID");
    tauri_build::build()
}
