//! NETCONF message framing tests (RFC 6242 §4.1 end-of-message + §4.2 chunked).

use ccie_terminal_lib::netconf_runner::framing;
use tokio::io::{duplex, AsyncWriteExt};

#[tokio::test]
async fn encode_eom_wraps_message_with_delimiter() {
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
