# NETCONF Tab — Step 2: Rust-native NETCONF (connect + send_rpc)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native Rust NETCONF over SSH. Two Tauri commands wire up: `netconf_connect` (opens SSH channel, does the `<hello>` exchange, returns session_id + capabilities) and `netconf_send_rpc` (sends an `<rpc>` on an existing session, returns the `<rpc-reply>`). Sessions live in a Rust `HashMap` and clean up via `Drop`. No disconnect command yet — sessions terminate when the tab closes or the app shuts down.

**Architecture:** `russh` for SSH transport; Tokio for async I/O. NETCONF framing (1.0 end-of-message + 1.1 chunked) implemented as pure functions over an `AsyncRead`/`AsyncWrite` stream. Session registry is a `Mutex<HashMap<SessionId, Arc<Mutex<Session>>>>` in `AppState`. RPC correlation is trivial: one RPC in flight per session at a time (UI is single-threaded per tab).

**Tech Stack:** russh 0.60, quick-xml 0.39 (parsing hello + extracting session-id/capabilities), tokio, serde, thiserror.

**Context:** The earlier-approved design had sessions living in the Python sidecar. But `agent_bridge` spawns a fresh sidecar process per call and kills it after the response — session state cannot survive there. We switched to Rust-native NETCONF (user's explicit choice). This plan delivers the minimum viable end-to-end: connect to 172.16.6.2, run `<get-config>`, see the reply.

---

## File Structure — Step 2

### Create
- `src-tauri/src/netconf_runner/transport.rs` — russh client + password auth + `request_subsystem("netconf")`. Returns the framed `Channel` stream.
- `src-tauri/src/netconf_runner/framing.rs` — pure codec: encode and decode NETCONF 1.0 (end-of-message `]]>]]>`) and 1.1 (chunked) over an `AsyncRead`/`AsyncWrite` pair.
- `src-tauri/src/netconf_runner/hello.rs` — build our `<hello>` (advertise 1.0 and 1.1), parse server's `<hello>` (extract session-id + capabilities), pick the framing mode.
- `src-tauri/src/netconf_runner/session.rs` — `Session` struct owning the russh channel stream, message-id counter, framing mode, capabilities. `send_rpc(xml)` method.
- `src-tauri/src/netconf_runner/registry.rs` — `SessionRegistry` (the `Mutex<HashMap<SessionId, Arc<Mutex<Session>>>>`); `insert`, `get`, `remove`. Also defines `SessionId` newtype.
- `src-tauri/src/netconf_runner/error.rs` — `NetconfError` enum (`thiserror`), covers transport/auth/framing/rpc/timeout/session_not_found.
- `src-tauri/tests/netconf_framing_test.rs` — pure tests for encode/decode 1.0 + 1.1, including bad-chunk cases.
- `src-tauri/tests/netconf_hello_test.rs` — parse fixtures of real Cisco IOS-XE hello responses; verify capability extraction + framing selection.

### Modify
- `src-tauri/Cargo.toml` — add `russh = "0.60"`, `quick-xml = "0.39"`.
- `src-tauri/src/netconf_runner/mod.rs` — declare the new submodules.
- `src-tauri/src/commands.rs` — add `netconf_connect` + `netconf_send_rpc` Tauri commands.
- `src-tauri/src/lib.rs` — register the two commands in `invoke_handler!`; add `SessionRegistry` to `AppState`.

No changes to frontend in this step — commands will be called from `src/lib/tauri.ts` wrappers that land in Step 3 (UI).

---

## Task 1: Add dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1.1: Append to `[dependencies]` block**

Add these two lines at the bottom of `[dependencies]` (after `thiserror = "1"` on line 53):

```toml
russh = "0.60"
quick-xml = "0.39"
```

- [ ] **Step 1.2: Verify the crate resolves**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: `Checking russh v0.60.2 …`, `Checking quick-xml v0.39.x …`, overall `Finished`.

- [ ] **Step 1.3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(netconf): add russh + quick-xml deps for NETCONF transport"
```

---

## Task 2: NetconfError enum — failing test

**Files:**
- Create: `src-tauri/src/netconf_runner/error.rs`
- Modify: `src-tauri/src/netconf_runner/mod.rs`

No separate test file — the error variants are exercised by later task tests. Still, we define the type up-front so imports compile.

- [ ] **Step 2.1: Declare the module**

Edit `src-tauri/src/netconf_runner/mod.rs`:

```rust
//! NETCONF tab: tab state, SSH transport, framing, session registry, history, YANG cache.
//! Mirrors the `api_runner` module's layout.

pub mod error;
pub mod session_store;
```

- [ ] **Step 2.2: Create the error module**

`src-tauri/src/netconf_runner/error.rs`:

```rust
//! NETCONF error taxonomy. Mapped to String at the Tauri boundary.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum NetconfError {
    #[error("ssh transport: {0}")]
    Transport(String),

    #[error("authentication failed")]
    AuthFailed,

    #[error("netconf framing: {0}")]
    Framing(String),

    #[error("rpc error: {0}")]
    Rpc(String),

    #[error("timeout after {secs}s")]
    Timeout { secs: u64 },

    #[error("session not found: {0}")]
    SessionNotFound(String),

    #[error("hello parse: {0}")]
    Hello(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl From<russh::Error> for NetconfError {
    fn from(e: russh::Error) -> Self {
        match e {
            russh::Error::NotAuthenticated => NetconfError::AuthFailed,
            other => NetconfError::Transport(other.to_string()),
        }
    }
}

pub type Result<T> = std::result::Result<T, NetconfError>;
```

- [ ] **Step 2.3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: `Finished`, no warnings introduced by this file.

- [ ] **Step 2.4: Commit**

```bash
git add src-tauri/src/netconf_runner/
git commit -m "feat(netconf): NetconfError taxonomy"
```

---

## Task 3: Framing codec — failing tests

**Files:**
- Create: `src-tauri/tests/netconf_framing_test.rs`

- [ ] **Step 3.1: Write the failing test**

```rust
//! NETCONF message framing tests (RFC 6242 §4.1 end-of-message + §4.2 chunked).

use ccie_terminal_lib::netconf_runner::framing;
use tokio::io::{duplex, AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn encode_eom_wraps_message_with_delimiter() {
    // RFC 6242 §4.1: NETCONF 1.0 appends ]]>]]> after each message.
    let msg = b"<rpc/>";
    let encoded = framing::encode_eom(msg);
    assert_eq!(&encoded, b"<rpc/>]]>]]>");
}

#[tokio::test]
async fn decode_eom_reads_one_message() {
    let (mut a, b) = duplex(64);
    a.write_all(b"<rpc-reply/>]]>]]>").await.unwrap();
    drop(a);

    let mut reader = tokio::io::BufReader::new(b);
    let msg = framing::decode_eom(&mut reader).await.unwrap();
    assert_eq!(msg, b"<rpc-reply/>");
}

#[tokio::test]
async fn decode_eom_reads_sequential_messages() {
    let (mut a, b) = duplex(256);
    a.write_all(b"<one/>]]>]]><two/>]]>]]>").await.unwrap();
    drop(a);

    let mut reader = tokio::io::BufReader::new(b);
    let m1 = framing::decode_eom(&mut reader).await.unwrap();
    let m2 = framing::decode_eom(&mut reader).await.unwrap();
    assert_eq!(m1, b"<one/>");
    assert_eq!(m2, b"<two/>");
}

#[tokio::test]
async fn encode_chunked_single_chunk() {
    // RFC 6242 §4.2: \n#<len>\n<bytes>\n##\n
    let msg = b"<rpc-reply/>";
    let encoded = framing::encode_chunked(msg);
    assert_eq!(&encoded, b"\n#12\n<rpc-reply/>\n##\n");
}

#[tokio::test]
async fn decode_chunked_single_chunk() {
    let (mut a, b) = duplex(256);
    a.write_all(b"\n#12\n<rpc-reply/>\n##\n").await.unwrap();
    drop(a);

    let mut reader = tokio::io::BufReader::new(b);
    let msg = framing::decode_chunked(&mut reader).await.unwrap();
    assert_eq!(msg, b"<rpc-reply/>");
}

#[tokio::test]
async fn decode_chunked_reassembles_multiple_chunks() {
    // Two chunks totaling "<big-message/>" (14 bytes).
    let (mut a, b) = duplex(256);
    a.write_all(b"\n#6\n<big-m\n#8\nessage/>\n##\n").await.unwrap();
    drop(a);

    let mut reader = tokio::io::BufReader::new(b);
    let msg = framing::decode_chunked(&mut reader).await.unwrap();
    assert_eq!(msg, b"<big-message/>");
}

#[tokio::test]
async fn decode_chunked_rejects_malformed_length() {
    let (mut a, b) = duplex(64);
    a.write_all(b"\n#notanumber\n").await.unwrap();
    drop(a);

    let mut reader = tokio::io::BufReader::new(b);
    let err = framing::decode_chunked(&mut reader).await.unwrap_err();
    assert!(format!("{err}").contains("framing"), "got: {err}");
}
```

- [ ] **Step 3.2: Run it — should fail to compile**

Run: `cd src-tauri && cargo test --test netconf_framing_test`
Expected: `unresolved import ccie_terminal_lib::netconf_runner::framing` or similar — module doesn't exist yet.

---

## Task 4: Framing codec — implement

**Files:**
- Create: `src-tauri/src/netconf_runner/framing.rs`
- Modify: `src-tauri/src/netconf_runner/mod.rs` (add `pub mod framing;`)

- [ ] **Step 4.1: Implement framing**

`src-tauri/src/netconf_runner/framing.rs`:

```rust
//! RFC 6242 framing for NETCONF over SSH.
//!
//! §4.1 end-of-message framing (NETCONF 1.0): every message ends with `]]>]]>`.
//! §4.2 chunked framing (NETCONF 1.1): `\n#<len>\n<bytes>\n##\n`, possibly
//! repeated across multiple chunks before the terminator `\n##\n`.

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt};

use super::error::{NetconfError, Result};

const EOM: &[u8] = b"]]>]]>";

/// Wrap a message for NETCONF 1.0 transmission.
pub fn encode_eom(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + EOM.len());
    out.extend_from_slice(body);
    out.extend_from_slice(EOM);
    out
}

/// Read one NETCONF 1.0 end-of-message-delimited message.
pub async fn decode_eom<R>(mut reader: R) -> Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    // Simple byte-at-a-time scan for ]]>]]>. NETCONF hello messages are tiny,
    // so this is fine; RPC payloads switch to chunked framing before volume
    // becomes a concern.
    let mut out = Vec::with_capacity(512);
    let mut tail = [0u8; 6];
    let mut tail_len = 0;
    let mut buf = [0u8; 1];

    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            return Err(NetconfError::Framing("eof before end-of-message".into()));
        }
        let b = buf[0];
        if tail_len < 6 {
            tail[tail_len] = b;
            tail_len += 1;
        } else {
            out.push(tail[0]);
            tail.copy_within(1..6, 0);
            tail[5] = b;
        }
        if tail_len == 6 && tail == *EOM {
            return Ok(out);
        }
    }
}

