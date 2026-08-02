#[cfg(target_os = "macos")]
use anyhow::Context;
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cookie {
    pub host: String,
    pub name: String,
    pub value: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
}

/// PBKDF2-derive the AES-128 key for macOS Chrome cookie decryption.
#[cfg(any(target_os = "macos", test))]
fn chrome_derive_key(keychain_password: &str) -> [u8; 16] {
    use hmac::Hmac;
    use sha1::Sha1;
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2::<Hmac<Sha1>>(keychain_password.as_bytes(), b"saltysalt", 1003, &mut key)
        .expect("pbkdf2 key derivation");
    key
}

/// Strip the SHA256(host) prefix if present. Chrome v24+ prepends this 32-byte
/// hash to cookie plaintext. Returns the stripped value, or the original if
/// the prefix is not detected.
#[cfg(any(target_os = "macos", test))]
fn strip_host_hash(pt: &[u8], host: &str) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let expected = Sha256::digest(host.as_bytes());
    if pt.len() >= 32 && pt[..32] == expected[..] {
        pt[32..].to_vec()
    } else {
        pt.to_vec()
    }
}

/// Fetch the "Chrome Safe Storage" password from the macOS Keychain via the
/// `security` CLI. Returns the raw password used as PBKDF2 input.
#[cfg(target_os = "macos")]
fn chrome_keychain_password() -> Result<String> {
    let output = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-w",
            "-s",
            "Chrome Safe Storage",
            "-a",
            "Chrome",
        ])
        .output()
        .context("running `security find-generic-password`")?;
    if !output.status.success() {
        anyhow::bail!(
            "Keychain lookup failed (user may have denied access): {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_string())
}

/// Decrypt one Chrome `encrypted_value`. Returns the plaintext cookie value.
#[cfg(target_os = "macos")]
fn chrome_decrypt(encrypted: &[u8], key: &[u8; 16], host: &str) -> Result<String> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

    if encrypted.len() < 3 {
        anyhow::bail!("encrypted value too short");
    }
    // Strip the "v10" version prefix.
    let ciphertext = &encrypted[3..];
    let iv = [0x20u8; 16]; // 16 spaces

    let mut buf = ciphertext.to_vec();
    let pt = Aes128CbcDec::new(key.into(), &iv.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|e| anyhow::anyhow!("AES decrypt failed: {:?}", e))?;

    // Chrome v24+ prepends SHA256(host_key) (32 bytes) to the plaintext.
    // Detect it deterministically by recomputing the hash and comparing,
    // rather than guessing from byte values.
    let candidate = strip_host_hash(pt, host);
    Ok(String::from_utf8_lossy(&candidate).to_string())
}

/// Read and decrypt Chrome cookies for hosts containing `host_filter`.
#[cfg(target_os = "macos")]
pub fn read_chrome_cookies(host_filter: &str) -> Result<Vec<Cookie>> {
    let home = std::env::var("HOME").context("HOME not set")?;
    let db_path = format!(
        "{}/Library/Application Support/Google/Chrome/Default/Cookies",
        home
    );
    let password = chrome_keychain_password()?;
    let key = chrome_derive_key(&password);

    // Open read-only; Chrome may hold a lock, so use immutable mode.
    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .with_context(|| format!("opening Chrome cookies db at {}", db_path))?;

    let mut stmt = conn.prepare(
        "SELECT host_key, name, encrypted_value, path, is_secure, is_httponly FROM cookies WHERE host_key LIKE ?1",
    )?;
    let like = format!("%{}%", host_filter);
    let rows = stmt.query_map([like], |row| {
        let host: String = row.get(0)?;
        let name: String = row.get(1)?;
        let enc: Vec<u8> = row.get(2)?;
        let path: String = row.get(3)?;
        let is_secure: i32 = row.get(4)?;
        let is_httponly: i32 = row.get(5)?;
        Ok((host, name, enc, path, is_secure, is_httponly))
    })?;

    let mut cookies = Vec::new();
    for r in rows {
        let (host, name, enc, path, is_secure, is_httponly) = r?;
        match chrome_decrypt(&enc, &key, &host) {
            Ok(value) => cookies.push(Cookie {
                host,
                name,
                value,
                path,
                secure: is_secure != 0,
                http_only: is_httponly != 0,
            }),
            Err(_) => { /* skip undecryptable cookies */ }
        }
    }
    Ok(cookies)
}

#[cfg(not(target_os = "macos"))]
pub fn read_chrome_cookies(_host_filter: &str) -> Result<Vec<Cookie>> {
    anyhow::bail!("Chrome cookie import is only supported on macOS")
}

/// Minimal parser for Safari's Cookies.binarycookies format.
/// Layout: magic "cook", u32be page_count, [u32be page_size]*, then pages.
/// Each page: u32le 0x00000100, u32le cookie_count, [u32le offset]*,
/// then cookies. Each cookie record holds little-endian offsets to URL,
/// name, path, value (relative to the cookie record start).
#[cfg(target_os = "macos")]
pub fn read_safari_cookies(host_filter: &str) -> Result<Vec<Cookie>> {
    let home = std::env::var("HOME").context("HOME not set")?;
    let path = format!("{}/Library/Cookies/Cookies.binarycookies", home);
    let data = std::fs::read(&path).with_context(|| format!("reading {}", path))?;
    parse_binarycookies(&data, host_filter)
}

#[cfg(target_os = "macos")]
fn read_cstr(data: &[u8], start: usize) -> String {
    if start >= data.len() {
        return String::new();
    }
    let mut end = start;
    while end < data.len() && data[end] != 0 {
        end += 1;
    }
    String::from_utf8_lossy(&data[start..end]).to_string()
}

