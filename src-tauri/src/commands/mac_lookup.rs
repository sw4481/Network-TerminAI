//! Offline IEEE assignment lookup. Only an explicit registry update uses the network.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

const EMBEDDED_SEED: &str = include_str!("../../../resources/mac-registry.json");
const MAX_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
const MAX_CSV_BYTES: usize = 16 * 1024 * 1024;
// ponytail: one process-wide update lock; split by cache path if multiple profiles need concurrent updates.
static UPDATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RegistrySource {
    pub registry: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegistryInfo {
    pub snapshot_at: String,
    pub loaded_from: String,
    pub record_count: usize,
    pub sources: Vec<RegistrySource>,
    pub cache_warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MacFormats {
    pub colon: String,
    pub hyphen: String,
    pub dotted: String,
    pub plain: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MacAssignment {
    pub registry: String,
    pub prefix: String,
    pub prefix_length: u32,
    pub organization: String,
    pub organization_address: String,
    pub block_start: String,
    pub block_end: String,
    pub address_count: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MacLookupResult {
    pub normalized: String,
    pub formats: MacFormats,
    pub oui: String,
    pub binary: String,
    pub is_multicast: bool,
    pub is_locally_administered: bool,
    pub is_broadcast: bool,
    pub is_zero: bool,
    pub warnings: Vec<String>,
    pub assignment: Option<MacAssignment>,
    pub registry: RegistryInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryRecord {
    registry: String,
    prefix: String,
    organization: String,
    organization_address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistrySnapshot {
    schema_version: u32,
    snapshot_at: String,
    sources: Vec<RegistrySource>,
    records: Vec<RegistryRecord>,
}

fn official_sources() -> Vec<RegistrySource> {
    [
        ("MA-L", "https://standards-oui.ieee.org/oui/oui.csv"),
        ("MA-M", "https://standards-oui.ieee.org/oui28/mam.csv"),
        ("MA-S", "https://standards-oui.ieee.org/oui36/oui36.csv"),
        ("IAB", "https://standards-oui.ieee.org/iab/iab.csv"),
        ("CID", "https://standards-oui.ieee.org/cid/cid.csv"),
    ]
    .into_iter()
    .map(|(registry, url)| RegistrySource {
        registry: registry.into(),
        url: url.into(),
    })
    .collect()
}

fn registry_spec(registry: &str) -> Result<(usize, usize, usize), String> {
    match registry {
        "MA-L" => Ok((6, 10_000, 150_000)),
        "MA-M" => Ok((7, 100, 50_000)),
        "MA-S" => Ok((9, 100, 100_000)),
        "IAB" => Ok((9, 100, 20_000)),
        "CID" => Ok((6, 10, 10_000)),
        _ => Err(format!("Unknown IEEE registry type: {registry}")),
    }
}

impl RegistryRecord {
    fn validate(&self) -> Result<(), String> {
        let (width, _, _) = registry_spec(&self.registry)?;
        if self.prefix.len() != width
            || !self
                .prefix
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_lowercase())
        {
            return Err(format!("Invalid {} assignment prefix", self.registry));
        }
        if self.organization.trim().is_empty()
            || self.organization.len() > 1024
            || self.organization_address.len() > 8192
            || [&self.organization, &self.organization_address]
                .into_iter()
                .any(|text| {
                    text.chars()
                        .any(|c| c.is_ascii_control() && !matches!(c, '\n' | '\r' | '\t'))
                })
        {
            return Err("Invalid or oversized IEEE organization name/address".into());
        }
        Ok(())
    }

    fn assignment(&self) -> MacAssignment {
        let prefix_length = self.prefix.len() as u32 * 4;
        let address_count = 1u64 << (48 - prefix_length);
        // Validated registry widths and hexadecimal strings make conversion infallible.
        let start = u64::from_str_radix(&self.prefix, 16).expect("validated assignment prefix")
            << (48 - prefix_length);
        MacAssignment {
            registry: self.registry.clone(),
            prefix: self.prefix.clone(),
            prefix_length,
            organization: self.organization.trim().into(),
            organization_address: self.organization_address.trim().into(),
            block_start: MacAddress::from_number(start).colon(),
            block_end: MacAddress::from_number(start + address_count - 1).colon(),
            address_count,
        }
    }
}

impl RegistrySnapshot {
    fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            return Err("Registry snapshot exceeds size limit".into());
        }
        let snapshot: Self = serde_json::from_slice(bytes)
            .map_err(|e| format!("Invalid registry snapshot JSON: {e}"))?;
        snapshot.validate()?;
        Ok(snapshot)
    }

    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("Unsupported MAC registry schema version".into());
        }
        let timestamp = DateTime::parse_from_rfc3339(&self.snapshot_at)
            .map_err(|_| "Invalid registry snapshot timestamp")?;
        if timestamp.offset().local_minus_utc() != 0 || self.snapshot_at.len() > 40 {
            return Err("Registry snapshot timestamp must be UTC".into());
        }
        let expected = official_sources();
        if self.sources.len() != expected.len()
            || expected.iter().any(|source| {
                self.sources
                    .iter()
                    .filter(|candidate| *candidate == source)
                    .count()
                    != 1
            })
        {
            return Err("Registry snapshot must identify all five official IEEE sources".into());
        }
        let mut counts = HashMap::<&str, usize>::new();
        let mut seen = HashSet::new();
        for record in &self.records {
            record.validate()?;
            if !seen.insert((&record.registry, &record.prefix)) {
                return Err(format!(
                    "Duplicate {} assignment {}",
                    record.registry, record.prefix
                ));
            }
            *counts.entry(&record.registry).or_default() += 1;
        }
        for source in expected {
            let (_, minimum, maximum) = registry_spec(&source.registry)?;
            let count = counts
                .get(source.registry.as_str())
                .copied()
                .unwrap_or_default();
            if !(minimum..=maximum).contains(&count) {
                return Err(format!(
                    "Implausible {} record count: {count} (expected {minimum}..={maximum})",
                    source.registry
                ));
            }
        }
        Ok(())
    }

    fn parse_csv(registry: &str, bytes: &[u8]) -> Result<Vec<RegistryRecord>, String> {
        if bytes.len() > MAX_CSV_BYTES {
            return Err("IEEE CSV exceeds size limit".into());
        }
        let (_, _, maximum) = registry_spec(registry)?;
        let mut reader = csv::ReaderBuilder::new().from_reader(bytes);
        let headers = reader
            .headers()
            .map_err(|e| format!("Invalid IEEE CSV headers: {e}"))?;
        if headers.iter().collect::<Vec<_>>()
            != [
                "Registry",
                "Assignment",
                "Organization Name",
                "Organization Address",
            ]
        {
            return Err("IEEE CSV does not have the exact expected four headers".into());
        }
        let mut seen = HashSet::new();
        let mut by_prefix = HashMap::<String, (usize, bool)>::new();
        let mut records = Vec::<RegistryRecord>::new();
        for row in reader.records() {
            let row = row.map_err(|e| format!("Invalid IEEE CSV record: {e}"))?;
            let record = RegistryRecord {
                registry: row[0].into(),
                prefix: row[1].into(),
                organization: row[2].trim().into(),
                organization_address: row[3].trim().into(),
            };
            if record.registry != registry {
                return Err(format!(
                    "Expected {registry} IEEE CSV, received {}",
                    record.registry
                ));
            }
            record.validate()?;
            if !seen.insert((
                record.prefix.clone(),
                record.organization.clone(),
                record.organization_address.clone(),
            )) {
                continue; // Exact duplicate rows do not imply another co-registrant.
            }
            if let Some((index, consolidated)) = by_prefix.get_mut(&record.prefix) {
                let existing = &mut records[*index];
                if !*consolidated {
                    existing.organization_address = format!(
                        "{}:\n{}",
                        existing.organization, existing.organization_address
                    );
                    *consolidated = true;
                }
                existing.organization.push_str(" | ");
                existing.organization.push_str(&record.organization);
                existing.organization_address.push_str(&format!(
                    "\n\n{}:\n{}",
                    record.organization, record.organization_address
                ));
                existing.validate()?; // Aggregate names/addresses remain subject to the same bounds.
            } else {
                by_prefix.insert(record.prefix.clone(), (records.len(), false));
                records.push(record);
            }
            if records.len() > maximum {
                return Err(format!("Too many {registry} registry records"));
            }
        }
        Ok(records)
    }
}

pub struct MacRegistryService {
    cache_path: PathBuf,
    snapshot: RegistrySnapshot,
    loaded_from: String,
    cache_warning: Option<String>,
}

impl MacRegistryService {
    fn open(cache_path: PathBuf, bundled: &[u8]) -> Result<Self, String> {
        let cached =
            Self::read_bounded(&cache_path).and_then(|bytes| RegistrySnapshot::parse(&bytes));
        let (snapshot, loaded_from, cache_warning) = match cached {
            Ok(snapshot) => (snapshot, "updated", None),
            Err(error) => (
                RegistrySnapshot::parse(bundled)
                    .map_err(|e| format!("Bundled MAC registry is invalid: {e}"))?,
                "bundled",
                Some(format!(
                    "App-data registry cache unavailable or ignored: {error}"
                )),
            ),
        };
        Ok(Self {
            cache_path,
            snapshot,
            loaded_from: loaded_from.into(),
            cache_warning,
        })
    }

    fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
        let file = File::open(path).map_err(|e| format!("Read registry cache: {e}"))?;
        if file.metadata().map_err(|e| e.to_string())?.len() > MAX_SNAPSHOT_BYTES as u64 {
            return Err("Registry cache exceeds size limit".into());
        }
        let mut bytes = Vec::new();
        file.take(MAX_SNAPSHOT_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Read registry cache: {e}"))?;
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            return Err("Registry cache exceeds size limit".into());
        }
        Ok(bytes)
    }

    pub fn info(&self) -> RegistryInfo {
        RegistryInfo {
            snapshot_at: self.snapshot.snapshot_at.clone(),
            loaded_from: self.loaded_from.clone(),
            record_count: self.snapshot.records.len(),
            sources: self.snapshot.sources.clone(),
            cache_warning: self.cache_warning.clone(),
        }
    }

    pub fn lookup(&self, address: &str) -> Result<MacLookupResult, String> {
        let address = MacAddress::parse(address)?;
        let formats = address.formats();
        let is_multicast = address.0[0] & 1 != 0;
        let is_locally_administered = address.0[0] & 2 != 0;
        let is_broadcast = address.0 == [255; 6];
        let is_zero = address.0 == [0; 6];
        // ponytail: bounded O(n) lookup over ~59k records; add a prefix index only if measured latency warrants it.
        let matched = if is_multicast || is_broadcast || is_zero {
            None
        } else {
            self.snapshot
                .records
                .iter()
                .filter(|record| {
                    let eligible = if is_locally_administered {
                        record.registry == "CID"
                    } else {
                        record.registry != "CID"
                    };
                    eligible && formats.plain.starts_with(&record.prefix)
                })
                .max_by_key(|record| record.prefix.len())
        };
        let mut warnings = vec!["An IEEE assignment identifies an address block, not an exact device model. MAC addresses can be spoofed or reassigned.".into()];
        if is_multicast {
            warnings.push(
                "Multicast/group address; not an individual device manufacturer lookup.".into(),
            );
        }
        if is_locally_administered {
            warnings.push("Locally administered address; randomized or manually assigned values are not vendor proof.".into());
        }
        if is_broadcast {
            warnings.push("Broadcast address; no manufacturer attribution.".into());
        }
        if is_zero {
            warnings.push("All-zero address; unspecified, not manufacturer attribution.".into());
        }
        if matched.is_some_and(|record| record.registry == "CID") {
            warnings.push("CID identifies an organization using a local address block; not manufacturer proof.".into());
        }
        if matched.is_none() {
            warnings.push("No matching eligible IEEE assignment in this registry snapshot.".into());
        }
        Ok(MacLookupResult {
            normalized: formats.colon.clone(),
            oui: formats.colon[..8].into(),
            binary: address
                .0
                .iter()
                .map(|byte| format!("{byte:08b}"))
                .collect::<Vec<_>>()
                .join(" "),
            formats,
            is_multicast,
            is_locally_administered,
            is_broadcast,
            is_zero,
            warnings,
            assignment: matched.map(RegistryRecord::assignment),
            registry: self.info(),
        })
    }

    fn publish(&self, snapshot: &RegistrySnapshot) -> Result<(), String> {
        snapshot.validate()?;
        let bytes = serde_json::to_vec(snapshot).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            return Err("Registry snapshot exceeds size limit".into());
        }
        let parent = self
            .cache_path
            .parent()
            .ok_or("Registry cache directory is missing")?;
        fs::create_dir_all(parent).map_err(|e| format!("Create registry cache directory: {e}"))?;
        let temporary = parent.join(format!("snapshot.{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|e| format!("Create temporary registry cache: {e}"))?;
            file.write_all(&bytes)
                .map_err(|e| format!("Write temporary registry cache: {e}"))?;
            file.sync_all()
                .map_err(|e| format!("Sync temporary registry cache: {e}"))?;
            // Close the source handle before replacement on Windows.
            drop(file);
            // std::fs::rename replaces files on Unix and Windows; never unlink the last-valid snapshot.
            fs::rename(&temporary, &self.cache_path)
                .map_err(|e| format!("Publish registry cache: {e}"))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    async fn download(
        client: &reqwest::Client,
        url: &str,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        let mut response = client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("Download IEEE registry: {e}"))?
            .error_for_status()
            .map_err(|e| format!("Download IEEE registry: {e}"))?;
        if response
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            return Err("IEEE registry download exceeds size limit".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("Read IEEE registry download: {e}"))?
        {
            if chunk.len() > limit.saturating_sub(bytes.len()) {
                return Err("IEEE registry download exceeds size limit".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    async fn update_from(
        &self,
        client: &reqwest::Client,
        urls: &[String],
    ) -> Result<RegistryInfo, String> {
        let sources = official_sources();
        if urls.len() != sources.len() {
            return Err("Registry update requires all five IEEE sources".into());
        }
        // The deadline bounds downloads only. Filesystem publication is a separate blocking operation.
        let downloads = tokio::time::timeout(Duration::from_secs(120), async {
            let mut downloads = Vec::with_capacity(sources.len());
            for url in urls {
                downloads.push(Self::download(client, url, MAX_CSV_BYTES).await?);
            }
            Ok::<_, String>(downloads)
        })
        .await
        .map_err(|_| {
            "IEEE registry download timed out; previous snapshot retained".to_string()
        })??;
        let mut previous_counts = HashMap::<String, usize>::new();
        for record in &self.snapshot.records {
            *previous_counts.entry(record.registry.clone()).or_default() += 1;
        }
        let cache_path = self.cache_path.clone();
        tokio::task::spawn_blocking(move || {
            let mut records = Vec::new();
            for (source, bytes) in sources.iter().zip(downloads) {
                let downloaded = RegistrySnapshot::parse_csv(&source.registry, &bytes)?;
                let previous = previous_counts.get(&source.registry).copied().unwrap_or_default();
                if downloaded.len() * 10 < previous * 9 {
                    return Err(format!("{} registry lost more than 10% of active assignments ({} -> {}); previous snapshot retained", source.registry, previous, downloaded.len()));
                }
                records.extend(downloaded);
            }
            let updated = Self {
                cache_path,
                snapshot: RegistrySnapshot { schema_version: 1, snapshot_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true), sources, records },
                loaded_from: "updated".into(),
                cache_warning: None,
            };
            updated.publish(&updated.snapshot)?;
            Ok(updated.info())
        }).await.map_err(|e| format!("Registry validation/publication task failed: {e}"))?
    }

    fn downloader() -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(format!(
                "TerminAI/{} MAC Registry Updater",
                env!("CARGO_PKG_VERSION")
            ))
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| format!("Create registry downloader: {e}"))
    }

    fn for_app(app: &tauri::AppHandle) -> Result<Self, String> {
        let path = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("Resolve app-data directory: {e}"))?
            .join("mac-registry/snapshot.json");
        Self::open(path, EMBEDDED_SEED.as_bytes())
    }
}

#[tauri::command]
pub async fn mac_lookup(address: String, app: tauri::AppHandle) -> Result<MacLookupResult, String> {
    // Reject invalid input before loading a potentially large registry.
    MacAddress::parse(&address)?;
    tokio::task::spawn_blocking(move || MacRegistryService::for_app(&app)?.lookup(&address))
        .await
        .map_err(|e| format!("MAC lookup task failed: {e}"))?
}

#[tauri::command]
pub async fn mac_registry_info(app: tauri::AppHandle) -> Result<RegistryInfo, String> {
    tokio::task::spawn_blocking(move || Ok(MacRegistryService::for_app(&app)?.info()))
        .await
        .map_err(|e| format!("Registry info task failed: {e}"))?
}

#[tauri::command]
pub async fn mac_registry_update(app: tauri::AppHandle) -> Result<RegistryInfo, String> {
    let _guard = UPDATE_LOCK
        .try_lock()
        .map_err(|_| "A MAC registry update is already in progress")?;
    let service = tokio::task::spawn_blocking(move || MacRegistryService::for_app(&app))
        .await
        .map_err(|e| format!("Registry update task failed: {e}"))??;
    let client = MacRegistryService::downloader()?;
    let urls = official_sources()
        .into_iter()
        .map(|source| source.url)
        .collect::<Vec<_>>();
    service.update_from(&client, &urls).await
}

#[derive(Debug)]
struct MacAddress([u8; 6]);

impl MacAddress {
    fn from_number(number: u64) -> Self {
        let bytes = number.to_be_bytes();
        Self(bytes[2..].try_into().expect("six MAC bytes"))
    }

    fn colon(&self) -> String {
        self.0
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<Vec<_>>()
            .join(":")
    }

    fn formats(&self) -> MacFormats {
        let plain = self
            .0
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<String>();
        MacFormats {
            colon: self.colon(),
            hyphen: self
                .0
                .iter()
                .map(|byte| format!("{byte:02X}"))
                .collect::<Vec<_>>()
                .join("-"),
            dotted: format!("{}.{}.{}", &plain[..4], &plain[4..8], &plain[8..]),
            plain,
        }
    }

    fn parse(input: &str) -> Result<Self, String> {
        let input = input.trim();
        if input.len() > 64 || !input.is_ascii() {
            return Err("Enter one complete 48-bit MAC address".into());
        }
        let (parts, width, allow_short): (Vec<&str>, usize, bool) = if input.contains(':') {
            (input.split(':').collect(), 2, true)
        } else if input.contains('-') {
            (input.split('-').collect(), 2, true)
        } else if input.contains('.') {
            (input.split('.').collect(), 4, false)
        } else if input.bytes().any(|b| b.is_ascii_whitespace()) {
            (input.split_ascii_whitespace().collect(), 2, false)
        } else {
            let raw = input
                .strip_prefix("0x")
                .or_else(|| input.strip_prefix("0X"))
                .unwrap_or(input);
            (vec![raw], 12, false)
        };
        let expected_parts = 12 / width;
        if parts.len() != expected_parts
            || parts.iter().any(|part| {
                part.is_empty()
                    || part.len() > width
                    || (!allow_short && part.len() != width)
                    || !part.bytes().all(|b| b.is_ascii_hexdigit())
            })
        {
            return Err("Enter one complete MAC address in colon, hyphen, dotted, raw hex, or six-octet whitespace format".into());
        }
        let plain = parts
            .iter()
            .map(|part| format!("{:0>width$}", part, width = width))
            .collect::<String>();
        let mut bytes = [0; 6];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&plain[index * 2..index * 2 + 2], 16)
                .map_err(|e| e.to_string())?;
        }
        Ok(Self(bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn record(registry: &str, prefix: &str, organization: &str) -> RegistryRecord {
        RegistryRecord {
            registry: registry.into(),
            prefix: prefix.into(),
            organization: organization.into(),
            organization_address: "Registry address".into(),
        }
    }

    fn small_snapshot() -> RegistrySnapshot {
        RegistrySnapshot {
            schema_version: 1,
            snapshot_at: "2026-10-14T00:00:00Z".into(),
            sources: official_sources(),
            records: vec![
                record("MA-L", "001122", "Large"),
                record("MA-M", "0011223", "Medium"),
                record("MA-S", "001122334", "Small"),
                record("IAB", "001122335", "Individual"),
                record("CID", "021122", "Local organization"),
                record("MA-L", "021122", "Not a local manufacturer"),
                record("MA-L", "011122", "Not a multicast manufacturer"),
            ],
        }
    }

    // Catches wrong prefix precedence, bit flags and manufacturer attribution.
    #[test]
    fn reports_formats_longest_assignment_and_special_address_caveats() {
        let service = MacRegistryService {
            cache_path: std::path::PathBuf::new(),
            snapshot: small_snapshot(),
            loaded_from: "bundled".into(),
            cache_warning: None,
        };
        let result = service.lookup("0011.2233.4455").unwrap();
        assert_eq!(result.normalized, "00:11:22:33:44:55");
        assert_eq!(result.formats.hyphen, "00-11-22-33-44-55");
        assert_eq!(result.formats.dotted, "0011.2233.4455");
        assert_eq!(result.formats.plain, "001122334455");
        assert_eq!(result.oui, "00:11:22");
        assert_eq!(
            result.binary,
            "00000000 00010001 00100010 00110011 01000100 01010101"
        );
        let assignment = result.assignment.unwrap();
        assert_eq!(assignment.organization, "Small");
        assert_eq!(assignment.prefix_length, 36);
        assert_eq!(assignment.block_start, "00:11:22:33:40:00");
        assert_eq!(assignment.block_end, "00:11:22:33:4F:FF");
        assert_eq!(assignment.address_count, 4096);
        assert!(!result.is_multicast && !result.is_locally_administered);
        assert_eq!(
            service
                .lookup("001122335123")
                .unwrap()
                .assignment
                .unwrap()
                .registry,
            "IAB"
        );
        assert_eq!(
            service
                .lookup("0011223fffff")
                .unwrap()
                .assignment
                .unwrap()
                .prefix_length,
            28
        );
        assert_eq!(
            service
                .lookup("001122fffffe")
                .unwrap()
                .assignment
                .unwrap()
                .prefix_length,
            24
        );
        for address in [
            "011122334455",
            "ffffffffffff",
            "000000000000",
            "061122334455",
        ] {
            assert!(
                service.lookup(address).unwrap().assignment.is_none(),
                "attributed special address {address}"
            );
        }
        let local = service.lookup("021122334455").unwrap();
        assert!(local.is_locally_administered && !local.is_multicast);
        assert_eq!(local.assignment.unwrap().registry, "CID");
        assert!(local
            .warnings
            .iter()
            .any(|w| w.contains("not manufacturer proof")));
        assert!(service.lookup("ffffffffffff").unwrap().is_broadcast);
        assert!(service.lookup("000000000000").unwrap().is_zero);
        let unknown = service.lookup("a01122334455").unwrap();
        assert!(unknown.assignment.is_none());
        assert!(unknown.warnings.iter().any(|w| w.contains("No matching")));
        assert!(unknown.warnings.iter().any(|w| w.contains("device model")));
    }

    // Catches treating quoted commas/newlines as extra records or accepting wrong schemas.
    #[test]
    fn parses_ieee_csv_and_rejects_invalid_assignments() {
        let csv = b"Registry,Assignment,Organization Name,Organization Address\r\nMA-L,001122,\"Acme, Inc.\",\"Street\nCity\"\r\n";
        let records = RegistrySnapshot::parse_csv("MA-L", csv).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].organization, "Acme, Inc.");
        assert_eq!(records[0].organization_address, "Street\nCity");
        for row in [
            "MA-M,001122,Acme,City",
            "MA-L,00112Z,Acme,City",
            "MA-L,00112,Acme,City",
            "MA-L,001122,,City",
            "MA-L,001122,   ,City",
        ] {
            let text =
                format!("Registry,Assignment,Organization Name,Organization Address\n{row}\n");
            assert!(
                RegistrySnapshot::parse_csv("MA-L", text.as_bytes()).is_err(),
                "accepted {row}"
            );
        }
        let duplicate = b"Registry,Assignment,Organization Name,Organization Address\nMA-L,001122,Acme,City\nMA-L,001122,Acme,City\n";
        assert_eq!(
            RegistrySnapshot::parse_csv("MA-L", duplicate)
                .unwrap()
                .len(),
            1
        );
        assert!(RegistrySnapshot::parse_csv("MA-L", b"<html>error</html>").is_err());
        assert!(RegistrySnapshot::parse_csv(
            "MA-L",
            b"Registry,Assignment,Organization Address,Organization Name\nMA-L,001122,City,Acme\n"
        )
        .is_err());
    }

    #[test]
    fn preserves_official_legacy_unicode_addresses_but_rejects_ascii_control_bytes() {
        let text = "Registry,Assignment,Organization Name,Organization Address\nIAB,0050C28FD,Sindoma Müh Mim Ýnþ Elk San Tic Ltd.,Legacy\u{009d}address\n";
        let records = RegistrySnapshot::parse_csv("IAB", text.as_bytes()).unwrap();
        assert_eq!(records[0].organization_address, "Legacy\u{009d}address");
        let ascii_control = b"Registry,Assignment,Organization Name,Organization Address\nMA-L,001122,Acme,City\x00\n";
        assert!(RegistrySnapshot::parse_csv("MA-L", ascii_control).is_err());
    }

    // IEEE publishes genuine co-registrations; rejecting them breaks every native refresh.
    #[test]
    fn consolidates_shared_prefixes_without_losing_organizations_or_blank_addresses() {
        let csv = b"Registry,Assignment,Organization Name,Organization Address\nMA-L,080030,NETWORK RESEARCH CORPORATION,Street\nMA-L,080030,ROYAL MELBOURNE INST OF TECH,\nMA-L,080030,CERN,Switzerland\nMA-L,080030,CERN,Switzerland\n";
        let records = RegistrySnapshot::parse_csv("MA-L", csv).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].organization,
            "NETWORK RESEARCH CORPORATION | ROYAL MELBOURNE INST OF TECH | CERN"
        );
        assert_eq!(records[0].organization_address, "NETWORK RESEARCH CORPORATION:\nStreet\n\nROYAL MELBOURNE INST OF TECH:\n\n\nCERN:\nSwitzerland");
        let oversized_name = format!("Registry,Assignment,Organization Name,Organization Address\nMA-L,080030,{},Street\nMA-L,080030,{},City\n", "A".repeat(600), "B".repeat(600));
        assert!(RegistrySnapshot::parse_csv("MA-L", oversized_name.as_bytes()).is_err());
        let oversized_address = format!("Registry,Assignment,Organization Name,Organization Address\nMA-L,080030,First,{}\nMA-L,080030,Second,{}\n", "A".repeat(5000), "B".repeat(5000));
        assert!(RegistrySnapshot::parse_csv("MA-L", oversized_address.as_bytes()).is_err());
    }

    fn complete_snapshot(organization: &str) -> RegistrySnapshot {
        let mut snapshot = small_snapshot();
        snapshot.records.clear();
        for source in official_sources() {
            let (width, minimum, _) = registry_spec(&source.registry).unwrap();
            for index in 0..minimum {
                // Independent fixture prefixes; selected lookup is MA-L 001122.
                let prefix = format!("{:0width$X}", 0x001122u64 + index as u64, width = width);
                snapshot
                    .records
                    .push(record(&source.registry, &prefix, organization));
            }
        }
        snapshot
    }

    // Catches trusting corrupt/oversized cache data rather than falling back offline.
    #[test]
    fn falls_back_to_seed_with_honest_cache_warning() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("snapshot.json");
        let seed = serde_json::to_vec(&complete_snapshot("Bundled")).unwrap();
        let missing = MacRegistryService::open(cache.clone(), &seed).unwrap();
        assert_eq!(missing.info().loaded_from, "bundled");
        assert!(missing.info().cache_warning.is_some());
        for bytes in [
            b"not json".as_slice(),
            b"{\"schema_version\":999}".as_slice(),
        ] {
            std::fs::write(&cache, bytes).unwrap();
            let service = MacRegistryService::open(cache.clone(), &seed).unwrap();
            assert_eq!(
                service
                    .lookup("001122ffffff")
                    .unwrap()
                    .assignment
                    .unwrap()
                    .organization,
                "Bundled"
            );
            assert!(service.info().cache_warning.unwrap().contains("ignored"));
            assert_eq!(std::fs::read(&cache).unwrap(), bytes);
        }
        let file = std::fs::File::create(&cache).unwrap();
        file.set_len(MAX_SNAPSHOT_BYTES as u64 + 1).unwrap();
        assert!(MacRegistryService::open(cache, &seed)
            .unwrap()
            .info()
            .cache_warning
            .unwrap()
            .contains("size"));
    }

    // Catches publishing invalid/incomplete snapshots or removing the old cache before rename.
    #[test]
    fn publishes_atomically_and_reloads_offline() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("mac-registry/snapshot.json");
        let seed = serde_json::to_vec(&complete_snapshot("Bundled")).unwrap();
        let service = MacRegistryService::open(cache.clone(), &seed).unwrap();
        let update = complete_snapshot("Updated");
        service.publish(&update).unwrap();
        let previous = std::fs::read(&cache).unwrap();
        let mut invalid = update.clone();
        invalid.records.pop(); // CID drops below its plausible floor.
        assert!(service.publish(&invalid).is_err());
        assert_eq!(std::fs::read(&cache).unwrap(), previous);
        let loaded = MacRegistryService::open(cache.clone(), &seed).unwrap();
        assert_eq!(loaded.info().loaded_from, "updated");
        assert!(loaded.info().cache_warning.is_none());
        assert_eq!(
            loaded
                .lookup("001122ffffff")
                .unwrap()
                .assignment
                .unwrap()
                .organization,
            "Updated"
        );
        service.publish(&complete_snapshot("Replacement")).unwrap();
        assert_eq!(
            MacRegistryService::open(cache, &seed)
                .unwrap()
                .lookup("001122ffffff")
                .unwrap()
                .assignment
                .unwrap()
                .organization,
            "Replacement"
        );
        assert_eq!(
            std::fs::read_dir(dir.path().join("mac-registry"))
                .unwrap()
                .count(),
            1
        );
    }

    fn csv_for(snapshot: &RegistrySnapshot, registry: &str) -> String {
        let mut csv = String::from("Registry,Assignment,Organization Name,Organization Address\n");
        for record in snapshot
            .records
            .iter()
            .filter(|record| record.registry == registry)
        {
            csv.push_str(&format!(
                "{},{},{},City\n",
                record.registry, record.prefix, record.organization
            ));
        }
        csv
    }

    fn server(responses: Vec<(u16, String)>) -> (Vec<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let urls = (0..5).map(|index| format!("{url}/{index}")).collect();
        let handle = thread::spawn(move || {
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 8192];
                assert!(stream.read(&mut request).unwrap() > 0);
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: text/csv\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        (urls, handle)
    }

    // Catches a partial download replacing the last-valid cache; verifies the real HTTP->CSV->disk path.
    #[tokio::test]
    async fn update_downloads_all_sources_before_replacing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("snapshot.json");
        let original = complete_snapshot("Original");
        let seed = serde_json::to_vec(&original).unwrap();
        std::fs::write(&cache, &seed).unwrap();
        let service = MacRegistryService::open(cache.clone(), &seed).unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let updated = complete_snapshot("Downloaded");
        let (urls, handle) = server(vec![
            (200, csv_for(&updated, "MA-L")),
            (418, "Blocked".into()),
        ]);
        assert!(service.update_from(&client, &urls).await.is_err());
        handle.join().unwrap();
        assert_eq!(std::fs::read(&cache).unwrap(), seed);
        let (urls, handle) = server(
            official_sources()
                .iter()
                .map(|source| (200, csv_for(&updated, &source.registry)))
                .collect(),
        );
        let info = service.update_from(&client, &urls).await.unwrap();
        handle.join().unwrap();
        assert_eq!(info.loaded_from, "updated");
        assert_eq!(
            info.sources[0].url,
            "https://standards-oui.ieee.org/oui/oui.csv"
        );
        assert_eq!(
            MacRegistryService::open(cache, &seed)
                .unwrap()
                .lookup("001122ffffff")
                .unwrap()
                .assignment
                .unwrap()
                .organization,
            "Downloaded"
        );
    }

    // Absolute floors alone miss severe truncation in a registry whose total is comparatively small.
    #[tokio::test]
    async fn rejects_more_than_ten_percent_loss_per_registry_before_publish() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("snapshot.json");
        let mut original = complete_snapshot("Original");
        for index in 0..90 {
            original.records.push(record(
                "CID",
                &format!("{:06X}", 0x020000 + index),
                "Original",
            ));
        }
        let seed = serde_json::to_vec(&original).unwrap();
        std::fs::write(&cache, &seed).unwrap();
        let service = MacRegistryService::open(cache.clone(), &seed).unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let mut truncated = original.clone();
        for _ in 0..11 {
            truncated.records.pop();
        }
        let (urls, handle) = server(
            official_sources()
                .iter()
                .map(|source| (200, csv_for(&truncated, &source.registry)))
                .collect(),
        );
        let error = service.update_from(&client, &urls).await.unwrap_err();
        handle.join().unwrap();
        assert!(error.contains("CID") && error.contains("10%"), "{error}");
        assert_eq!(std::fs::read(&cache).unwrap(), seed);
        let mut boundary = original;
        for _ in 0..10 {
            boundary.records.pop();
        }
        let (urls, handle) = server(
            official_sources()
                .iter()
                .map(|source| (200, csv_for(&boundary, &source.registry)))
                .collect(),
        );
        assert_eq!(
            service
                .update_from(&client, &urls)
                .await
                .unwrap()
                .loaded_from,
            "updated"
        );
        handle.join().unwrap();
    }

    // Catches unbounded streaming and plausibility checks accepting truncated registries.
    #[tokio::test]
    async fn rejects_oversized_http_body_and_implausible_counts() {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let (urls, handle) = server(vec![(200, "x".repeat(1025))]);
        assert!(MacRegistryService::download(&client, &urls[0], 1024)
            .await
            .unwrap_err()
            .contains("size"));
        handle.join().unwrap();
        let mut snapshot = complete_snapshot("Valid");
        snapshot.records.retain(|record| record.registry != "IAB");
        assert!(snapshot.validate().is_err());
        let mut snapshot = complete_snapshot("Valid");
        snapshot.records.push(snapshot.records[0].clone());
        assert!(snapshot.validate().is_err());
        let mut snapshot = complete_snapshot("Valid");
        snapshot.sources[0].url = "https://untrusted.example/registry".into();
        assert!(snapshot.validate().is_err());
        let mut snapshot = complete_snapshot("Valid");
        snapshot.snapshot_at = "not a timestamp".into();
        assert!(snapshot.validate().is_err());
    }

    // Explicitly opt in: this test downloads public IEEE CSVs into a disposable cache.
    #[tokio::test]
    #[ignore = "Requires live access to all official IEEE registry sources"]
    async fn live_ieee_refresh_uses_native_https_downloader() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("snapshot.json");
        let service = MacRegistryService::open(cache.clone(), EMBEDDED_SEED.as_bytes()).unwrap();
        let client = MacRegistryService::downloader().unwrap();
        let urls = official_sources()
            .into_iter()
            .map(|source| source.url)
            .collect::<Vec<_>>();
        let info = service.update_from(&client, &urls).await.unwrap();
        assert!(info.record_count > 50_000);
        assert_eq!(info.loaded_from, "updated");
        assert!(info.cache_warning.is_none());
        assert_eq!(
            MacRegistryService::open(cache, EMBEDDED_SEED.as_bytes())
                .unwrap()
                .info()
                .record_count,
            info.record_count
        );
    }

    #[tokio::test]
    async fn rejects_oversized_stream_without_content_length() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            assert!(stream.read(&mut [0; 8192]).unwrap() > 0);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{}",
                "x".repeat(1025)
            )
            .unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        assert!(MacRegistryService::download(&client, &url, 1024)
            .await
            .unwrap_err()
            .contains("size"));
        handle.join().unwrap();
    }

    #[test]
    fn embedded_seed_is_complete_and_usable_offline() {
        let dir = tempfile::tempdir().unwrap();
        let service =
            MacRegistryService::open(dir.path().join("snapshot.json"), EMBEDDED_SEED.as_bytes())
                .unwrap();
        assert_eq!(service.info().sources.len(), 5);
        assert!(service.info().record_count > 10_000);
        assert_eq!(service.info().loaded_from, "bundled");
        assert!(service.lookup("ffffffffffff").unwrap().assignment.is_none());
    }
}