/// Wrap a message as a single NETCONF 1.1 chunk.
pub fn encode_chunked(body: &[u8]) -> Vec<u8> {
    let header = format!("\n#{}\n", body.len());
    let mut out = Vec::with_capacity(header.len() + body.len() + 4);
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(body);
    out.extend_from_slice(b"\n##\n");
    out
}

/// Read one NETCONF 1.1 chunked message (one or more chunks until `\n##\n`).
pub async fn decode_chunked<R>(reader: &mut R) -> Result<Vec<u8>>
where
    R: AsyncBufReadExt + Unpin,
{
    let mut out = Vec::with_capacity(1024);

    loop {
        let mut header = String::new();
        let n = reader.read_line(&mut header).await?;
        if n == 0 {
            return Err(NetconfError::Framing("eof in chunked framing".into()));
        }
        let hdr = header.trim_end_matches('\n');
        if hdr == "##" {
            return Ok(out);
        }
        // Expect "#<len>" — `read_line` left the leading newline off a prior
        // chunk's trailing newline; if the line is empty, read again.
        let hdr = if hdr.is_empty() {
            let mut h2 = String::new();
            let n2 = reader.read_line(&mut h2).await?;
            if n2 == 0 {
                return Err(NetconfError::Framing("eof in chunked framing".into()));
            }
            h2.trim_end_matches('\n').to_string()
        } else {
            hdr.to_string()
        };
        if hdr == "##" {
            return Ok(out);
        }
        let Some(rest) = hdr.strip_prefix('#') else {
            return Err(NetconfError::Framing(format!("bad chunk header: {hdr:?}")));
        };
        let len: usize = rest
            .parse()
            .map_err(|_| NetconfError::Framing(format!("bad chunk length: {rest:?}")))?;
        let mut chunk = vec![0u8; len];
        reader.read_exact(&mut chunk).await?;
        out.extend_from_slice(&chunk);
    }
}
```

- [ ] **Step 4.2: Register the submodule**

Edit `src-tauri/src/netconf_runner/mod.rs`:

```rust
pub mod error;
pub mod framing;
pub mod session_store;
```

- [ ] **Step 4.3: Run the tests — expect pass**

Run: `cd src-tauri && cargo test --test netconf_framing_test`
Expected: 7 tests pass.

- [ ] **Step 4.4: Commit**

```bash
git add src-tauri/src/netconf_runner/ src-tauri/tests/netconf_framing_test.rs
git commit -m "feat(netconf): RFC 6242 framing (1.0 end-of-message + 1.1 chunked)"
```

---

## Task 5: Hello parse — failing tests

**Files:**
- Create: `src-tauri/tests/netconf_hello_test.rs`

- [ ] **Step 5.1: Write the failing test**

```rust
//! Parsing real NETCONF hello messages from Cisco IOS-XE devices.

