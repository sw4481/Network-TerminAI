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
        // If read_line returned an empty trimmed line, it consumed the leading
        // newline of the next chunk header; read the header itself on the
        // following line.
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
