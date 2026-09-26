//! Bulk import adapters for saved SSH inventory.
//!
//! Preview is deliberately secret-free. The source is reread for commit and a
//! SHA-256 fingerprint must still match before any SQLite transaction begins.

use super::ssh::{
    create_folder_impl, get_connection_impl, list_connections_impl, normalize_folder_name,
    normalize_tags, save_connection_impl, update_connection_impl, validate_connection_basics,
    CreateSshFolderRequest, SaveSshConnectionRequest, SshConnection, UpdateSshConnectionRequest,
};
use crate::commands::AppState;
use anyhow::{anyhow, Context, Result};
use csv::StringRecord;
use quick_xml::{events::Event, Reader};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

const ROOT_FOLDER_ID: &str = "root";
const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum SourceType {
    SecureCrt,
    Mtputty,
    Mobaxterm,
    Openssh,
    Csv,
}

impl SourceType {
    fn parse(raw: &str) -> Result<Self> {
        match raw.trim().to_ascii_lowercase().replace(['-', ' '], "").as_str() {
            "securecrt" => Ok(Self::SecureCrt),
            "mtputty" | "mputty" => Ok(Self::Mtputty),
            "mobaxterm" | "moba" => Ok(Self::Mobaxterm),
            "openssh" | "sshconfig" => Ok(Self::Openssh),
            "csv" => Ok(Self::Csv),
            _ => Err(anyhow!(
                "unsupported SSH import source type; choose securecrt, mtputty, mobaxterm, openssh, or csv"
            )),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::SecureCrt => "securecrt",
            Self::Mtputty => "mtputty",
            Self::Mobaxterm => "mobaxterm",
            Self::Openssh => "openssh",
            Self::Csv => "csv",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportAction {
    Create,
    Update,
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialState {
    None,
    Plaintext,
    Unsupported,
}

#[derive(Debug, Clone, Serialize)]
pub struct SshImportPreviewRow {
    pub source: String,
    pub name: String,
    pub host: String,
    pub user: Option<String>,
    pub port: i64,
    pub identity_file: Option<String>,
    pub folder: Option<String>,
    pub tags: Vec<String>,
    pub action: ImportAction,
    pub credential_state: CredentialState,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SshImportPreview {
    pub source_type: String,
    pub source_path: String,
    pub fingerprint: String,
    pub rows: Vec<SshImportPreviewRow>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SshImportResult {
    pub created: usize,
    pub updated: usize,
    pub skipped: usize,
    pub credential_skipped: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
enum ImportedCredential {
    None,
    Plaintext(String),
    Unsupported,
}

impl ImportedCredential {
    fn state(&self) -> CredentialState {
        match self {
            Self::None => CredentialState::None,
            Self::Plaintext(_) => CredentialState::Plaintext,
            Self::Unsupported => CredentialState::Unsupported,
        }
    }

    fn plaintext(&self) -> Option<String> {
        match self {
            Self::Plaintext(value) => Some(value.clone()),
            Self::None | Self::Unsupported => None,
        }
    }
}

#[derive(Debug, Clone)]
struct ParsedConnection {
    source: String,
    name: String,
    host: String,
    user: Option<String>,
    port: Option<i64>,
    identity_file: Option<String>,
    folder_path: Option<Vec<String>>,
    tags: Option<Vec<String>>,
    credential: ImportedCredential,
    errors: Vec<String>,
    warnings: Vec<String>,
}

impl ParsedConnection {
    fn empty(source: impl Into<String>) -> Self {
        Self {
            source: source.into(),
            name: String::new(),
            host: String::new(),
            user: None,
            port: None,
            identity_file: None,
            folder_path: None,
            tags: None,
            credential: ImportedCredential::None,
            errors: Vec::new(),
            warnings: Vec::new(),
        }
    }
}

#[derive(Debug)]
struct ParsedSource {
    fingerprint: String,
    rows: Vec<ParsedConnection>,
    warnings: Vec<String>,
}

#[derive(Debug)]
struct PlannedRow {
    raw: ParsedConnection,
    preview: SshImportPreviewRow,
    existing_id: Option<String>,
}

#[derive(Debug)]
struct ImportPlan {
    rows: Vec<PlannedRow>,
    warnings: Vec<String>,
}

#[derive(Debug)]
enum SourceMaterial {
    File { bytes: Vec<u8> },
    Directory { files: Vec<(PathBuf, Vec<u8>)> },
}

fn clean_optional(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn decode_text(bytes: &[u8]) -> Result<String> {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(rest.to_vec()).context("decode UTF-8 source");
    }
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        let little_endian = bytes.starts_with(&[0xFF, 0xFE]);
        let payload = &bytes[2..];
        if !payload.len().is_multiple_of(2) {
            return Err(anyhow!("UTF-16 source has an incomplete code unit"));
        }
        let units = payload
            .chunks_exact(2)
            .map(|pair| {
                if little_endian {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })
            .collect::<Vec<_>>();
        return String::from_utf16(&units).context("decode UTF-16 source");
    }
    String::from_utf8(bytes.to_vec()).context("decode UTF-8 source")
}

fn collect_directory_files(root: &Path) -> Result<Vec<(PathBuf, Vec<u8>)>> {
    fn walk(root: &Path, current: &Path, paths: &mut Vec<PathBuf>) -> Result<()> {
        let mut entries = fs::read_dir(current)
            .with_context(|| format!("read SSH import directory {}", current.display()))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                walk(root, &path, paths)?;
            } else if file_type.is_file() {
                paths.push(path.strip_prefix(root)?.to_path_buf());
            }
        }
        Ok(())
    }

    let mut paths = Vec::new();
    walk(root, root, &mut paths)?;
    paths.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));
    let mut total = 0u64;
    let mut files = Vec::with_capacity(paths.len());
    for relative in paths {
        let bytes = fs::read(root.join(&relative))
            .with_context(|| format!("read SSH import file {}", relative.display()))?;
        total = total.saturating_add(bytes.len() as u64);
        if total > MAX_SOURCE_BYTES {
            return Err(anyhow!("SSH import source exceeds the 64 MiB limit"));
        }
        files.push((relative, bytes));
    }
    Ok(files)
}

fn read_material(source_type: SourceType, path: &Path) -> Result<(String, SourceMaterial)> {
    let metadata =
        fs::metadata(path).with_context(|| format!("read SSH import source {}", path.display()))?;
    match source_type {
        SourceType::SecureCrt => {
            if !metadata.is_dir() {
                return Err(anyhow!("SecureCRT import requires a session directory"));
            }
            let files = collect_directory_files(path)?;
            let mut hasher = Sha256::new();
            for (relative, bytes) in &files {
                let relative = relative.to_string_lossy();
                hasher.update((relative.len() as u64).to_le_bytes());
                hasher.update(relative.as_bytes());
                hasher.update((bytes.len() as u64).to_le_bytes());
                hasher.update(bytes);
            }
            Ok((
                hex::encode(hasher.finalize()),
                SourceMaterial::Directory { files },
            ))
        }
        _ => {
            if !metadata.is_file() {
                return Err(anyhow!("this SSH import source must be a file"));
            }
            if metadata.len() > MAX_SOURCE_BYTES {
                return Err(anyhow!("SSH import source exceeds the 64 MiB limit"));
            }
            let bytes = fs::read(path)
                .with_context(|| format!("read SSH import source {}", path.display()))?;
            let fingerprint = hex::encode(Sha256::digest(&bytes));
            Ok((fingerprint, SourceMaterial::File { bytes }))
        }
    }
}

fn parse_port(raw: Option<&str>, row: &mut ParsedConnection) -> Option<i64> {
    let value = clean_optional(raw)?;
    match value.parse::<i64>() {
        Ok(port) => Some(port),
        Err(_) => {
            row.errors.push("port is not a valid number".into());
            None
        }
    }
}

fn parse_securecrt(
    root: &Path,
    files: &[(PathBuf, Vec<u8>)],
) -> Result<(Vec<ParsedConnection>, Vec<String>)> {
    let mut rows = Vec::new();
    let mut warnings = Vec::new();
    for (relative, bytes) in files {
        if relative
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| !extension.eq_ignore_ascii_case("ini"))
            .unwrap_or(true)
        {
            continue;
        }
        let text = decode_text(bytes)
            .with_context(|| format!("decode SecureCRT session {}", relative.display()))?;
        let mut values = HashMap::<String, String>::new();
        for line in text.lines() {
            let line = line.trim();
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let key = key
                .split_once('"')
                .and_then(|(_, rest)| rest.rsplit_once('"').map(|(name, _)| name))
                .unwrap_or(key)
                .trim()
                .to_ascii_lowercase();
            values.insert(key, value.trim().to_string());
        }
        let source = relative.to_string_lossy().into_owned();
        let mut row = ParsedConnection::empty(source);
        row.name = relative
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_string();
        row.host = values
            .get("hostname")
            .or_else(|| values.get("host name"))
            .cloned()
            .unwrap_or_default();
        row.user = clean_optional(values.get("username").map(String::as_str));
        let port_raw = values
            .get("[ssh2] port")
            .or_else(|| values.get("ssh2 port"));
        row.port = port_raw.and_then(|value| {
            let value = value.trim();
            i64::from_str_radix(value.trim_start_matches("0x"), 16)
                .ok()
                .filter(|port| *port > 0)
                .or_else(|| value.parse::<i64>().ok())
        });
        row.identity_file = clean_optional(
            values
                .get("identity filename v2")
                .or_else(|| values.get("identity filename"))
                .map(String::as_str),
        );
        row.folder_path = relative.parent().and_then(|parent| {
            let parts = parent
                .components()
                .filter_map(|component| clean_optional(component.as_os_str().to_str()))
                .collect::<Vec<_>>();
            (!parts.is_empty()).then_some(parts)
        });
        let protected_password = values
            .iter()
            .any(|(key, value)| key.contains("password") && !value.trim().is_empty());
        if protected_password {
            row.credential = ImportedCredential::Unsupported;
            row.warnings.push(
                "SecureCRT protected credential is unsupported and will not be imported".into(),
            );
        }
        rows.push(row);
    }
    if rows.is_empty() {
        warnings.push(format!(
            "No SecureCRT .ini sessions were found under {}",
            root.display()
        ));
    }
    Ok((rows, warnings))
}

fn strip_config_comment(line: &str) -> String {
    let mut output = String::new();
    let mut quote = None;
    for ch in line.chars() {
        match ch {
            '\'' | '"' if quote == Some(ch) => quote = None,
            '\'' | '"' if quote.is_none() => quote = Some(ch),
            '#' if quote.is_none() => break,
            _ => output.push(ch),
        }
    }
    output
}

fn split_config_words(raw: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for ch in raw.chars() {
        match ch {
            '\'' | '"' if quote == Some(ch) => quote = None,
            '\'' | '"' if quote.is_none() => quote = Some(ch),
            ch if ch.is_whitespace() && quote.is_none() => {
                if !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

#[derive(Default)]
struct OpenSshBlock {
    aliases: Vec<String>,
    hostname: Option<String>,
    user: Option<String>,
    port: Option<String>,
    identity_file: Option<String>,
    start_line: usize,
}

fn flush_openssh_block(block: OpenSshBlock, rows: &mut Vec<ParsedConnection>) {
    for alias in block.aliases {
        let source = format!("Host {alias} (line {})", block.start_line);
        let mut row = ParsedConnection::empty(source);
        if alias.chars().any(|ch| matches!(ch, '*' | '?' | '[' | ']')) {
            row.name = alias;
            row.errors
                .push("wildcard Host blocks are not imported".into());
            rows.push(row);
            continue;
        }
        row.name = alias.clone();
        row.host = block.hostname.clone().unwrap_or(alias);
        row.user = clean_optional(block.user.as_deref());
        row.port = parse_port(block.port.as_deref(), &mut row);
        row.identity_file = clean_optional(block.identity_file.as_deref());
        rows.push(row);
    }
}

fn parse_openssh(text: &str) -> (Vec<ParsedConnection>, Vec<String>) {
    let mut rows = Vec::new();
    let mut warnings = Vec::new();
    let mut current: Option<OpenSshBlock> = None;
    let mut in_match = false;

    for (index, raw_line) in text.lines().enumerate() {
        let line_number = index + 1;
        let line = strip_config_comment(raw_line);
        let words = split_config_words(line.trim());
        if words.is_empty() {
            continue;
        }
        let directive = words[0].to_ascii_lowercase();
        if directive == "host" {
            if let Some(block) = current.take() {
                flush_openssh_block(block, &mut rows);
            }
            in_match = false;
            current = Some(OpenSshBlock {
                aliases: words.into_iter().skip(1).collect(),
                start_line: line_number,
                ..OpenSshBlock::default()
            });
            continue;
        }
        if directive == "match" {
            if let Some(block) = current.take() {
                flush_openssh_block(block, &mut rows);
            }
            in_match = true;
            warnings.push(format!("Line {line_number}: Match blocks are not imported"));
            continue;
        }
        if directive == "include" {
            warnings.push(format!(
                "Line {line_number}: Include directives are not followed"
            ));
            continue;
        }
        if in_match {
            continue;
        }
        let Some(block) = current.as_mut() else {
            continue;
        };
        let value = words.into_iter().skip(1).collect::<Vec<_>>().join(" ");
        match directive.as_str() {
            "hostname" if block.hostname.is_none() => block.hostname = clean_optional(Some(&value)),
            "user" if block.user.is_none() => block.user = clean_optional(Some(&value)),
            "port" if block.port.is_none() => block.port = clean_optional(Some(&value)),
            "identityfile" if block.identity_file.is_none() => {
                block.identity_file = clean_optional(Some(&value));
            }
            _ => {}
        }
    }
    if let Some(block) = current {
        flush_openssh_block(block, &mut rows);
    }
    (rows, warnings)
}

fn header_index(headers: &StringRecord, name: &str) -> Option<usize> {
    headers
        .iter()
        .position(|header| header.trim().eq_ignore_ascii_case(name))
}

fn record_field(record: &StringRecord, index: Option<usize>) -> Option<&str> {
    index.and_then(|index| record.get(index))
}

fn split_folder_path(raw: Option<&str>) -> Option<Vec<String>> {
    let parts = raw?
        .split(['/', '\\'])
        .filter_map(|part| clean_optional(Some(part)))
        .collect::<Vec<_>>();
    (!parts.is_empty()).then_some(parts)
}

fn parse_csv(bytes: &[u8]) -> Result<(Vec<ParsedConnection>, Vec<String>)> {
    let text = decode_text(bytes)?;
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(text.as_bytes());
    let headers = reader.headers().context("read CSV headers")?.clone();
    let name_idx = header_index(&headers, "name");
    let host_idx = header_index(&headers, "host");
    if name_idx.is_none() || host_idx.is_none() {
        return Err(anyhow!("CSV must contain name and host columns"));
    }
    let user_idx = header_index(&headers, "user");
    let port_idx = header_index(&headers, "port");
    let identity_idx = header_index(&headers, "identity_file");
    let password_idx = header_index(&headers, "password");
    let folder_idx = header_index(&headers, "folder");
    let tags_idx = header_index(&headers, "tags");
    let mut rows = Vec::new();
    for (index, record) in reader.records().enumerate() {
        let record = record.with_context(|| format!("read CSV row {}", index + 2))?;
        let mut row = ParsedConnection::empty(format!("CSV row {}", index + 2));
        row.name = record_field(&record, name_idx)
            .unwrap_or("")
            .trim()
            .to_string();
        row.host = record_field(&record, host_idx)
            .unwrap_or("")
            .trim()
            .to_string();
        row.user = clean_optional(record_field(&record, user_idx));
        row.port = parse_port(record_field(&record, port_idx), &mut row);
        row.identity_file = clean_optional(record_field(&record, identity_idx));
        row.folder_path = split_folder_path(record_field(&record, folder_idx));
        row.tags = clean_optional(record_field(&record, tags_idx)).map(|tags| {
            tags.split([',', ';', '|'])
                .filter_map(|tag| clean_optional(Some(tag)))
                .collect()
        });
        if let Some(password) = clean_optional(record_field(&record, password_idx)) {
            row.credential = ImportedCredential::Plaintext(password);
        }
        rows.push(row);
    }
    Ok((rows, Vec::new()))
}

fn xml_attributes(
    reader: &Reader<&[u8]>,
    event: &quick_xml::events::BytesStart<'_>,
) -> Result<HashMap<String, String>> {
    let mut values = HashMap::new();
    for attribute in event.attributes().with_checks(false) {
        let attribute = attribute.context("read MTPuTTY XML attribute")?;
        let key = String::from_utf8_lossy(attribute.key.as_ref()).to_ascii_lowercase();
        let value = attribute
            .decode_and_unescape_value(reader.decoder())
            .context("decode MTPuTTY XML attribute")?
            .into_owned();
        values.insert(key, value);
    }
    Ok(values)
}

fn first_attr(values: &HashMap<String, String>, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| clean_optional(values.get(*name).map(String::as_str)))
}

fn mtputty_element(
    tag: &str,
    values: &HashMap<String, String>,
    folders: &[String],
    source_index: usize,
) -> (Option<ParsedConnection>, Option<String>) {
    let host = first_attr(
        values,
        &[
            "hostname",
            "server_name",
            "servername",
            "server",
            "host",
            "ip",
        ],
    );
    let name = first_attr(
        values,
        &[
            "displayname",
            "display_name",
            "sessionname",
            "name",
            "title",
        ],
    );
    if let Some(host) = host {
        let mut row = ParsedConnection::empty(format!("MTPuTTY XML item {source_index}"));
        row.name = name.unwrap_or_else(|| host.clone());
        row.host = host;
        row.user = first_attr(values, &["username", "user_name", "user", "login"]);
        let port = first_attr(values, &["port"]);
        row.port = parse_port(port.as_deref(), &mut row);
        row.identity_file = first_attr(
            values,
            &[
                "identityfile",
                "identity_file",
                "privatekey",
                "private_key",
                "keyfile",
            ],
        );
        if !folders.is_empty() {
            row.folder_path = Some(folders.to_vec());
        }
        if first_attr(
            values,
            &["password", "passwordcrypt", "password_encrypted", "pwd"],
        )
        .is_some()
        {
            row.credential = ImportedCredential::Unsupported;
            row.warnings.push(
                "MTPuTTY protected credential is unsupported and will not be imported".into(),
            );
        }
        return (Some(row), None);
    }

    let type_value = values
        .get("type")
        .map(|value| value.trim().to_ascii_lowercase());
    let tag_is_group = tag.contains("folder")
        || tag.contains("group")
        || (tag.contains("node")
            && !matches!(
                type_value.as_deref(),
                Some("0") | Some("session") | Some("server")
            ));
    if tag_is_group {
        return (None, name);
    }
    (None, None)
}

fn parse_mtputty(bytes: &[u8]) -> Result<(Vec<ParsedConnection>, Vec<String>)> {
    let text = decode_text(bytes)?;
    let mut reader = Reader::from_str(&text);
    reader.config_mut().trim_text(true);
    let mut rows = Vec::new();
    let mut folders = Vec::<String>::new();
    let mut pushed_groups = Vec::<bool>::new();
    let mut index = 0usize;
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                index += 1;
                let tag = String::from_utf8_lossy(event.name().as_ref()).to_ascii_lowercase();
                let values = xml_attributes(&reader, &event)?;
                let (row, group) = mtputty_element(&tag, &values, &folders, index);
                if let Some(row) = row {
                    rows.push(row);
                }
                let pushed = if let Some(group) = group {
                    folders.push(group);
                    true
                } else {
                    false
                };
                pushed_groups.push(pushed);
            }
            Ok(Event::Empty(event)) => {
                index += 1;
                let tag = String::from_utf8_lossy(event.name().as_ref()).to_ascii_lowercase();
                let values = xml_attributes(&reader, &event)?;
                let (row, _) = mtputty_element(&tag, &values, &folders, index);
                if let Some(row) = row {
                    rows.push(row);
                }
            }
            Ok(Event::End(_)) => {
                if pushed_groups.pop().unwrap_or(false) {
                    folders.pop();
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(anyhow!("parse MTPuTTY XML: {error}")),
        }
    }
    let warnings = if rows.is_empty() {
        vec!["No MTPuTTY sessions with host attributes were found".into()]
    } else {
        Vec::new()
    };
    Ok((rows, warnings))
}

fn parse_mobaxterm_session(
    key: &str,
    value: &str,
    folder: Option<&str>,
    line_number: usize,
) -> Option<ParsedConnection> {
    let marker = value.find("#109#")?;
    let prefix = value[..marker].trim().trim_end_matches('=');
    let name = if key.eq_ignore_ascii_case("sessionp") && !prefix.is_empty() {
        prefix
    } else {
        key.trim()
    };
    let payload = &value[marker + "#109#".len()..];
    let fields = payload.split('%').collect::<Vec<_>>();
    let mut row = ParsedConnection::empty(format!("MobaXterm line {line_number}"));
    row.name = name.to_string();
    row.host = fields.get(1).copied().unwrap_or("").trim().to_string();
    row.port = parse_port(fields.get(2).copied(), &mut row);
    row.user = clean_optional(fields.get(3).copied());
    row.folder_path = split_folder_path(folder);
    if fields
        .get(4)
        .and_then(|value| clean_optional(Some(value)))
        .filter(|value| value != "-1")
        .is_some()
    {
        row.credential = ImportedCredential::Unsupported;
        row.warnings
            .push("MobaXterm protected credential is unsupported and will not be imported".into());
    }
    Some(row)
}

fn parse_mobaxterm(text: &str) -> (Vec<ParsedConnection>, Vec<String>) {
    let mut rows = Vec::new();
    let mut warnings = Vec::new();
    let mut section = String::new();
    let mut folder_by_section = HashMap::<String, String>::new();
    let mut protected_password_section = false;

    for (index, raw_line) in text.lines().enumerate() {
        let line_number = index + 1;
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].trim().to_string();
            if section.eq_ignore_ascii_case("passwords") {
                protected_password_section = true;
            }
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("subrep") {
            if let Some(folder) = clean_optional(Some(value)) {
                folder_by_section.insert(section.clone(), folder);
            }
            continue;
        }
        let folder = folder_by_section.get(&section).map(String::as_str);
        if let Some(row) = parse_mobaxterm_session(key, value, folder, line_number) {
            rows.push(row);
        }
    }
    if protected_password_section {
        warnings
            .push("MobaXterm's protected password store was detected and was not imported".into());
    }
    if rows.is_empty() {
        warnings.push("No MobaXterm SSH bookmark sessions were found".into());
    }
    (rows, warnings)
}

fn read_source(source_type: SourceType, path: &Path) -> Result<ParsedSource> {
    let (fingerprint, material) = read_material(source_type, path)?;
    let (rows, warnings) = match (source_type, material) {
        (SourceType::SecureCrt, SourceMaterial::Directory { files }) => {
            parse_securecrt(path, &files)?
        }
        (SourceType::Mtputty, SourceMaterial::File { bytes }) => parse_mtputty(&bytes)?,
        (SourceType::Mobaxterm, SourceMaterial::File { bytes }) => {
            let text = decode_text(&bytes)?;
            parse_mobaxterm(&text)
        }
        (SourceType::Openssh, SourceMaterial::File { bytes }) => {
            let text = decode_text(&bytes)?;
            parse_openssh(&text)
        }
        (SourceType::Csv, SourceMaterial::File { bytes }) => parse_csv(&bytes)?,
        _ => {
            return Err(anyhow!(
                "SSH import source type does not match the selected path"
            ))
        }
    };
    Ok(ParsedSource {
        fingerprint,
        rows,
        warnings,
    })
}

fn endpoint_key(host: &str, user: Option<&str>, port: i64) -> (String, String, i64) {
    (
        host.trim().to_ascii_lowercase(),
        user.unwrap_or("").trim().to_ascii_lowercase(),
        port,
    )
}

fn validate_folder_path(raw: Option<&[String]>, errors: &mut Vec<String>) -> Option<Vec<String>> {
    let raw = raw?;
    if raw.len() > 8 {
        errors.push("folder path exceeds the 8-level limit".into());
        return None;
    }
    let mut normalized = Vec::with_capacity(raw.len());
    for part in raw {
        match normalize_folder_name(part) {
            Ok(part) => normalized.push(part),
            Err(error) => errors.push(error.to_string()),
        }
    }
    Some(normalized)
}

fn build_plan(conn: &Connection, parsed: ParsedSource) -> Result<ImportPlan> {
    let existing = list_connections_impl(conn)?;
    let mut existing_by_name = HashMap::<String, Vec<SshConnection>>::new();
    for connection in &existing {
        existing_by_name
            .entry(connection.name.to_ascii_lowercase())
            .or_default()
            .push(connection.clone());
    }

    let mut seen_names = HashSet::<String>::new();
    let mut seen_endpoints = HashSet::<(String, String, i64)>::new();
    let mut planned = Vec::with_capacity(parsed.rows.len());
    for mut raw in parsed.rows {
        raw.name = raw.name.trim().to_string();
        raw.host = raw.host.trim().to_string();
        raw.user = clean_optional(raw.user.as_deref());
        raw.identity_file = clean_optional(raw.identity_file.as_deref());
        let port = raw.port.unwrap_or(22);
        if let Err(error) = validate_connection_basics(&raw.name, &raw.host, port) {
            raw.errors.push(error.to_string());
        }
        let tags = match raw.tags.as_deref() {
            Some(tags) => match normalize_tags(tags) {
                Ok(tags) => tags,
                Err(error) => {
                    raw.errors.push(error.to_string());
                    Vec::new()
                }
            },
            None => Vec::new(),
        };
        let folder_path = validate_folder_path(raw.folder_path.as_deref(), &mut raw.errors);
        raw.folder_path = folder_path;

        let folded_name = raw.name.to_ascii_lowercase();
        let matching = existing_by_name
            .get(&folded_name)
            .cloned()
            .unwrap_or_default();
        if matching.len() > 1 {
            raw.errors.push(
                "multiple existing connections differ only by name case; resolve them before import"
                    .into(),
            );
        }
        let current = matching.first();
        let resolved_user = raw
            .user
            .as_deref()
            .or_else(|| current.and_then(|connection| connection.user.as_deref()));
        let resolved_port = raw
            .port
            .or_else(|| current.and_then(|connection| connection.port))
            .unwrap_or(22);
        let endpoint = endpoint_key(&raw.host, resolved_user, resolved_port);

        if !folded_name.is_empty() && !seen_names.insert(folded_name.clone()) {
            raw.errors
                .push("duplicate name in import source; first occurrence wins".into());
        }
        if !raw.host.is_empty() && !seen_endpoints.insert(endpoint.clone()) {
            raw.errors
                .push("duplicate host/user/port in import source; first occurrence wins".into());
        }

        if raw.errors.is_empty() {
            let collision = existing.iter().find(|candidate| {
                current.map(|value| value.id.as_str()) != Some(candidate.id.as_str())
                    && endpoint_key(
                        &candidate.host,
                        candidate.user.as_deref(),
                        candidate.port.unwrap_or(22),
                    ) == endpoint
                    && !candidate.name.eq_ignore_ascii_case(&raw.name)
            });
            if let Some(collision) = collision {
                raw.errors.push(format!(
                    "host/user/port already belongs to existing connection '{}'",
                    collision.name
                ));
            }
        }

        let action = if !raw.errors.is_empty() {
            ImportAction::Skip
        } else if current.is_some() {
            ImportAction::Update
        } else {
            ImportAction::Create
        };
        let mut row_warnings = raw.warnings.clone();
        row_warnings.extend(raw.errors.clone());
        let preview = SshImportPreviewRow {
            source: raw.source.clone(),
            name: raw.name.clone(),
            host: raw.host.clone(),
            user: raw.user.clone(),
            port: resolved_port,
            identity_file: raw.identity_file.clone(),
            folder: raw.folder_path.as_ref().map(|parts| parts.join("/")),
            tags,
            action,
            credential_state: raw.credential.state(),
            warnings: row_warnings,
        };
        planned.push(PlannedRow {
            raw,
            preview,
            existing_id: current.map(|connection| connection.id.clone()),
        });
    }
    Ok(ImportPlan {
        rows: planned,
        warnings: parsed.warnings,
    })
}

fn ensure_folder_path(conn: &Connection, path: &[String]) -> Result<String> {
    let mut parent_id = ROOT_FOLDER_ID.to_string();
    for name in path {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM ssh_folders WHERE parent_id = ?1 AND lower(name) = lower(?2)",
                params![parent_id, name],
                |row| row.get(0),
            )
            .optional()?;
        parent_id = if let Some(id) = existing {
            id
        } else {
            create_folder_impl(
                conn,
                CreateSshFolderRequest {
                    parent_id: Some(parent_id),
                    name: name.clone(),
                    position: None,
                },
            )?
            .id
        };
    }
    Ok(parent_id)
}

fn warnings_for_result(plan: &ImportPlan) -> Vec<String> {
    let mut warnings = plan.warnings.clone();
    for row in &plan.rows {
        for warning in &row.preview.warnings {
            warnings.push(format!("{}: {warning}", row.preview.source));
        }
    }
    warnings
}

pub fn preview_impl(
    conn: &Connection,
    source_type: &str,
    source_path: &Path,
) -> Result<SshImportPreview> {
    let source_type = SourceType::parse(source_type)?;
    let parsed = read_source(source_type, source_path)?;
    let fingerprint = parsed.fingerprint.clone();
    let plan = build_plan(conn, parsed)?;
    Ok(SshImportPreview {
        source_type: source_type.id().into(),
        source_path: source_path.to_string_lossy().into_owned(),
        fingerprint,
        rows: plan.rows.into_iter().map(|row| row.preview).collect(),
        warnings: plan.warnings,
    })
}

pub fn commit_impl(
    conn: &mut Connection,
    source_type: &str,
    source_path: &Path,
    expected_fingerprint: &str,
) -> Result<SshImportResult> {
    let source_type = SourceType::parse(source_type)?;
    let parsed = read_source(source_type, source_path)?;
    if parsed.fingerprint != expected_fingerprint {
        return Err(anyhow!(
            "SSH import source changed after preview; preview it again"
        ));
    }
    let transaction = conn.transaction()?;
    let plan = build_plan(&transaction, parsed)?;
    let warnings = warnings_for_result(&plan);
    let mut created = 0usize;
    let mut updated = 0usize;
    let mut skipped = 0usize;
    let mut credential_skipped = 0usize;

    for row in &plan.rows {
        if row.preview.action == ImportAction::Skip {
            skipped += 1;
            continue;
        }
        if row.raw.credential.state() == CredentialState::Unsupported {
            credential_skipped += 1;
        }
        let folder_id = match row.raw.folder_path.as_deref() {
            Some(path) => Some(ensure_folder_path(&transaction, path)?),
            None => None,
        };
        match row.preview.action {
            ImportAction::Create => {
                save_connection_impl(
                    &transaction,
                    SaveSshConnectionRequest {
                        name: row.raw.name.clone(),
                        host: row.raw.host.clone(),
                        user: row.raw.user.clone(),
                        port: Some(row.raw.port.unwrap_or(22)),
                        identity_file: row.raw.identity_file.clone(),
                        password: row.raw.credential.plaintext(),
                        folder_id: Some(folder_id.unwrap_or_else(|| ROOT_FOLDER_ID.into())),
                        tags: row.raw.tags.clone(),
                        accent_color: None,
                        vendor: None,
                        platform: None,
                        syntax_highlighting_enabled: None,
                        syntax_profile: None,
                    },
                )?;
                created += 1;
            }
            ImportAction::Update => {
                let id = row
                    .existing_id
                    .as_deref()
                    .ok_or_else(|| anyhow!("SSH import update lost its existing connection"))?;
                let existing = get_connection_impl(&transaction, id)?;
                update_connection_impl(
                    &transaction,
                    id,
                    UpdateSshConnectionRequest {
                        name: row.raw.name.clone(),
                        host: row.raw.host.clone(),
                        user: row.raw.user.clone().or(existing.user),
                        port: Some(row.raw.port.or(existing.port).unwrap_or(22)),
                        identity_file: row.raw.identity_file.clone().or(existing.identity_file),
                        password: row.raw.credential.plaintext(),
                        folder_id,
                        tags: row.raw.tags.clone(),
                        accent_color: None,
                        vendor: None,
                        platform: None,
                        syntax_highlighting_enabled: None,
                        syntax_profile: None,
                    },
                )?;
                updated += 1;
            }
            ImportAction::Skip => unreachable!(),
        }
    }
    transaction.commit()?;
    Ok(SshImportResult {
        created,
        updated,
        skipped,
        credential_skipped,
        warnings,
    })
}

#[tauri::command]
pub fn ssh_import_preview(
    state: State<'_, AppState>,
    source_type: String,
    source_path: String,
) -> Result<SshImportPreview, String> {
    let db = state.db.lock();
    preview_impl(&db, &source_type, Path::new(&source_path)).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn ssh_import_commit(
    state: State<'_, AppState>,
    source_type: String,
    source_path: String,
    fingerprint: String,
) -> Result<SshImportResult, String> {
    let mut db = state.db.lock();
    commit_impl(&mut db, &source_type, Path::new(&source_path), &fingerprint)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::ssh::{decrypt_password, save_connection_impl};
    use tempfile::tempdir;

    fn inventory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE ssh_folders (
               id TEXT PRIMARY KEY,
               parent_id TEXT REFERENCES ssh_folders(id),
               name TEXT NOT NULL,
               position INTEGER NOT NULL DEFAULT 0,
               created_at INTEGER NOT NULL DEFAULT (unixepoch()),
               updated_at INTEGER NOT NULL DEFAULT (unixepoch())
             );
             CREATE UNIQUE INDEX sibling_name ON ssh_folders(COALESCE(parent_id, ''), lower(name));
             INSERT INTO ssh_folders(id, parent_id, name) VALUES ('root', NULL, 'All Devices');
             CREATE TABLE ssh_connections (
               id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
               name TEXT NOT NULL UNIQUE,
               host TEXT NOT NULL,
               user TEXT,
               port INTEGER,
               identity_file TEXT,
               password_encrypted TEXT,
               created_at INTEGER NOT NULL DEFAULT (unixepoch()),
               last_used_at INTEGER,
               folder_id TEXT NOT NULL DEFAULT 'root',
               tags_json TEXT NOT NULL DEFAULT '[]',
               accent_color TEXT,
               vendor TEXT NOT NULL DEFAULT 'generic',
               platform TEXT NOT NULL DEFAULT 'generic',
               syntax_highlighting_enabled INTEGER NOT NULL DEFAULT 1,
               syntax_profile TEXT NOT NULL DEFAULT 'auto'
             );",
        )
        .unwrap();
        conn
    }

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents.as_bytes()).unwrap();
    }

    #[test]
    fn all_five_adapters_accept_crlf_and_unicode_paths() {
        let temp = tempdir().unwrap();

        let securecrt = temp.path().join("securecrt");
        write(
            &securecrt.join("東京").join("edge.ini"),
            "S:\"Hostname\"=192.0.2.1\r\nS:\"Username\"=ops\r\nD:\"[SSH2] Port\"=00000016\r\n",
        );
        let parsed = read_source(SourceType::SecureCrt, &securecrt).unwrap();
        assert_eq!(parsed.rows[0].name, "edge");
        assert_eq!(
            parsed.rows[0].folder_path.as_deref(),
            Some(&["東京".into()][..])
        );
        assert_eq!(parsed.rows[0].port, Some(22));

        let mtputty = temp.path().join("sessions.xml");
        write(
            &mtputty,
            "<?xml version=\"1.0\"?><Root><Folder Name=\"München\"><Node Type=\"0\" DisplayName=\"edge-xml\" ServerName=\"192.0.2.2\" UserName=\"ops\" Port=\"2222\" Password=\"opaque\" /></Folder></Root>",
        );
        let parsed = read_source(SourceType::Mtputty, &mtputty).unwrap();
        assert_eq!(
            parsed.rows[0].folder_path.as_deref(),
            Some(&["München".into()][..])
        );
        assert_eq!(
            parsed.rows[0].credential.state(),
            CredentialState::Unsupported
        );

        let moba = temp.path().join("sessions.mxtsessions");
        write(
            &moba,
            "[Bookmarks_1]\r\nSubRep=Zürich/Core\r\nedge-moba=#109#0%192.0.2.3%22%ops%%-1%-1\r\n",
        );
        let parsed = read_source(SourceType::Mobaxterm, &moba).unwrap();
        assert_eq!(parsed.rows[0].host, "192.0.2.3");
        assert_eq!(
            parsed.rows[0].folder_path.as_deref(),
            Some(&["Zürich".into(), "Core".into()][..])
        );

        let openssh = temp.path().join("config");
        write(
            &openssh,
            "Host edge-ssh\r\n  HostName 192.0.2.4\r\n  User ops\r\n  IdentityFile \"/Users/例/id key\"\r\nHost *.wild\r\n  HostName 192.0.2.5\r\nInclude conf.d/*\r\nMatch user root\r\n  HostName ignored\r\n",
        );
        let parsed = read_source(SourceType::Openssh, &openssh).unwrap();
        assert_eq!(
            parsed.rows[0].identity_file.as_deref(),
            Some("/Users/例/id key")
        );
        assert!(parsed.rows[1]
            .errors
            .iter()
            .any(|error| error.contains("wildcard")));
        assert!(parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("Include")));
        assert!(parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("Match")));

        let csv = temp.path().join("inventory.csv");
        write(
            &csv,
            "name,host,user,port,identity_file,password,folder,tags\r\nedge-csv,192.0.2.6,ops,22,/Users/例/id,cleartext,東京/Core,core;wan\r\n",
        );
        let parsed = read_source(SourceType::Csv, &csv).unwrap();
        assert_eq!(
            parsed.rows[0].tags.as_deref(),
            Some(&["core".into(), "wan".into()][..])
        );
        assert_eq!(
            parsed.rows[0].credential.state(),
            CredentialState::Plaintext
        );
    }

    #[test]
    fn preview_is_secret_free_and_commit_rejects_a_changed_source() {
        let mut conn = inventory_db();
        let temp = tempdir().unwrap();
        let path = temp.path().join("inventory.csv");
        write(
            &path,
            "name,host,password\nedge,192.0.2.10,never-serialize-this\n",
        );
        let preview = preview_impl(&conn, "csv", &path).unwrap();
        let serialized = serde_json::to_string(&preview).unwrap();
        assert!(!serialized.contains("never-serialize-this"));
        assert!(serialized.contains("plaintext"));

        write(
            &path,
            "name,host,password\nedge,192.0.2.11,never-serialize-this\n",
        );
        let error = commit_impl(&mut conn, "csv", &path, &preview.fingerprint).unwrap_err();
        assert!(error.to_string().contains("changed after preview"));
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM ssh_connections", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn conflicts_first_occurrence_folders_and_password_preservation_are_deterministic() {
        let mut conn = inventory_db();
        let existing = save_connection_impl(
            &conn,
            SaveSshConnectionRequest {
                name: "Edge".into(),
                host: "192.0.2.20".into(),
                user: Some("saved-user".into()),
                port: Some(2222),
                identity_file: Some("/saved/key".into()),
                password: Some("saved-password".into()),
                folder_id: None,
                tags: Some(vec!["saved".into()]),
                accent_color: None,
                vendor: None,
                platform: None,
                syntax_highlighting_enabled: None,
                syntax_profile: None,
            },
        )
        .unwrap();
        save_connection_impl(
            &conn,
            SaveSshConnectionRequest {
                name: "occupied".into(),
                host: "192.0.2.30".into(),
                user: Some("ops".into()),
                port: Some(22),
                identity_file: None,
                password: None,
                folder_id: None,
                tags: None,
                accent_color: None,
                vendor: None,
                platform: None,
                syntax_highlighting_enabled: None,
                syntax_profile: None,
            },
        )
        .unwrap();

        let temp = tempdir().unwrap();
        let path = temp.path().join("inventory.csv");
        write(
            &path,
            "name,host,user,port,identity_file,password,folder,tags\nEDGE,192.0.2.21,,,,,Sites/Raleigh,core;wan\nedge,192.0.2.22,other,22,,,,duplicate\ncollision,192.0.2.30,ops,22,,,,\nnew,192.0.2.40,ops,22,,new-password,Sites/Raleigh,new\n",
        );
        let preview = preview_impl(&conn, "csv", &path).unwrap();
        assert_eq!(preview.rows[0].action, ImportAction::Update);
        assert_eq!(preview.rows[1].action, ImportAction::Skip);
        assert_eq!(preview.rows[2].action, ImportAction::Skip);
        assert_eq!(preview.rows[3].action, ImportAction::Create);

        let result = commit_impl(&mut conn, "csv", &path, &preview.fingerprint).unwrap();
        assert_eq!((result.created, result.updated, result.skipped), (1, 1, 2));
        let updated = get_connection_impl(&conn, &existing.id).unwrap();
        assert_eq!(updated.host, "192.0.2.21");
        assert_eq!(updated.user.as_deref(), Some("saved-user"));
        assert_eq!(updated.port, Some(2222));
        assert_eq!(updated.identity_file.as_deref(), Some("/saved/key"));
        assert_eq!(updated.tags, vec!["core", "wan"]);
        assert_eq!(
            decrypt_password(updated.password_encrypted.as_deref().unwrap()).unwrap(),
            "saved-password"
        );
        let new_password: String = conn
            .query_row(
                "SELECT password_encrypted FROM ssh_connections WHERE name = 'new'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(decrypt_password(&new_password).unwrap(), "new-password");
        let folder_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ssh_folders WHERE name IN ('Sites', 'Raleigh')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(folder_count, 2);
    }

    #[test]
    fn a_database_failure_rolls_back_all_connections_and_folders() {
        let mut conn = inventory_db();
        conn.execute_batch(
            "CREATE TRIGGER reject_two BEFORE INSERT ON ssh_connections
             WHEN NEW.name = 'two'
             BEGIN SELECT RAISE(ABORT, 'forced import failure'); END;",
        )
        .unwrap();
        let temp = tempdir().unwrap();
        let path = temp.path().join("inventory.csv");
        write(
            &path,
            "name,host,folder\none,192.0.2.50,Imported/Site\ntwo,192.0.2.51,Imported/Site\n",
        );
        let preview = preview_impl(&conn, "csv", &path).unwrap();
        let error = commit_impl(&mut conn, "csv", &path, &preview.fingerprint).unwrap_err();
        assert!(error.to_string().contains("forced import failure"));
        let connections: i64 = conn
            .query_row("SELECT COUNT(*) FROM ssh_connections", [], |row| row.get(0))
            .unwrap();
        let folders: i64 = conn
            .query_row("SELECT COUNT(*) FROM ssh_folders", [], |row| row.get(0))
            .unwrap();
        assert_eq!(connections, 0);
        assert_eq!(folders, 1);
    }
}