use ccie_terminal_lib::netconf_runner::hello;

/// Abbreviated but structurally realistic IOS-XE hello.
const IOSXE_HELLO: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
  <capabilities>
    <capability>urn:ietf:params:netconf:base:1.0</capability>
    <capability>urn:ietf:params:netconf:base:1.1</capability>
    <capability>urn:ietf:params:netconf:capability:writable-running:1.0</capability>
    <capability>urn:ietf:params:netconf:capability:candidate:1.0</capability>
  </capabilities>
  <session-id>42</session-id>
</hello>"#;

#[test]
fn parse_extracts_session_id_and_capabilities() {
    let parsed = hello::parse(IOSXE_HELLO).unwrap();
    assert_eq!(parsed.session_id, 42);
    assert!(parsed
        .capabilities
        .iter()
        .any(|c| c == "urn:ietf:params:netconf:base:1.0"));
    assert!(parsed
        .capabilities
        .iter()
        .any(|c| c == "urn:ietf:params:netconf:base:1.1"));
    assert_eq!(parsed.capabilities.len(), 4);
}

#[test]
fn chooses_1_1_when_both_advertised() {
    let parsed = hello::parse(IOSXE_HELLO).unwrap();
    assert_eq!(parsed.framing(), hello::Framing::Chunked);
}

