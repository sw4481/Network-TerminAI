//! Focused USB serial-console service.
//!
//! Each session is owned by one worker thread. Serial sessions intentionally
//! never enter the PTY/tab registries, persistence, recording, or AI pipeline.

use crate::commands::AppState;
use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serialport::{
    DataBits, FlowControl, Parity, SerialPort, SerialPortInfo, SerialPortType, StopBits,
};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::{mpsc, Arc};
use std::time::Duration;
use tauri::{ipc::Channel, State};
use uuid::Uuid;

const READ_TIMEOUT: Duration = Duration::from_millis(100);
const RECONNECT_INTERVAL: Duration = Duration::from_secs(1);
const BREAK_DURATION: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SerialPortDescriptor {
    pub port_name: String,
    pub port_type: String,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub serial_number: Option<String>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
}

impl From<SerialPortInfo> for SerialPortDescriptor {
    fn from(info: SerialPortInfo) -> Self {
        match info.port_type {
            SerialPortType::UsbPort(usb) => Self {
                port_name: info.port_name,
                port_type: "usb".into(),
                vid: Some(usb.vid),
                pid: Some(usb.pid),
                serial_number: usb.serial_number,
                manufacturer: usb.manufacturer,
                product: usb.product,
            },
            SerialPortType::BluetoothPort => Self {
                port_name: info.port_name,
                port_type: "bluetooth".into(),
                vid: None,
                pid: None,
                serial_number: None,
                manufacturer: None,
                product: None,
            },
            SerialPortType::PciPort => Self {
                port_name: info.port_name,
                port_type: "pci".into(),
                vid: None,
                pid: None,
                serial_number: None,
                manufacturer: None,
                product: None,
            },
            SerialPortType::Unknown => Self {
                port_name: info.port_name,
                port_type: "unknown".into(),
                vid: None,
                pid: None,
                serial_number: None,
                manufacturer: None,
                product: None,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SerialDataBits {
    Seven,
    #[default]
    Eight,
}

impl From<SerialDataBits> for DataBits {
    fn from(value: SerialDataBits) -> Self {
        match value {
            SerialDataBits::Seven => DataBits::Seven,
            SerialDataBits::Eight => DataBits::Eight,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SerialParity {
    #[default]
    None,
    Even,
    Odd,
}

impl From<SerialParity> for Parity {
    fn from(value: SerialParity) -> Self {
        match value {
            SerialParity::None => Parity::None,
            SerialParity::Even => Parity::Even,
            SerialParity::Odd => Parity::Odd,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SerialStopBits {
    #[default]
    One,
    Two,
}

impl From<SerialStopBits> for StopBits {
    fn from(value: SerialStopBits) -> Self {
        match value {
            SerialStopBits::One => StopBits::One,
            SerialStopBits::Two => StopBits::Two,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SerialFlowControl {
    #[default]
    None,
    Software,
    Hardware,
}

impl From<SerialFlowControl> for FlowControl {
    fn from(value: SerialFlowControl) -> Self {
        match value {
            SerialFlowControl::None => FlowControl::None,
            SerialFlowControl::Software => FlowControl::Software,
            SerialFlowControl::Hardware => FlowControl::Hardware,
        }
    }
}

fn default_baud_rate() -> u32 {
    9_600
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct SerialOpenConfig {
    pub port_name: String,
    #[serde(default = "default_baud_rate")]
    pub baud_rate: u32,
    #[serde(default)]
    pub data_bits: SerialDataBits,
    #[serde(default)]
    pub parity: SerialParity,
    #[serde(default)]
    pub stop_bits: SerialStopBits,
    #[serde(default)]
    pub flow_control: SerialFlowControl,
}

impl SerialOpenConfig {
    fn validate(&mut self) -> Result<()> {
        self.port_name = self.port_name.trim().to_string();
        if self.port_name.is_empty() {
            return Err(anyhow!("serial port name is required"));
        }
        if self.baud_rate == 0 || self.baud_rate > 4_000_000 {
            return Err(anyhow!("serial baud rate must be between 1 and 4000000"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SerialEvent {
    Data {
        session_id: String,
        bytes: Vec<u8>,
    },
    Connected {
        session_id: String,
        port_name: String,
    },
    Reconnecting {
        session_id: String,
        port_name: String,
        message: Option<String>,
    },
    Disconnected {
        session_id: String,
        reason: String,
    },
    Error {
        session_id: String,
        message: String,
    },
}

enum SerialCommand {
    Write(Vec<u8>),
    SendBreak,
    Close,
}

trait ManagedSerialPort: Send {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize>;
    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()>;
    fn flush(&mut self) -> io::Result<()>;
    fn set_break(&self) -> std::result::Result<(), serialport::Error>;
    fn clear_break(&self) -> std::result::Result<(), serialport::Error>;
}

struct RealManagedPort(Box<dyn SerialPort>);

impl ManagedSerialPort for RealManagedPort {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        Read::read(&mut self.0, buffer)
    }

    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        Write::write_all(&mut self.0, bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        Write::flush(&mut self.0)
    }

    fn set_break(&self) -> std::result::Result<(), serialport::Error> {
        self.0.set_break()
    }

    fn clear_break(&self) -> std::result::Result<(), serialport::Error> {
        self.0.clear_break()
    }
}

trait SerialProvider: Send + Sync {
    fn list_ports(&self) -> Result<Vec<SerialPortDescriptor>>;
    fn open(
        &self,
        config: &SerialOpenConfig,
        port_name: &str,
    ) -> Result<Box<dyn ManagedSerialPort>>;
}

struct RealSerialProvider;

impl SerialProvider for RealSerialProvider {
    fn list_ports(&self) -> Result<Vec<SerialPortDescriptor>> {
        serialport::available_ports()
            .context("enumerate serial ports")
            .map(|ports| ports.into_iter().map(Into::into).collect())
    }

    fn open(
        &self,
        config: &SerialOpenConfig,
        port_name: &str,
    ) -> Result<Box<dyn ManagedSerialPort>> {
        let port = serialport::new(port_name, config.baud_rate)
            .data_bits(config.data_bits.into())
            .parity(config.parity.into())
            .stop_bits(config.stop_bits.into())
            .flow_control(config.flow_control.into())
            .timeout(READ_TIMEOUT)
            .open()
            .with_context(|| format!("open serial port {port_name}"))?;
        Ok(Box::new(RealManagedPort(port)))
    }
}

trait SerialEventSink: Send + Sync {
    fn send(&self, event: SerialEvent);
}

struct ChannelEventSink(Channel<SerialEvent>);

impl SerialEventSink for ChannelEventSink {
    fn send(&self, event: SerialEvent) {
        let _ = self.0.send(event);
    }
}

#[derive(Debug, Clone)]
struct ReconnectIdentity {
    original_port_name: String,
    usb_serial_number: Option<String>,
}

fn select_reconnect_port(
    identity: &ReconnectIdentity,
    ports: &[SerialPortDescriptor],
) -> Option<String> {
    if let Some(serial_number) = identity.usb_serial_number.as_deref() {
        let matches = ports
            .iter()
            .filter(|port| port.serial_number.as_deref() == Some(serial_number))
            .collect::<Vec<_>>();
        if matches.len() == 1 {
            return Some(matches[0].port_name.clone());
        }
        return matches
            .into_iter()
            .find(|port| port.port_name == identity.original_port_name)
            .map(|port| port.port_name.clone());
    }
    ports
        .iter()
        .find(|port| port.port_name == identity.original_port_name)
        .map(|port| port.port_name.clone())
}

fn send_error(sink: &dyn SerialEventSink, session_id: &str, message: impl Into<String>) {
    sink.send(SerialEvent::Error {
        session_id: session_id.to_string(),
        message: message.into(),
    });
}

enum CommandOutcome {
    Continue,
    ConnectionLost(String),
    Close,
}

fn handle_command(
    command: SerialCommand,
    port: &mut dyn ManagedSerialPort,
    session_id: &str,
    sink: &dyn SerialEventSink,
) -> CommandOutcome {
    match command {
        SerialCommand::Write(bytes) => {
            if let Err(error) = port.write_all(&bytes).and_then(|_| port.flush()) {
                send_error(sink, session_id, format!("serial write failed: {error}"));
                return CommandOutcome::ConnectionLost(error.to_string());
            }
            CommandOutcome::Continue
        }
        SerialCommand::SendBreak => {
            if let Err(error) = port.set_break() {
                send_error(
                    sink,
                    session_id,
                    format!("set serial Break failed: {error}"),
                );
                return CommandOutcome::Continue;
            }
            std::thread::sleep(BREAK_DURATION);
            if let Err(error) = port.clear_break() {
                send_error(
                    sink,
                    session_id,
                    format!("clear serial Break failed: {error}"),
                );
            }
            CommandOutcome::Continue
        }
        SerialCommand::Close => CommandOutcome::Close,
    }
}

fn reconnect(
    provider: &dyn SerialProvider,
    config: &SerialOpenConfig,
    identity: &ReconnectIdentity,
    session_id: &str,
    receiver: &mpsc::Receiver<SerialCommand>,
    sink: &dyn SerialEventSink,
) -> Option<(Box<dyn ManagedSerialPort>, String)> {
    loop {
        match receiver.recv_timeout(RECONNECT_INTERVAL) {
            Ok(SerialCommand::Close) | Err(mpsc::RecvTimeoutError::Disconnected) => return None,
            Ok(SerialCommand::Write(_)) | Ok(SerialCommand::SendBreak) => {
                // Input is intentionally discarded while reconnecting. The UI
                // disables xterm input as soon as it receives this state.
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        let ports = match provider.list_ports() {
            Ok(ports) => ports,
            Err(error) => {
                sink.send(SerialEvent::Reconnecting {
                    session_id: session_id.to_string(),
                    port_name: identity.original_port_name.clone(),
                    message: Some(error.to_string()),
                });
                continue;
            }
        };
        let Some(port_name) = select_reconnect_port(identity, &ports) else {
            sink.send(SerialEvent::Reconnecting {
                session_id: session_id.to_string(),
                port_name: identity.original_port_name.clone(),
                message: None,
            });
            continue;
        };
        match provider.open(config, &port_name) {
            Ok(port) => return Some((port, port_name)),
            Err(error) => sink.send(SerialEvent::Reconnecting {
                session_id: session_id.to_string(),
                port_name,
                message: Some(error.to_string()),
            }),
        }
    }
}

fn run_worker(
    provider: Arc<dyn SerialProvider>,
    config: SerialOpenConfig,
    identity: ReconnectIdentity,
    session_id: String,
    receiver: mpsc::Receiver<SerialCommand>,
    sink: Arc<dyn SerialEventSink>,
    mut port: Box<dyn ManagedSerialPort>,
) {
    let mut active_port_name = config.port_name.clone();
    sink.send(SerialEvent::Connected {
        session_id: session_id.clone(),
        port_name: active_port_name.clone(),
    });
    let mut buffer = vec![0u8; 4096];

    'session: loop {
        while let Ok(command) = receiver.try_recv() {
            match handle_command(command, port.as_mut(), &session_id, sink.as_ref()) {
                CommandOutcome::Continue => {}
                CommandOutcome::Close => break 'session,
                CommandOutcome::ConnectionLost(reason) => {
                    sink.send(SerialEvent::Disconnected {
                        session_id: session_id.clone(),
                        reason,
                    });
                    let Some((next_port, name)) = reconnect(
                        provider.as_ref(),
                        &config,
                        &identity,
                        &session_id,
                        &receiver,
                        sink.as_ref(),
                    ) else {
                        break 'session;
                    };
                    port = next_port;
                    active_port_name = name;
                    sink.send(SerialEvent::Connected {
                        session_id: session_id.clone(),
                        port_name: active_port_name.clone(),
                    });
                }
            }
        }

        match port.read(&mut buffer) {
            Ok(0) => {}
            Ok(size) => sink.send(SerialEvent::Data {
                session_id: session_id.clone(),
                bytes: buffer[..size].to_vec(),
            }),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut
                        | io::ErrorKind::WouldBlock
                        | io::ErrorKind::Interrupted
                ) => {}
            Err(error) => {
                sink.send(SerialEvent::Disconnected {
                    session_id: session_id.clone(),
                    reason: error.to_string(),
                });
                let Some((next_port, name)) = reconnect(
                    provider.as_ref(),
                    &config,
                    &identity,
                    &session_id,
                    &receiver,
                    sink.as_ref(),
                ) else {
                    break;
                };
                port = next_port;
                active_port_name = name;
                sink.send(SerialEvent::Connected {
                    session_id: session_id.clone(),
                    port_name: active_port_name.clone(),
                });
            }
        }
    }
    sink.send(SerialEvent::Disconnected {
        session_id,
        reason: "closed".into(),
    });
}

pub struct SerialService {
    provider: Arc<dyn SerialProvider>,
    sessions: Mutex<HashMap<String, mpsc::Sender<SerialCommand>>>,
}

impl Default for SerialService {
    fn default() -> Self {
        Self::new()
    }
}

impl SerialService {
    pub fn new() -> Self {
        Self {
            provider: Arc::new(RealSerialProvider),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    #[cfg(test)]
    fn with_provider(provider: Arc<dyn SerialProvider>) -> Self {
        Self {
            provider,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn list_ports(&self) -> Result<Vec<SerialPortDescriptor>> {
        let mut ports = self.provider.list_ports()?;
        ports.sort_by(|left, right| left.port_name.cmp(&right.port_name));
        Ok(ports)
    }

    fn open_with_sink(
        &self,
        mut config: SerialOpenConfig,
        sink: Arc<dyn SerialEventSink>,
    ) -> Result<String> {
        config.validate()?;
        let descriptor = self
            .list_ports()?
            .into_iter()
            .find(|port| port.port_name == config.port_name)
            .ok_or_else(|| anyhow!("serial port '{}' is no longer available", config.port_name))?;
        let port = self.provider.open(&config, &config.port_name)?;
        let identity = ReconnectIdentity {
            original_port_name: config.port_name.clone(),
            usb_serial_number: descriptor.serial_number,
        };
        let session_id = Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel();
        self.sessions.lock().insert(session_id.clone(), sender);
        let provider = self.provider.clone();
        let worker_id = session_id.clone();
        std::thread::Builder::new()
            .name(format!("serial-{worker_id}"))
            .spawn(move || {
                run_worker(provider, config, identity, worker_id, receiver, sink, port);
            })
            .context("spawn serial worker")?;
        Ok(session_id)
    }

    pub fn open(&self, config: SerialOpenConfig, channel: Channel<SerialEvent>) -> Result<String> {
        self.open_with_sink(config, Arc::new(ChannelEventSink(channel)))
    }

    pub fn write(&self, session_id: &str, bytes: Vec<u8>) -> Result<()> {
        let sessions = self.sessions.lock();
        let sender = sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("serial session not found: {session_id}"))?;
        sender
            .send(SerialCommand::Write(bytes))
            .map_err(|_| anyhow!("serial session ended: {session_id}"))
    }

    pub fn send_break(&self, session_id: &str) -> Result<()> {
        let sessions = self.sessions.lock();
        let sender = sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("serial session not found: {session_id}"))?;
        sender
            .send(SerialCommand::SendBreak)
            .map_err(|_| anyhow!("serial session ended: {session_id}"))
    }

    pub fn close(&self, session_id: &str) -> Result<bool> {
        let Some(sender) = self.sessions.lock().remove(session_id) else {
            return Ok(false);
        };
        let _ = sender.send(SerialCommand::Close);
        Ok(true)
    }
}

#[tauri::command]
pub fn serial_list_ports(state: State<'_, AppState>) -> Result<Vec<SerialPortDescriptor>, String> {
    state.serial.list_ports().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn serial_open(
    state: State<'_, AppState>,
    config: SerialOpenConfig,
    on_event: Channel<SerialEvent>,
) -> Result<String, String> {
    state
        .serial
        .open(config, on_event)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn serial_write(
    state: State<'_, AppState>,
    session_id: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    state
        .serial
        .write(&session_id, bytes)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn serial_send_break(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state
        .serial
        .send_break(&session_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn serial_close(state: State<'_, AppState>, session_id: String) -> Result<bool, String> {
    state
        .serial
        .close(&session_id)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Instant;

    #[derive(Default)]
    struct FakePortState {
        reads: Mutex<VecDeque<io::Result<Vec<u8>>>>,
        writes: Mutex<Vec<Vec<u8>>>,
        set_breaks: AtomicUsize,
        clear_breaks: AtomicUsize,
        fail_write: AtomicBool,
    }

    struct FakePort {
        state: Arc<FakePortState>,
    }

    impl ManagedSerialPort for FakePort {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            match self.state.reads.lock().pop_front() {
                Some(Ok(bytes)) => {
                    let size = bytes.len().min(buffer.len());
                    buffer[..size].copy_from_slice(&bytes[..size]);
                    Ok(size)
                }
                Some(Err(error)) => Err(error),
                None => Err(io::Error::new(io::ErrorKind::TimedOut, "timeout")),
            }
        }

        fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
            if self.state.fail_write.load(Ordering::SeqCst) {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "write failed"));
            }
            self.state.writes.lock().push(bytes.to_vec());
            Ok(())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn set_break(&self) -> std::result::Result<(), serialport::Error> {
            self.state.set_breaks.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn clear_break(&self) -> std::result::Result<(), serialport::Error> {
            self.state.clear_breaks.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    struct FakeProvider {
        ports: Mutex<Vec<SerialPortDescriptor>>,
        states: Mutex<VecDeque<Arc<FakePortState>>>,
        opened: Mutex<Vec<String>>,
    }

    impl FakeProvider {
        fn new(port: SerialPortDescriptor, states: Vec<Arc<FakePortState>>) -> Self {
            Self {
                ports: Mutex::new(vec![port]),
                states: Mutex::new(states.into()),
                opened: Mutex::new(Vec::new()),
            }
        }
    }

    impl SerialProvider for FakeProvider {
        fn list_ports(&self) -> Result<Vec<SerialPortDescriptor>> {
            Ok(self.ports.lock().clone())
        }

        fn open(
            &self,
            _config: &SerialOpenConfig,
            port_name: &str,
        ) -> Result<Box<dyn ManagedSerialPort>> {
            self.opened.lock().push(port_name.to_string());
            let state = self
                .states
                .lock()
                .pop_front()
                .ok_or_else(|| anyhow!("no fake port available"))?;
            Ok(Box::new(FakePort { state }))
        }
    }

    struct TestSink(mpsc::Sender<SerialEvent>);

    impl SerialEventSink for TestSink {
        fn send(&self, event: SerialEvent) {
            let _ = self.0.send(event);
        }
    }

    fn usb_port(name: &str, serial: Option<&str>) -> SerialPortDescriptor {
        SerialPortDescriptor {
            port_name: name.into(),
            port_type: "usb".into(),
            vid: Some(0x0403),
            pid: Some(0x6001),
            serial_number: serial.map(Into::into),
            manufacturer: Some("Test".into()),
            product: Some("Loopback".into()),
        }
    }

    fn config(port_name: &str) -> SerialOpenConfig {
        SerialOpenConfig {
            port_name: port_name.into(),
            baud_rate: 9_600,
            data_bits: SerialDataBits::Eight,
            parity: SerialParity::None,
            stop_bits: SerialStopBits::One,
            flow_control: SerialFlowControl::None,
        }
    }

    fn receive_until(
        receiver: &mpsc::Receiver<SerialEvent>,
        predicate: impl Fn(&SerialEvent) -> bool,
    ) -> SerialEvent {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let event = receiver
                .recv_timeout(remaining)
                .expect("serial event timeout");
            if predicate(&event) {
                return event;
            }
        }
    }

    #[test]
    fn settings_defaults_and_serialport_mappings_are_exact() {
        let parsed: SerialOpenConfig = serde_json::from_value(serde_json::json!({
            "port_name": "/dev/cu.test"
        }))
        .unwrap();
        assert_eq!(parsed, config("/dev/cu.test"));
        assert_eq!(DataBits::from(SerialDataBits::Seven), DataBits::Seven);
        assert_eq!(Parity::from(SerialParity::Odd), Parity::Odd);
        assert_eq!(StopBits::from(SerialStopBits::Two), StopBits::Two);
        assert_eq!(
            FlowControl::from(SerialFlowControl::Hardware),
            FlowControl::Hardware
        );
    }

    #[test]
    fn reconnect_uses_usb_serial_first_and_never_vid_pid_alone() {
        let serial_identity = ReconnectIdentity {
            original_port_name: "COM3".into(),
            usb_serial_number: Some("SERIAL-A".into()),
        };
        let ports = vec![
            usb_port("COM9", Some("SERIAL-B")),
            usb_port("COM7", Some("SERIAL-A")),
        ];
        assert_eq!(
            select_reconnect_port(&serial_identity, &ports).as_deref(),
            Some("COM7")
        );
        assert!(
            select_reconnect_port(&serial_identity, &[usb_port("COM9", Some("SERIAL-B"))])
                .is_none()
        );

        let name_identity = ReconnectIdentity {
            original_port_name: "/dev/cu.usbserial-original".into(),
            usb_serial_number: None,
        };
        assert!(select_reconnect_port(
            &name_identity,
            &[usb_port("/dev/cu.usbserial-other", None)]
        )
        .is_none());
        assert_eq!(
            select_reconnect_port(
                &name_identity,
                &[usb_port("/dev/cu.usbserial-original", None)]
            )
            .as_deref(),
            Some("/dev/cu.usbserial-original")
        );
    }

    #[test]
    fn worker_preserves_raw_bytes_writes_and_always_clears_break() {
        let state = Arc::new(FakePortState::default());
        state
            .reads
            .lock()
            .push_back(Ok(vec![0x00, 0x7f, 0x80, 0xff]));
        let provider = Arc::new(FakeProvider::new(
            usb_port("loopback", Some("SERIAL")),
            vec![state.clone()],
        ));
        let service = SerialService::with_provider(provider);
        let (sender, receiver) = mpsc::channel();
        let session_id = service
            .open_with_sink(config("loopback"), Arc::new(TestSink(sender)))
            .unwrap();
        receive_until(&receiver, |event| {
            matches!(event, SerialEvent::Connected { .. })
        });
        let data = receive_until(&receiver, |event| matches!(event, SerialEvent::Data { .. }));
        assert!(
            matches!(data, SerialEvent::Data { bytes, .. } if bytes == vec![0x00, 0x7f, 0x80, 0xff])
        );

        service.write(&session_id, vec![0x1b, b'[', b'A']).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while state.writes.lock().is_empty() && Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(state.writes.lock().as_slice(), &[vec![0x1b, b'[', b'A']]);

        service.send_break(&session_id).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while state.clear_breaks.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(state.set_breaks.load(Ordering::SeqCst), 1);
        assert_eq!(state.clear_breaks.load(Ordering::SeqCst), 1);
        assert!(service.close(&session_id).unwrap());
        receive_until(
            &receiver,
            |event| matches!(event, SerialEvent::Disconnected { reason, .. } if reason == "closed"),
        );
    }

    #[test]
    fn write_failures_emit_errors_and_close_cancels_reconnect_wait() {
        let state = Arc::new(FakePortState::default());
        state.fail_write.store(true, Ordering::SeqCst);
        let provider = Arc::new(FakeProvider::new(usb_port("loopback", None), vec![state]));
        let service = SerialService::with_provider(provider);
        let (sender, receiver) = mpsc::channel();
        let session_id = service
            .open_with_sink(config("loopback"), Arc::new(TestSink(sender)))
            .unwrap();
        receive_until(&receiver, |event| {
            matches!(event, SerialEvent::Connected { .. })
        });
        service.write(&session_id, vec![1]).unwrap();
        let error = receive_until(&receiver, |event| {
            matches!(event, SerialEvent::Error { .. })
        });
        assert!(
            matches!(error, SerialEvent::Error { message, .. } if message.contains("write failed"))
        );
        receive_until(
            &receiver,
            |event| matches!(event, SerialEvent::Disconnected { reason, .. } if reason != "closed"),
        );

        let started = Instant::now();
        assert!(service.close(&session_id).unwrap());
        receive_until(
            &receiver,
            |event| matches!(event, SerialEvent::Disconnected { reason, .. } if reason == "closed"),
        );
        assert!(started.elapsed() < Duration::from_millis(500));
    }
}
