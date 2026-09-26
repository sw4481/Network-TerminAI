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
    reader.config_mut().trim_text(true);

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
                    .decode()
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