#[test]
fn falls_back_to_1_0_when_only_base_advertised() {
    let only_10 = r#"<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
      <capabilities><capability>urn:ietf:params:netconf:base:1.0</capability></capabilities>
      <session-id>7</session-id></hello>"#;
    let parsed = hello::parse(only_10).unwrap();
    assert_eq!(parsed.framing(), hello::Framing::EndOfMessage);
}

#[test]
fn errors_on_missing_session_id() {
    let bad = r#"<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
      <capabilities><capability>urn:ietf:params:netconf:base:1.0</capability></capabilities>
      </hello>"#;
    let err = hello::parse(bad).unwrap_err();
    assert!(format!("{err}").contains("session-id"), "got {err}");
}

#[test]
fn build_our_hello_advertises_both_base_versions() {
    let xml = hello::build_client_hello();
    assert!(xml.contains("urn:ietf:params:netconf:base:1.0"));
    assert!(xml.contains("urn:ietf:params:netconf:base:1.1"));
    assert!(xml.starts_with("<?xml"));
    assert!(xml.contains("<hello"));
}
```

- [ ] **Step 5.2: Run to verify failure**

Run: `cd src-tauri && cargo test --test netconf_hello_test`
Expected: `unresolved import`.

---

## Task 6: Hello parse — implement

**Files:**
- Create: `src-tauri/src/netconf_runner/hello.rs`
- Modify: `src-tauri/src/netconf_runner/mod.rs`

- [ ] **Step 6.1: Implement `hello`**

`src-tauri/src/netconf_runner/hello.rs`:

```rust
//! Parse and build NETCONF `<hello>` messages.

use quick_xml::events::Event;
use quick_xml::Reader;

use super::error::{NetconfError, Result};

pub const BASE_1_0: &str = "urn:ietf:params:netconf:base:1.0";
pub const BASE_1_1: &str = "urn:ietf:params:netconf:base:1.1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Framing {
    /// RFC 6242 §4.1 (NETCONF 1.0): `]]>]]>` end-of-message.
    EndOfMessage,
    /// RFC 6242 §4.2 (NETCONF 1.1): chunked.
    Chunked,
}

#[derive(Debug, Clone)]
pub struct ServerHello {
    pub session_id: u64,
    pub capabilities: Vec<String>,
}

impl ServerHello {
    /// Choose chunked framing only when the server advertises 1.1; otherwise
    /// stay on 1.0 end-of-message framing.
    pub fn framing(&self) -> Framing {
        if self.capabilities.iter().any(|c| c == BASE_1_1) {
            Framing::Chunked
        } else {
            Framing::EndOfMessage
        }
    }
}