#[cfg(test)]
mod normalization_tests {
    use super::*;

    // Catches accepting arbitrary punctuation or dropping incomplete octets.
    #[test]
    fn accepts_only_complete_supported_address_formats() {
        for address in [
            "00:1:aB:0:12:ef",
            "00-01-ab-00-12-ef",
            "0001.ab00.12ef",
            "0001ab0012ef",
            "0x0001ab0012ef",
            "00 01 ab 00 12 ef",
            "  00:01:AB:00:12:EF  ",
        ] {
            assert_eq!(
                MacAddress::parse(address).unwrap().0,
                [0, 1, 171, 0, 18, 239]
            );
        }
        for address in [
            "",
            "00:01:ab:00:12",
            "00:01:ab:00:12:ef:10",
            "0:1:2:3:4:gg",
            "00:01-ab:00:12:ef",
            "00_01_ab_00_12_ef",
            "0001.ab00.12e",
            "0001ab0012ef0011",
            "00 1 ab 00 12 ef",
            "0x00:01:ab:00:12:ef",
            "00:01:ab:00:12:ef 00:01:ab:00:12:ef",
            "０001ab0012ef",
            "+0:01:ab:00:12:ef",
        ] {
            assert!(MacAddress::parse(address).is_err(), "accepted {address:?}");
        }
    }
}