#[cfg(target_os = "macos")]
fn parse_binarycookies(data: &[u8], host_filter: &str) -> Result<Vec<Cookie>> {
    if data.len() < 8 || &data[0..4] != b"cook" {
        anyhow::bail!("not a binarycookies file");
    }
    let page_count = u32::from_be_bytes([data[4], data[5], data[6], data[7]]) as usize;
    let mut page_sizes = Vec::with_capacity(page_count);
    let mut off = 8;
    for _ in 0..page_count {
        if off + 4 > data.len() {
            anyhow::bail!("truncated page sizes");
        }
        page_sizes.push(
            u32::from_be_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]]) as usize,
        );
        off += 4;
    }

    let mut cookies = Vec::new();
    let mut page_start = off;
    for &size in &page_sizes {
        if page_start + size > data.len() {
            break;
        }
        let page = &data[page_start..page_start + size];
        page_start += size;

        if page.len() < 8 {
            continue;
        }
        let cookie_count = u32::from_le_bytes([page[4], page[5], page[6], page[7]]) as usize;
        let mut cookie_offsets = Vec::with_capacity(cookie_count);
        let mut p = 8;
        for _ in 0..cookie_count {
            if p + 4 > page.len() {
                break;
            }
            cookie_offsets.push(
                u32::from_le_bytes([page[p], page[p + 1], page[p + 2], page[p + 3]]) as usize,
            );
            p += 4;
        }

        for &co in &cookie_offsets {
            if co + 40 > page.len() {
                continue;
            }
            let rec = &page[co..];
            let url_off = u32::from_le_bytes([rec[16], rec[17], rec[18], rec[19]]) as usize;
            let name_off = u32::from_le_bytes([rec[20], rec[21], rec[22], rec[23]]) as usize;
            let path_off = u32::from_le_bytes([rec[24], rec[25], rec[26], rec[27]]) as usize;
            let value_off = u32::from_le_bytes([rec[28], rec[29], rec[30], rec[31]]) as usize;

            if url_off >= rec.len()
                || name_off >= rec.len()
                || path_off >= rec.len()
                || value_off >= rec.len()
            {
                continue; // skip malformed cookie record
            }

            let host = read_cstr(rec, url_off);
            let name = read_cstr(rec, name_off);
            let path = read_cstr(rec, path_off);
            let value = read_cstr(rec, value_off);

            // Safari binarycookies flags are at offset 8 (u32le). Bit 0x1 = secure, 0x4 = httpOnly.
            // For simplicity, we parse if available (rec has at least 12 bytes).
            let (secure, http_only) = if rec.len() >= 12 {
                let flags = u32::from_le_bytes([rec[8], rec[9], rec[10], rec[11]]);
                ((flags & 0x1) != 0, (flags & 0x4) != 0)
            } else {
                (false, false)
            };

            if host.contains(host_filter) {
                cookies.push(Cookie {
                    host,
                    name,
                    value,
                    path,
                    secure,
                    http_only,
                });
            }
        }
    }
    Ok(cookies)
}

#[cfg(not(target_os = "macos"))]
pub fn read_safari_cookies(_host_filter: &str) -> Result<Vec<Cookie>> {
    anyhow::bail!("Safari cookie import is only supported on macOS")
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn test_key_derivation_is_deterministic_and_16_bytes() {
        let k1 = chrome_derive_key("test-password");
        let k2 = chrome_derive_key("test-password");
        assert_eq!(k1, k2);
        assert_eq!(k1.len(), 16);
        let k3 = chrome_derive_key("different");
        assert_ne!(k1, k3);
    }

    #[test]
    fn test_strip_host_hash_with_matching_prefix() {
        let host = "example.com";
        let hash = Sha256::digest(host.as_bytes());
        let real_value = b"session-token-12345";
        let mut pt = hash.to_vec();
        pt.extend_from_slice(real_value);

        let result = strip_host_hash(&pt, host);
        assert_eq!(result, real_value);
    }

    #[test]
    fn test_strip_host_hash_with_non_matching_prefix() {
        let host = "example.com";
        let plain = b"plainvalue-no-hash";

        let result = strip_host_hash(plain, host);
        assert_eq!(result, plain);
    }

    #[test]
    fn test_strip_host_hash_with_short_plaintext() {
        let host = "example.com";
        let short = b"short";

        let result = strip_host_hash(short, host);
        assert_eq!(result, short);
    }

    #[test]
    fn test_strip_host_hash_exactly_32_bytes_no_match() {
        let host = "example.com";
        let exactly32 = [0x42u8; 32]; // 32 bytes that don't match the hash

        let result = strip_host_hash(&exactly32, host);
        assert_eq!(result, exactly32);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_binarycookies_rejects_bad_magic() {
        let bad = b"nope\x00\x00\x00\x00";
        assert!(super::parse_binarycookies(bad, "").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_binarycookies_malformed_does_not_panic() {
        // Valid magic "cook", 1 page, page_size 20, then a too-small/garbage page.
        let mut data = Vec::new();
        data.extend_from_slice(b"cook");
        // page_count = 1
        data.extend_from_slice(&1u32.to_be_bytes());
        // page size = 20
        data.extend_from_slice(&20u32.to_be_bytes());
        // a page of zeros (cookie_count=0 etc.)
        data.extend_from_slice(&[0u8; 20]);
        // Must not panic.
        let result = parse_binarycookies(&data, "");
        assert!(result.is_ok());
    }
}