/// Parse a server `<hello>` message.
pub fn parse(xml: &str) -> Result<ServerHello> {
    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);

    let mut capabilities: Vec<String> = Vec::new();
    let mut session_id: Option<u64> = None;
    let mut in_capability = false;
    let mut in_session_id = false;
    let mut buf = Vec::new();

    loop {
        match reader
            .read_event_into(&mut buf)
            .map_err(|e| NetconfError::Hello(e.to_string()))?
        {
            Event::Start(e) => {
                let name = e.name();
                let local = name.as_ref();
                let local = local.rsplit(|b| *b == b':').next().unwrap_or(local);
                match local {
                    b"capability" => in_capability = true,
                    b"session-id" => in_session_id = true,
                    _ => {}
                }
            }
            Event::End(_) => {
                in_capability = false;
                in_session_id = false;
            }
            Event::Text(t) => {
                let text = t
                    .unescape()
                    .map_err(|e| NetconfError::Hello(e.to_string()))?
                    .into_owned();
                if in_capability {
                    capabilities.push(text);
                } else if in_session_id {
                    session_id = Some(
                        text.trim()
                            .parse()
                            .map_err(|_| NetconfError::Hello(format!("bad session-id: {text}")))?,
                    );
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    let session_id = session_id.ok_or_else(|| NetconfError::Hello("missing session-id".into()))?;
    Ok(ServerHello {
        session_id,
        capabilities,
    })
}

/// Build our client `<hello>` advertising both base versions.
pub fn build_client_hello() -> String {
    format!(
        concat!(
            r#"<?xml version="1.0" encoding="UTF-8"?>"#,
            "\n",
            r#"<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">"#,
            "\n",
            "  <capabilities>\n",
            "    <capability>{}</capability>\n",
            "    <capability>{}</capability>\n",
            "  </capabilities>\n",
            "</hello>",
        ),
        BASE_1_0, BASE_1_1,
    )
}
```

- [ ] **Step 6.2: Register the submodule**

Edit `src-tauri/src/netconf_runner/mod.rs`:

```rust
pub mod error;
pub mod framing;
pub mod hello;
pub mod session_store;
```

- [ ] **Step 6.3: Run tests — expect pass**

Run: `cd src-tauri && cargo test --test netconf_hello_test`
Expected: 5 tests pass.

- [ ] **Step 6.4: Commit**

```bash
git add src-tauri/src/netconf_runner/hello.rs src-tauri/src/netconf_runner/mod.rs src-tauri/tests/netconf_hello_test.rs
git commit -m "feat(netconf): parse server hello + build client hello"
```

---

## Task 7: Transport + Session — no separate unit test

Reason: this wraps `russh` and needs a real SSH server to test. We'll cover it with a live integration test in Task 10, gated behind an env var. The `transport` + `session` modules are narrow glue and their correctness is checked end-to-end.

**Files:**
- Create: `src-tauri/src/netconf_runner/transport.rs`
- Create: `src-tauri/src/netconf_runner/session.rs`
- Create: `src-tauri/src/netconf_runner/registry.rs`
- Modify: `src-tauri/src/netconf_runner/mod.rs`

- [ ] **Step 7.1: Write `transport.rs`**

`src-tauri/src/netconf_runner/transport.rs`:

```rust
//! SSH transport for NETCONF. Opens a russh client channel and requests the
//! `netconf` subsystem. Returns a bidirectional `ChannelStream` the rest of
//! the module treats as AsyncRead + AsyncWrite.

use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle, Handler};
use russh::keys::ssh_key::PublicKey;

use super::error::{NetconfError, Result};

/// Minimal handler: we don't verify host keys yet (hostkey_verify flag
/// in `netconf_devices` defaults to 0). Wire real verification in Step 4.
struct AcceptAll;

impl Handler for AcceptAll {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        Ok(true)
    }
}

/// Opaque bidirectional byte stream over the NETCONF subsystem.
pub type NetconfStream = russh::ChannelStream<client::Msg>;

pub struct ConnectArgs {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub connect_timeout: Duration,
}

pub struct ConnectedChannel {
    /// Keep the client handle alive for the lifetime of the session. Dropping
    /// it closes the underlying SSH connection.
    pub _session: Handle<AcceptAll>,
    pub stream: NetconfStream,
}

pub async fn connect_and_open_subsystem(args: ConnectArgs) -> Result<ConnectedChannel> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        ..client::Config::default()
    });
    let mut session = tokio::time::timeout(
        args.connect_timeout,
        client::connect(config, (args.host.as_str(), args.port), AcceptAll),
    )
    .await
    .map_err(|_| NetconfError::Timeout {
        secs: args.connect_timeout.as_secs(),
    })??;

    let auth = session
        .authenticate_password(args.username, args.password)
        .await?;
    if !auth.success() {
        return Err(NetconfError::AuthFailed);
    }

    let channel = session.channel_open_session().await?;
    channel.request_subsystem(true, "netconf").await?;
    let stream = channel.into_stream();

    Ok(ConnectedChannel {
        _session: session,
        stream,
    })
}
```

- [ ] **Step 7.2: Make `AcceptAll` public in `transport.rs`**

Session needs to name the handler type in its own struct field. Change the handler declaration:

```rust
pub struct AcceptAll;
```

- [ ] **Step 7.3: Write `session.rs`**

`src-tauri/src/netconf_runner/session.rs`:

```rust
//! Per-device NETCONF session: owns the SSH stream, tracks message-id, knows
//! the negotiated framing mode. `send_rpc` is pipelined one-in-one-out.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::io::{AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use super::error::{NetconfError, Result};
use super::framing::{decode_chunked, decode_eom, encode_chunked, encode_eom};
use super::hello::{self, Framing};
use super::transport::{connect_and_open_subsystem, AcceptAll, ConnectArgs, ConnectedChannel, NetconfStream};

