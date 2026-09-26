import { useCallback, useEffect, useRef, useState } from "react";
import {
  serialClose,
  serialListPorts,
  serialOpen,
  serialSendBreak,
  serialWrite,
  type SerialDataBits,
  type SerialEvent,
  type SerialFlowControl,
  type SerialParity,
  type SerialPortDescriptor,
  type SerialStopBits,
} from "../lib/serial";
import {
  applyTerminalOptions,
  createTerminalOptions,
  terminalMetricsChanged,
} from "../lib/terminalAppearance";
import { useAppearance } from "../theme/AppearanceProvider";
import "./SerialConsolePanel.css";

const BAUD_RATES = [1_200, 2_400, 4_800, 9_600, 19_200, 38_400, 57_600, 115_200, 230_400];

type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

export interface SerialConsolePanelProps {
  onClose: () => void;
}

function portLabel(port: SerialPortDescriptor): string {
  const details = [port.product, port.manufacturer, port.serial_number]
    .filter(Boolean)
    .join(" · ");
  return details ? `${port.port_name} — ${details}` : port.port_name;
}

export function SerialConsolePanel({ onClose }: SerialConsolePanelProps) {
  const { settings: appearance } = useAppearance();
  const appearanceRef = useRef(appearance);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const sessionRef = useRef<string | null>(null);
  const connectedRef = useRef(false);
  const [ports, setPorts] = useState<SerialPortDescriptor[]>([]);
  const [selectedPort, setSelectedPort] = useState("");
  const [baudRate, setBaudRate] = useState(9_600);
  const [dataBits, setDataBits] = useState<SerialDataBits>("eight");
  const [parity, setParity] = useState<SerialParity>("none");
  const [stopBits, setStopBits] = useState<SerialStopBits>("one");
  const [flowControl, setFlowControl] = useState<SerialFlowControl>("none");
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [activePort, setActivePort] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingPorts, setLoadingPorts] = useState(true);

  const writeStatus = useCallback((message: string) => {
    terminalRef.current?.write(`\r\n\x1b[2m${message}\x1b[0m\r\n`);
  }, []);

  const refreshPorts = useCallback(async () => {
    setLoadingPorts(true);
    setError(null);
    try {
      const next = await serialListPorts();
      setPorts(next);
      setSelectedPort((current) =>
        next.some((port) => port.port_name === current)
          ? current
          : (next[0]?.port_name ?? ""),
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoadingPorts(false);
    }
  }, []);

  useEffect(() => {
    void refreshPorts();
  }, [refreshPorts]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const XTerm = (window as any).Terminal;
    const FitAddon = (window as any).FitAddon?.FitAddon || (window as any).FitAddon;
    const WebLinksAddon = (window as any).WebLinksAddon?.WebLinksAddon || (window as any).WebLinksAddon;
    if (!XTerm || !FitAddon) {
      setError("xterm is unavailable; reload TerminAI and try again");
      return;
    }
    const terminal = new XTerm(createTerminalOptions(appearanceRef.current));
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    if (WebLinksAddon) terminal.loadAddon(new WebLinksAddon());
    terminal.open(container);
    fit.fit();
    terminal.write("\x1b[2mSerial console ready. Choose a port and connect.\x1b[0m\r\n");
    terminalRef.current = terminal;
    fitRef.current = fit;

    const dataDisposable = terminal.onData((data: string) => {
      if (!connectedRef.current || !sessionRef.current) return;
      void serialWrite(sessionRef.current, new TextEncoder().encode(data)).catch((cause) => {
        setError(String(cause));
      });
    });
    const binaryDisposable = terminal.onBinary?.((data: string) => {
      if (!connectedRef.current || !sessionRef.current) return;
      const bytes = Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff);
      void serialWrite(sessionRef.current, bytes).catch((cause) => setError(String(cause)));
    });
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          try { fit.fit(); } catch { /* modal transition */ }
        })
      : null;
    observer?.observe(container);

    return () => {
      observer?.disconnect();
      dataDisposable?.dispose();
      binaryDisposable?.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const before = createTerminalOptions(appearanceRef.current);
    const after = createTerminalOptions(appearance);
    appearanceRef.current = appearance;
    applyTerminalOptions(terminal, after);
    if (terminalMetricsChanged(before, after)) {
      try { fitRef.current?.fit(); } catch { /* hidden during theme transition */ }
    }
  }, [appearance]);

  useEffect(() => () => {
    const sessionId = sessionRef.current;
    sessionRef.current = null;
    connectedRef.current = false;
    if (sessionId) void serialClose(sessionId);
  }, []);

  const onSerialEvent = useCallback((event: SerialEvent) => {
    switch (event.type) {
      case "data":
        terminalRef.current?.write(new Uint8Array(event.bytes));
        break;
      case "connected":
        sessionRef.current = event.session_id;
        connectedRef.current = true;
        setConnectionState("connected");
        setActivePort(event.port_name);
        setError(null);
        writeStatus(`Connected to ${event.port_name}`);
        terminalRef.current?.focus();
        break;
      case "reconnecting":
        connectedRef.current = false;
        setConnectionState("reconnecting");
        setActivePort(event.port_name);
        if (event.message) setError(event.message);
        break;
      case "disconnected":
        connectedRef.current = false;
        setConnectionState(event.reason === "closed" ? "disconnected" : "reconnecting");
        if (event.reason === "closed") {
          sessionRef.current = null;
          setActivePort(null);
          writeStatus("Serial console closed");
        } else {
          writeStatus(`Disconnected (${event.reason}); waiting for the same device…`);
        }
        break;
      case "error":
        setError(event.message);
        writeStatus(event.message);
        break;
    }
  }, [writeStatus]);

  const connect = async () => {
    if (!selectedPort) return;
    setConnectionState("connecting");
    setError(null);
    try {
      const sessionId = await serialOpen({
        port_name: selectedPort,
        baud_rate: baudRate,
        data_bits: dataBits,
        parity,
        stop_bits: stopBits,
        flow_control: flowControl,
      }, onSerialEvent);
      sessionRef.current = sessionId;
    } catch (cause) {
      setConnectionState("idle");
      setError(`${String(cause)}. On Linux, verify dialout/udev access; on macOS, device access; on Windows, the COM driver and port ownership.`);
    }
  };

  const disconnect = async () => {
    const sessionId = sessionRef.current;
    sessionRef.current = null;
    connectedRef.current = false;
    if (sessionId) await serialClose(sessionId).catch((cause) => setError(String(cause)));
    setConnectionState("disconnected");
    setActivePort(null);
  };

  const closePanel = async () => {
    await disconnect();
    onClose();
  };

  const active = connectionState === "connected" || connectionState === "reconnecting" || connectionState === "connecting";

  return (
    <div className="serial-panel-overlay" onClick={() => void closePanel()}>
      <section className="serial-panel" role="dialog" aria-label="Serial Console" onClick={(event) => event.stopPropagation()}>
        <header className="serial-panel-header">
          <div>
            <h2>USB Serial Console</h2>
            <span data-state={connectionState}>{connectionState}{activePort ? ` · ${activePort}` : ""}</span>
          </div>
          <button type="button" aria-label="Close serial console" onClick={() => void closePanel()}>✕</button>
        </header>

        <div className="serial-panel-controls">
          <label className="serial-port-field">
            <span>Port</span>
            <select aria-label="Serial port" disabled={active || loadingPorts} value={selectedPort} onChange={(event) => setSelectedPort(event.target.value)}>
              {ports.length === 0 && <option value="">{loadingPorts ? "Scanning…" : "No serial ports found"}</option>}
              {ports.map((port) => <option key={port.port_name} value={port.port_name}>{portLabel(port)}</option>)}
            </select>
          </label>
          <button type="button" disabled={active || loadingPorts} onClick={() => void refreshPorts()}>Refresh</button>
          <label><span>Baud</span><select aria-label="Baud rate" disabled={active} value={baudRate} onChange={(event) => setBaudRate(Number(event.target.value))}>{BAUD_RATES.map((rate) => <option key={rate} value={rate}>{rate}</option>)}</select></label>
          <label><span>Data</span><select aria-label="Data bits" disabled={active} value={dataBits} onChange={(event) => setDataBits(event.target.value as SerialDataBits)}><option value="seven">7</option><option value="eight">8</option></select></label>
          <label><span>Parity</span><select aria-label="Parity" disabled={active} value={parity} onChange={(event) => setParity(event.target.value as SerialParity)}><option value="none">None</option><option value="even">Even</option><option value="odd">Odd</option></select></label>
          <label><span>Stop</span><select aria-label="Stop bits" disabled={active} value={stopBits} onChange={(event) => setStopBits(event.target.value as SerialStopBits)}><option value="one">1</option><option value="two">2</option></select></label>
          <label><span>Flow</span><select aria-label="Flow control" disabled={active} value={flowControl} onChange={(event) => setFlowControl(event.target.value as SerialFlowControl)}><option value="none">None</option><option value="software">Software</option><option value="hardware">Hardware</option></select></label>
          {!active ? (
            <button type="button" className="serial-connect" disabled={!selectedPort || loadingPorts} onClick={() => void connect()}>Connect</button>
          ) : (
            <button type="button" onClick={() => void disconnect()}>Disconnect</button>
          )}
          <button type="button" disabled={connectionState !== "connected" || !sessionRef.current} onClick={() => {
            if (sessionRef.current) void serialSendBreak(sessionRef.current).catch((cause) => setError(String(cause)));
          }}>Send Break</button>
        </div>

        {connectionState === "reconnecting" && (
          <div className="serial-reconnect-notice" role="status">
            Waiting for the same device. Input is disabled; existing console output is preserved.
          </div>
        )}
        {error && <div className="serial-panel-error" role="alert">{error}</div>}
        <div className="serial-terminal" ref={containerRef} data-testid="serial-terminal" />
      </section>
    </div>
  );
}
