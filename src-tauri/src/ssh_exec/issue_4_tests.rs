//! Issue #4: `run_command` must work without `sshpass` (Windows). These tests
//! drive the native russh path against an in-process SSH server.

use std::sync::Arc;
use std::time::Duration;

use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::PrivateKey;
use russh::server::{Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId};
use tokio::net::TcpListener;

use super::*;

#[derive(Clone)]
struct TestServer;

impl russh::server::Server for TestServer {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}

impl russh::server::Handler for TestServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == "cisco" && password == "password1" {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        match String::from_utf8_lossy(data).as_ref() {
            "show version" => {
                session.data(channel, b"IOS 15.2\n".to_vec())?;
                session.exit_status_request(channel, 0)?;
            }
            "bad command" => {
                session.extended_data(channel, 1, b"% Invalid input\n".to_vec())?;
                session.exit_status_request(channel, 2)?;
            }
            "hang" => return Ok(()),
            _ => {
                session.exit_status_request(channel, 0)?;
            }
        }
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
}

async fn start_server() -> u16 {
    let key = PrivateKey::from(Ed25519Keypair::from_seed(&[7u8; 32]));
    let config = Arc::new(russh::server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::from_millis(0),
        auth_rejection_time_initial: Some(Duration::from_millis(0)),
        ..Default::default()
    });
    let socket = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = socket.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut server = TestServer;
        let _ = server.run_on_socket(config, &socket).await;
    });
    port
}

fn target(port: u16, password: &str) -> SshTarget {
    SshTarget {
        host: "127.0.0.1".to_string(),
        port,
        username: "cisco".to_string(),
        password: password.to_string(),
    }
}

#[tokio::test]
async fn russh_path_returns_stdout() {
    let port = start_server().await;
    let out = run_command_russh(
        &target(port, "password1"),
        "show version",
        DEFAULT_CMD_TIMEOUT,
    )
    .await
    .unwrap();
    assert_eq!(out, "IOS 15.2\n");
}

#[tokio::test]
async fn russh_path_reports_non_zero_exit_with_stderr() {
    let port = start_server().await;
    let err = run_command_russh(
        &target(port, "password1"),
        "bad command",
        DEFAULT_CMD_TIMEOUT,
    )
    .await
    .unwrap_err();
    assert!(matches!(&err, SshExecError::NonZeroExit(s) if s.contains("Invalid input")));
}

#[tokio::test]
async fn russh_path_rejects_bad_password() {
    let port = start_server().await;
    let err = run_command_russh(&target(port, "wrong"), "show version", DEFAULT_CMD_TIMEOUT)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("authentication"), "got: {err}");
}

#[tokio::test]
async fn russh_path_times_out() {
    let port = start_server().await;
    let err = run_command_russh(
        &target(port, "password1"),
        "hang",
        Duration::from_millis(500),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, SshExecError::Timeout), "got: {err}");
}