pub struct Session {
    inner: Mutex<Inner>,
    pub server_session_id: u64,
    pub capabilities: Vec<String>,
    pub framing: Framing,
    message_id: AtomicU64,
}

struct Inner {
    reader: BufReader<tokio::io::ReadHalf<NetconfStream>>,
    writer: tokio::io::WriteHalf<NetconfStream>,
    /// Keep the russh Handle alive for the lifetime of the session; dropping
    /// it closes the underlying SSH connection.
    _keepalive: russh::client::Handle<AcceptAll>,
}

impl Session {
    /// Connect, exchange `<hello>`, return a session ready for RPCs.
    pub async fn open(args: ConnectArgs) -> Result<Self> {
        let rpc_timeout = Duration::from_secs(30);

        let ConnectedChannel { _session, stream } = connect_and_open_subsystem(args).await?;
        let (read_half, mut write_half) = tokio::io::split(stream);
        let mut reader = BufReader::new(read_half);

        // Hello exchange uses end-of-message framing on both sides until both
        // peers advertise NETCONF 1.1; then we upgrade for RPCs.
        let our_hello = hello::build_client_hello();
        let encoded = encode_eom(our_hello.as_bytes());
        tokio::time::timeout(rpc_timeout, write_half.write_all(&encoded))
            .await
            .map_err(|_| NetconfError::Timeout { secs: 30 })??;
        write_half.flush().await?;

        let server_hello_bytes = tokio::time::timeout(rpc_timeout, decode_eom(&mut reader))
            .await
            .map_err(|_| NetconfError::Timeout { secs: 30 })??;
        let server_hello_str = std::str::from_utf8(&server_hello_bytes)
            .map_err(|e| NetconfError::Hello(e.to_string()))?;
        let parsed = hello::parse(server_hello_str)?;
        let framing = parsed.framing();

        Ok(Session {
            inner: Mutex::new(Inner {
                reader,
                writer: write_half,
                _keepalive: _session,
            }),
            server_session_id: parsed.session_id,
            capabilities: parsed.capabilities,
            framing,
            message_id: AtomicU64::new(0),
        })
    }

    fn next_message_id(&self) -> u64 {
        self.message_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Send one `<rpc>` and read the next framed reply. If the supplied XML
    /// lacks a `message-id` attribute, we wrap it in a minimal `<rpc>` envelope.
    pub async fn send_rpc(&self, rpc_xml: &str) -> Result<String> {
        let id = self.next_message_id();
        let wrapped = if rpc_xml.contains("message-id=") {
            rpc_xml.to_string()
        } else {
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?><rpc message-id="{id}" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">{rpc_xml}</rpc>"#
            )
        };

        let mut inner = self.inner.lock().await;
        let encoded = match self.framing {
            Framing::EndOfMessage => encode_eom(wrapped.as_bytes()),
            Framing::Chunked => encode_chunked(wrapped.as_bytes()),
        };
        inner.writer.write_all(&encoded).await?;
        inner.writer.flush().await?;

        let reply = match self.framing {
            Framing::EndOfMessage => decode_eom(&mut inner.reader).await?,
            Framing::Chunked => decode_chunked(&mut inner.reader).await?,
        };
        String::from_utf8(reply).map_err(|e| NetconfError::Rpc(e.to_string()))
    }
}
```

- [ ] **Step 7.4: Write `registry.rs`**

`src-tauri/src/netconf_runner/registry.rs`:

```rust
//! Global session registry. Sessions are keyed by an opaque UUID; the
//! frontend holds the id, the registry holds the `Arc<Session>`. Dropping
//! the Arc closes the SSH connection (via russh's Handle Drop).

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use uuid::Uuid;

use super::error::{NetconfError, Result};
use super::session::Session;

pub type SessionId = String;

