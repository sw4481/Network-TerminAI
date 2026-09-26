//! Per-device NETCONF session: owns the SSH stream, tracks message-id, knows
//! the negotiated framing mode. `send_rpc` is pipelined one-in-one-out.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::io::{AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use super::error::{NetconfError, Result};
use super::framing::{decode_chunked, decode_eom, encode_chunked, encode_eom};
use super::hello::{self, Framing};
use super::transport::{
    connect_and_open_subsystem, AcceptAll, ConnectArgs, ConnectedChannel, NetconfStream,
};

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
