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
pub struct AcceptAll;

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