#[derive(Default)]
pub struct SessionRegistry {
    inner: Mutex<HashMap<SessionId, Arc<Session>>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, session: Session) -> SessionId {
        let id = Uuid::new_v4().to_string();
        self.inner.lock().insert(id.clone(), Arc::new(session));
        id
    }

    pub fn get(&self, id: &str) -> Result<Arc<Session>> {
        self.inner
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| NetconfError::SessionNotFound(id.to_string()))
    }

    #[allow(dead_code)] // used by disconnect command in Step 3
    pub fn remove(&self, id: &str) {
        self.inner.lock().remove(id);
    }
}
```

- [ ] **Step 7.5: Register submodules**

Edit `src-tauri/src/netconf_runner/mod.rs`:

```rust
pub mod error;
pub mod framing;
pub mod hello;
pub mod registry;
pub mod session;
pub mod session_store;
pub mod transport;
```

- [ ] **Step 7.6: Verify the whole crate compiles**

Run: `cd src-tauri && cargo check --lib`
Expected: clean `Finished` (warnings are OK).

- [ ] **Step 7.7: Commit**

```bash
git add src-tauri/src/netconf_runner/
git commit -m "feat(netconf): SSH transport + Session + SessionRegistry"
```

---

## Task 8: Tauri commands `netconf_connect` + `netconf_send_rpc`

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 8.1: Extend `AppState` with the registry**

In `src-tauri/src/lib.rs`, find the `AppState` struct (look for `pub struct AppState`). Add a field:

```rust
pub netconf_registry: std::sync::Arc<crate::netconf_runner::registry::SessionRegistry>,
```

And initialize it wherever `AppState` is constructed (search `AppState {` in lib.rs — typically in the `setup` closure):

```rust
netconf_registry: std::sync::Arc::new(
    crate::netconf_runner::registry::SessionRegistry::new(),
),
```

- [ ] **Step 8.2: Add the two commands in `commands.rs`**

Insert after `tab_close_netconf` (the last netconf command so far):

```rust
use crate::netconf_runner::{registry::SessionId, session::Session, transport::ConnectArgs};
use std::time::Duration;

#[derive(serde::Serialize)]
pub struct NetconfConnectResult {
    pub session_id: SessionId,
    pub server_session_id: u64,
    pub capabilities: Vec<String>,
    pub framing: String,
}

/// Open a NETCONF session over SSH, do the hello exchange, return an opaque
/// session_id the frontend can use for subsequent `netconf_send_rpc` calls
/// plus the device's advertised capabilities.
#[tauri::command]
pub async fn netconf_connect(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: String,
    password: String,
) -> Result<NetconfConnectResult, String> {
    let registry = state.netconf_registry.clone();
    let session = Session::open(ConnectArgs {
        host: host.clone(),
        port,
        username,
        password,
        connect_timeout: Duration::from_secs(15),
    })
    .await
    .map_err(|e| e.to_string())?;

    let server_session_id = session.server_session_id;
    let capabilities = session.capabilities.clone();
    let framing = match session.framing {
        crate::netconf_runner::hello::Framing::EndOfMessage => "1.0".to_string(),
        crate::netconf_runner::hello::Framing::Chunked => "1.1".to_string(),
    };
    let session_id = registry.insert(session);

    tracing::info!(host = %host, port = port, session_id = %session_id, "NETCONF session opened");

    Ok(NetconfConnectResult {
        session_id,
        server_session_id,
        capabilities,
        framing,
    })
}

/// Send one `<rpc>` over an existing session, return the raw `<rpc-reply>` XML.
/// No parsing, no history write — those live in a later phase.
#[tauri::command]
pub async fn netconf_send_rpc(
    state: State<'_, AppState>,
    session_id: String,
    rpc_xml: String,
) -> Result<String, String> {
    let session = state
        .netconf_registry
        .get(&session_id)
        .map_err(|e| e.to_string())?;
    session.send_rpc(&rpc_xml).await.map_err(|e| e.to_string())
}
```

- [ ] **Step 8.3: Register both commands in `lib.rs`**

In the `tauri::generate_handler!` macro block in `src-tauri/src/lib.rs`, add these after `commands::tab_close_netconf,`:

```rust
commands::netconf_connect,
commands::netconf_send_rpc,
```

- [ ] **Step 8.4: Verify compile**

Run: `cd src-tauri && cargo check && cargo test --lib`
Expected: clean compile; unit tests still pass.

- [ ] **Step 8.5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(netconf): Tauri commands netconf_connect and netconf_send_rpc"
```

---

## Task 9: Frontend wrappers

**Files:**
- Modify: `src/lib/tauri.ts`

- [ ] **Step 9.1: Append wrappers**

Add after `tabCloseNetconf` in `src/lib/tauri.ts`:

```ts
export type NetconfConnectArgs = {
  host: string;
  port: number;
  username: string;
  password: string;
};

export type NetconfConnectResult = {
  session_id: string;
  server_session_id: number;
  capabilities: string[];
  /** "1.0" for end-of-message framing, "1.1" for chunked. */
  framing: "1.0" | "1.1";
};

/** Open a NETCONF session (SSH + hello exchange). Returns an opaque session_id. */
export const netconfConnect = (args: NetconfConnectArgs) =>
  invoke<NetconfConnectResult>("netconf_connect", args);

/** Send a single <rpc> over an existing session. Returns raw <rpc-reply> XML. */
export const netconfSendRpc = (sessionId: string, rpcXml: string) =>
  invoke<string>("netconf_send_rpc", { sessionId, rpcXml });
```

- [ ] **Step 9.2: Verify no type errors**

Run: `cd /Users/shaunwhi/CCIE\ Terminal && npx tsc --noEmit 2>&1 | grep -iE "netconf|tauri\.ts" | head`
Expected: no matches (no new errors in touched files; pre-existing errors elsewhere are unrelated).

- [ ] **Step 9.3: Commit**

```bash
git add src/lib/tauri.ts
git commit -m "feat(netconf): typed TS wrappers for netconf_connect + netconf_send_rpc"
```

---

## Task 10: Live verification against 172.16.6.2

This is a **manual** task that requires the lab device reachable. No code changes.

- [ ] **Step 10.1: Launch the app**

Run: `npm run tauri dev`
Expected: app boots, no console errors.

- [ ] **Step 10.2: Open the NETCONF tab**

Click `+ NETCONF`. Placeholder card renders.

- [ ] **Step 10.3: Temporarily wire a minimal test UI — skip for now**

The UI with inputs for host/port/user/password lands in Step 4. For this step, verify end-to-end from the Tauri devtools console instead:

Open devtools (right-click → Inspect, or ⌘⌥I). In the console:

```js
const r = await window.__TAURI__.core.invoke("netconf_connect", {
  host: "172.16.6.2",
  port: 830,
  username: "cisco",
  password: "password1",
});
console.log(r);
```

Expected: an object like `{ session_id: "…", server_session_id: 123, capabilities: [...], framing: "1.1" }`. The capabilities list should include `urn:ietf:params:netconf:base:1.0` and likely `urn:ietf:params:netconf:base:1.1` (framing should be `"1.1"` on modern IOS-XE).

- [ ] **Step 10.4: Send a simple RPC**

In the same console, using the `session_id` from Step 10.3:

```js
const reply = await window.__TAURI__.core.invoke("netconf_send_rpc", {
  sessionId: r.session_id,
  rpcXml: "<get-config><source><running/></source></get-config>",
});
console.log(reply);
```

Expected: A string that starts with `<?xml` or `<rpc-reply` and contains a big chunk of the running-config wrapped in `<rpc-reply>…</rpc-reply>`.

- [ ] **Step 10.5: Stress-check — rapid-fire RPCs on the same session**

```js
for (let i = 0; i < 5; i++) {
  const reply = await window.__TAURI__.core.invoke("netconf_send_rpc", {
    sessionId: r.session_id,
    rpcXml: "<get><filter type=\"subtree\"><native xmlns=\"http://cisco.com/ns/yang/Cisco-IOS-XE-native\"><hostname/></native></filter></get>",
  });
  console.log(`reply ${i}:`, reply.slice(0, 200));
}
```

Expected: 5 replies, each containing the device hostname, each returning within ~100-500ms (session is already open; only the RPC round-trip is on the wire).

- [ ] **Step 10.6: Error path — bad XML**

```js
await window.__TAURI__.core.invoke("netconf_send_rpc", {
  sessionId: r.session_id,
  rpcXml: "<total-nonsense/>",
});
```

Expected: either the device returns an `<rpc-reply>` containing `<rpc-error>` (normal NETCONF error — we surface it as a string), or our code errors cleanly. Not a hang. Not a crash.

- [ ] **Step 10.7: Error path — wrong password**

From a fresh console:

```js
await window.__TAURI__.core.invoke("netconf_connect", {
  host: "172.16.6.2", port: 830, username: "cisco", password: "wrong",
});
```

Expected: promise rejects with the string `"authentication failed"`.

- [ ] **Step 10.8: Report result**

Note in a short log: what framing was negotiated (1.0 or 1.1), how many capabilities the device advertised, approximate RPC round-trip time, and any unexpected errors. If everything worked, Step 2 is done.

---

## Self-review checklist

- [ ] `cargo test` (src-tauri): all existing tests + the 2 new ones (framing, hello) pass.
- [ ] `cargo check --lib` warns but does not error.
- [ ] TS typecheck: no new errors in `tauri.ts`.
- [ ] Live smoke against 172.16.6.2 succeeds (Task 10).
- [ ] `git log --oneline` shows ~6 new commits.

## What this plan does NOT cover

- `netconf_disconnect` command (deferred to Step 4 when the Connection UI lands; explicit disconnect button there).
- History writes (a future step once `netconf_history` DB code lands).
- Candidate-datastore locking / multi-RPC transactions (the stateless-per-call approach we considered is obsolete; the long-lived session we have here supports them, we just haven't exposed UI yet).
- Host-key verification (the `hostkey_verify` flag in `netconf_devices` is wired but always accepts — real verification lands in Step 4 alongside saved-device storage).
- Certificate/SSH-key auth (password only for now).
