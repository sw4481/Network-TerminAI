//! Versioned application appearance preferences persisted in the existing
//! `app_flags` table. Invalid stored rows are deliberately non-fatal: callers
//! receive the complete current Dark default rather than a partial setting.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::AppState;

pub const APPEARANCE_SETTINGS_FLAG_KEY: &str = "ccie_appearance_settings_v1";
pub const FONT_SIZE_MIN: f64 = 8.0;
pub const FONT_SIZE_MAX: f64 = 32.0;
pub const FONT_WEIGHT_MIN: f64 = 100.0;
pub const FONT_WEIGHT_MAX: f64 = 900.0;
pub const LINE_HEIGHT_MIN: f64 = 1.0;
pub const LINE_HEIGHT_MAX: f64 = 2.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppThemeId {
    TerminaiDark,
    SlateGrey,
    Matrix,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EditorThemeId {
    FollowApp,
    ClassicDark,
    ZedOneDark,
    SlateGrey,
    Matrix,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalPresetId {
    FollowApp,
    TerminaiDark,
    SlateGrey,
    Matrix,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CursorStyle {
    Block,
    Bar,
    Underline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MotionPreference {
    System,
    Reduced,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalAnsiPalette {
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalAppearanceSettings {
    pub preset: TerminalPresetId,
    pub foreground: String,
    pub background: String,
    pub cursor: String,
    pub cursor_accent: String,
    pub selection_background: String,
    pub ansi: TerminalAnsiPalette,
    pub font_family: String,
    pub font_size: f64,
    pub font_weight: f64,
    pub line_height: f64,
    pub cursor_style: CursorStyle,
    pub cursor_blink: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppearanceEffects {
    pub matrix_scanlines: bool,
    pub matrix_glow: bool,
    pub motion: MotionPreference,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppearanceSettingsV1 {
    pub schema_version: u32,
    pub app_theme: AppThemeId,
    pub editor_theme: EditorThemeId,
    pub terminal: TerminalAppearanceSettings,
    pub effects: AppearanceEffects,
}

impl Default for AppearanceSettingsV1 {
    fn default() -> Self {
        Self {
            schema_version: 1,
            app_theme: AppThemeId::TerminaiDark,
            editor_theme: EditorThemeId::FollowApp,
            terminal: TerminalAppearanceSettings {
                preset: TerminalPresetId::FollowApp,
                foreground: "#E6E1CF".into(),
                background: "#0F1114".into(),
                cursor: "#5CCFE6".into(),
                cursor_accent: "#000000".into(),
                selection_background: "#FFFFFF4D".into(),
                ansi: TerminalAnsiPalette {
                    black: "#2E3436".into(),
                    red: "#CC0000".into(),
                    green: "#4E9A06".into(),
                    yellow: "#C4A000".into(),
                    blue: "#3465A4".into(),
                    magenta: "#75507B".into(),
                    cyan: "#06989A".into(),
                    white: "#D3D7CF".into(),
                    bright_black: "#555753".into(),
                    bright_red: "#EF2929".into(),
                    bright_green: "#8AE234".into(),
                    bright_yellow: "#FCE94F".into(),
                    bright_blue: "#729FCF".into(),
                    bright_magenta: "#AD7FA8".into(),
                    bright_cyan: "#34E2E2".into(),
                    bright_white: "#EEEEEC".into(),
                },
                font_family: "Menlo, \"SF Mono\", Monaco, monospace".into(),
                font_size: 13.0,
                font_weight: 400.0,
                line_height: 1.0,
                cursor_style: CursorStyle::Block,
                cursor_blink: true,
            },
            effects: AppearanceEffects {
                matrix_scanlines: false,
                matrix_glow: false,
                motion: MotionPreference::System,
            },
        }
    }
}

fn ensure_app_flags_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )
    .map_err(|error| format!("Failed to ensure app_flags: {error}"))
}

fn normalize_color(value: &str) -> Result<String, String> {
    let hex = value.trim();
    let digits = hex
        .strip_prefix('#')
        .ok_or_else(|| format!("invalid color: {value}"))?;
    if !matches!(digits.len(), 3 | 4 | 6 | 8)
        || !digits.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(format!("invalid color: {value}"));
    }
    let upper = digits.to_ascii_uppercase();
    let normalized = if upper.len() == 3 || upper.len() == 4 {
        upper
            .chars()
            .flat_map(|character| [character, character])
            .collect::<String>()
    } else {
        upper
    };
    Ok(format!("#{normalized}"))
}

fn clamp(value: f64, min: f64, max: f64, name: &str) -> Result<f64, String> {
    if !value.is_finite() {
        return Err(format!("{name} must be finite"));
    }
    Ok(value.clamp(min, max))
}

fn normalize_palette(ansi: &mut TerminalAnsiPalette) -> Result<(), String> {
    ansi.black = normalize_color(&ansi.black)?;
    ansi.red = normalize_color(&ansi.red)?;
    ansi.green = normalize_color(&ansi.green)?;
    ansi.yellow = normalize_color(&ansi.yellow)?;
    ansi.blue = normalize_color(&ansi.blue)?;
    ansi.magenta = normalize_color(&ansi.magenta)?;
    ansi.cyan = normalize_color(&ansi.cyan)?;
    ansi.white = normalize_color(&ansi.white)?;
    ansi.bright_black = normalize_color(&ansi.bright_black)?;
    ansi.bright_red = normalize_color(&ansi.bright_red)?;
    ansi.bright_green = normalize_color(&ansi.bright_green)?;
    ansi.bright_yellow = normalize_color(&ansi.bright_yellow)?;
    ansi.bright_blue = normalize_color(&ansi.bright_blue)?;
    ansi.bright_magenta = normalize_color(&ansi.bright_magenta)?;
    ansi.bright_cyan = normalize_color(&ansi.bright_cyan)?;
    ansi.bright_white = normalize_color(&ansi.bright_white)?;
    Ok(())
}

fn normalize_appearance_settings(
    mut settings: AppearanceSettingsV1,
) -> Result<AppearanceSettingsV1, String> {
    if settings.schema_version != 1 {
        return Err(format!(
            "unsupported appearance schema version: {}",
            settings.schema_version
        ));
    }
    let terminal = &mut settings.terminal;
    terminal.foreground = normalize_color(&terminal.foreground)?;
    terminal.background = normalize_color(&terminal.background)?;
    terminal.cursor = normalize_color(&terminal.cursor)?;
    terminal.cursor_accent = normalize_color(&terminal.cursor_accent)?;
    terminal.selection_background = normalize_color(&terminal.selection_background)?;
    normalize_palette(&mut terminal.ansi)?;
    terminal.font_family = terminal.font_family.trim().to_string();
    if terminal.font_family.is_empty() || terminal.font_family.len() > 256 {
        return Err("fontFamily must be between 1 and 256 characters".into());
    }
    terminal.font_size = clamp(terminal.font_size, FONT_SIZE_MIN, FONT_SIZE_MAX, "fontSize")?;
    terminal.font_weight = clamp(
        terminal.font_weight,
        FONT_WEIGHT_MIN,
        FONT_WEIGHT_MAX,
        "fontWeight",
    )?;
    terminal.line_height = clamp(
        terminal.line_height,
        LINE_HEIGHT_MIN,
        LINE_HEIGHT_MAX,
        "lineHeight",
    )?;
    Ok(settings)
}

pub fn parse_appearance_settings(value: &str) -> Result<AppearanceSettingsV1, String> {
    let parsed = serde_json::from_str(value)
        .map_err(|error| format!("invalid appearance settings JSON: {error}"))?;
    normalize_appearance_settings(parsed)
}

pub fn load_appearance_settings(conn: &Connection) -> Result<AppearanceSettingsV1, String> {
    ensure_app_flags_table(conn)?;
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM app_flags WHERE key = ?1",
            [APPEARANCE_SETTINGS_FLAG_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read appearance settings: {error}"))?;
    Ok(stored
        .as_deref()
        .and_then(|value| parse_appearance_settings(value).ok())
        .unwrap_or_default())
}

pub fn save_appearance_settings(
    conn: &Connection,
    settings: AppearanceSettingsV1,
) -> Result<AppearanceSettingsV1, String> {
    let normalized = normalize_appearance_settings(settings)?;
    let serialized = serde_json::to_string(&normalized)
        .map_err(|error| format!("Failed to serialize appearance settings: {error}"))?;
    ensure_app_flags_table(conn)?;
    conn.execute(
        "INSERT OR REPLACE INTO app_flags(key, value) VALUES (?1, ?2)",
        [APPEARANCE_SETTINGS_FLAG_KEY, &serialized],
    )
    .map_err(|error| format!("Failed to save appearance settings: {error}"))?;
    Ok(normalized)
}

#[tauri::command]
pub fn appearance_settings_get(state: State<'_, AppState>) -> Result<AppearanceSettingsV1, String> {
    load_appearance_settings(&state.db.lock())
}

#[tauri::command]
pub fn appearance_settings_set(
    state: State<'_, AppState>,
    settings: AppearanceSettingsV1,
) -> Result<AppearanceSettingsV1, String> {
    save_appearance_settings(&state.db.lock(), settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn test_conn() -> Connection {
        Connection::open_in_memory().expect("open in-memory sqlite")
    }

    #[test]
    fn defaults_to_the_current_dark_appearance() {
        let conn = test_conn();
        let settings = load_appearance_settings(&conn).expect("load defaults");
        assert_eq!(settings.schema_version, 1);
        assert_eq!(settings.app_theme, AppThemeId::TerminaiDark);
        assert_eq!(settings.terminal.background, "#0F1114");
        assert_eq!(settings.terminal.foreground, "#E6E1CF");
        assert_eq!(settings.terminal.selection_background, "#FFFFFF4D");
        assert_eq!(settings.terminal.ansi.bright_white, "#EEEEEC");
    }

    #[test]
    fn valid_settings_round_trip_in_normalized_form() {
        let conn = test_conn();
        let mut settings = AppearanceSettingsV1::default();
        settings.app_theme = AppThemeId::Matrix;
        settings.terminal.foreground = "#abc".into();
        settings.terminal.font_size = 1.0;
        save_appearance_settings(&conn, settings).expect("save settings");
        let restored = load_appearance_settings(&conn).expect("load settings");
        assert_eq!(restored.app_theme, AppThemeId::Matrix);
        assert_eq!(restored.terminal.foreground, "#AABBCC");
        assert_eq!(restored.terminal.font_size, FONT_SIZE_MIN);
    }

    #[test]
    fn malformed_json_falls_back_to_dark_on_load() {
        let conn = test_conn();
        ensure_app_flags_table(&conn).unwrap();
        conn.execute(
            "INSERT INTO app_flags(key, value) VALUES (?1, ?2)",
            rusqlite::params![APPEARANCE_SETTINGS_FLAG_KEY, "{bad json"],
        )
        .unwrap();
        assert_eq!(
            load_appearance_settings(&conn).unwrap().app_theme,
            AppThemeId::TerminaiDark
        );
    }

    #[test]
    fn invalid_colors_and_ids_are_rejected_without_overwriting_saved_settings() {
        let conn = test_conn();
        let mut saved = AppearanceSettingsV1::default();
        saved.app_theme = AppThemeId::Matrix;
        save_appearance_settings(&conn, saved).unwrap();
        let mut invalid_color = serde_json::to_value(AppearanceSettingsV1::default()).unwrap();
        invalid_color["terminal"]["foreground"] = serde_json::Value::String("red".into());
        assert!(parse_appearance_settings(&invalid_color.to_string()).is_err());
        let mut invalid_id = serde_json::to_value(AppearanceSettingsV1::default()).unwrap();
        invalid_id["appTheme"] = serde_json::Value::String("neon".into());
        assert!(parse_appearance_settings(&invalid_id.to_string()).is_err());
        assert_eq!(
            load_appearance_settings(&conn).unwrap().app_theme,
            AppThemeId::Matrix
        );
    }

    #[test]
    fn future_schema_versions_fall_back_to_dark_on_load() {
        let conn = test_conn();
        ensure_app_flags_table(&conn).unwrap();
        conn.execute(
            "INSERT INTO app_flags(key, value) VALUES (?1, ?2)",
            rusqlite::params![APPEARANCE_SETTINGS_FLAG_KEY, r#"{"schemaVersion":99}"#],
        )
        .unwrap();
        assert_eq!(
            load_appearance_settings(&conn).unwrap().app_theme,
            AppThemeId::TerminaiDark
        );
    }
}
