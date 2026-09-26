import { useCallback, useEffect, useRef, useState } from 'react';
import {
  sftpCancelTransfer,
  sftpConnect,
  sftpDisconnect,
  sftpList,
  sftpMutate,
  sftpTransfer,
  type SftpEntry,
  type SftpListing,
  type SftpSide,
  type SftpTransferDirection,
  type SftpTransferEvent,
} from '../lib/sftp';
import { sshListConnections, type SshConnection } from '../lib/sshConnections';
import './SftpPanel.css';

interface SftpPanelProps {
  onClose: () => void;
}

function joinPath(side: SftpSide, parent: string, name: string): string {
  if (side === 'remote') {
    return parent === '/' ? `/${name}` : `${parent.replace(/\/$/, '')}/${name}`;
  }
  const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return `${parent.replace(/[\\/]$/, '')}${separator}${name}`;
}

function parentPath(side: SftpSide, path: string): string {
  if (side === 'remote') {
    if (path === '/') return '/';
    const parent = path.replace(/\/+$/, '').replace(/\/[^/]+$/, '');
    return parent || '/';
  }
  const trimmed = path.replace(/[\\/]+$/, '');
  const parent = trimmed.replace(/[\\/][^\\/]+$/, '');
  if (parent === trimmed) return path;
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent || '/';
}

function formatSize(size: number | null): string {
  if (size == null) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

interface PaneProps {
  side: SftpSide;
  listing: SftpListing | null;
  path: string;
  selected: SftpEntry | null;
  disabled: boolean;
  onPath: (path: string) => void;
  onLoad: (path: string) => void;
  onSelect: (entry: SftpEntry | null) => void;
  onMutate: (operation: 'mkdir' | 'rename' | 'delete') => void;
}

function SftpPane({
  side,
  listing,
  path,
  selected,
  disabled,
  onPath,
  onLoad,
  onSelect,
  onMutate,
}: PaneProps) {
  return (
    <section className="sftp-pane" data-testid={`sftp-${side}-pane`}>
      <div className="sftp-pane-title">{side === 'local' ? 'This Computer' : 'Remote'}</div>
      <form
        className="sftp-path-bar"
        onSubmit={(event) => {
          event.preventDefault();
          onLoad(path);
        }}
      >
        <button type="button" disabled={disabled} onClick={() => onLoad(parentPath(side, path))}>
          Up
        </button>
        <input
          value={path}
          disabled={disabled}
          onChange={(event) => onPath(event.target.value)}
          aria-label={`${side} path`}
        />
        <button type="submit" disabled={disabled}>Go</button>
      </form>
      <div className="sftp-pane-actions">
        <button type="button" disabled={disabled} onClick={() => onMutate('mkdir')}>New folder</button>
        <button type="button" disabled={disabled || !selected} onClick={() => onMutate('rename')}>Rename</button>
        <button type="button" disabled={disabled || !selected} onClick={() => onMutate('delete')}>Delete</button>
      </div>
      <div className="sftp-entry-list" role="listbox" aria-label={`${side} files`}>
        {listing?.entries.map((entry) => (
          <button
            type="button"
            role="option"
            aria-selected={selected?.path === entry.path}
            className={selected?.path === entry.path ? 'selected' : ''}
            key={entry.path}
            onClick={() => onSelect(entry)}
            onDoubleClick={() => {
              if (entry.is_dir) {
                onSelect(null);
                onLoad(entry.path);
              }
            }}
          >
            <span className="sftp-entry-kind">{entry.is_dir ? '▸' : entry.is_symlink ? '↗' : '·'}</span>
            <span className="sftp-entry-name">{entry.name}</span>
            <span className="sftp-entry-size">{formatSize(entry.size)}</span>
          </button>
        ))}
        {listing && listing.entries.length === 0 && (
          <div className="sftp-empty">Empty directory</div>
        )}
      </div>
    </section>
  );
}

export function SftpPanel({ onClose }: SftpPanelProps) {
  const [connections, setConnections] = useState<SshConnection[]>([]);
  const [connectionId, setConnectionId] = useState('');
  const [passwordOverride, setPasswordOverride] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [localPath, setLocalPath] = useState('');
  const [remotePath, setRemotePath] = useState('.');
  const [localListing, setLocalListing] = useState<SftpListing | null>(null);
  const [remoteListing, setRemoteListing] = useState<SftpListing | null>(null);
  const [selectedLocal, setSelectedLocal] = useState<SftpEntry | null>(null);
  const [selectedRemote, setSelectedRemote] = useState<SftpEntry | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [transferId, setTransferId] = useState<string | null>(null);
  const [transferred, setTransferred] = useState(0);
  const [transferTotal, setTransferTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const transferRef = useRef<string | null>(null);

  useEffect(() => {
    void sshListConnections()
      .then((rows) => {
        setConnections(rows);
        setConnectionId(rows[0]?.id ?? '');
      })
      .catch((caught) => setError(String(caught)));
  }, []);

  const load = useCallback(async (side: SftpSide, path: string, session = sessionRef.current) => {
    if (side === 'remote' && !session) return;
    try {
      const listing = await sftpList(side, path, session ?? undefined);
      if (side === 'local') {
        setLocalListing(listing);
        setLocalPath(listing.path);
        setSelectedLocal(null);
      } else {
        setRemoteListing(listing);
        setRemotePath(listing.path);
        setSelectedRemote(null);
      }
    } catch (caught) {
      setError(String(caught));
    }
  }, []);

  useEffect(() => () => {
    if (transferRef.current) void sftpCancelTransfer(transferRef.current);
    if (sessionRef.current) void sftpDisconnect(sessionRef.current);
  }, []);

  const disconnect = useCallback(async () => {
    const activeTransfer = transferRef.current;
    const activeSession = sessionRef.current;
    transferRef.current = null;
    sessionRef.current = null;
    setTransferId(null);
    setSessionId(null);
    setRemoteListing(null);
    if (activeTransfer) await sftpCancelTransfer(activeTransfer).catch(() => false);
    if (activeSession) await sftpDisconnect(activeSession).catch((caught) => setError(String(caught)));
  }, []);

  const close = async () => {
    await disconnect();
    onClose();
  };

  const connect = async () => {
    if (!connectionId) return;
    setConnecting(true);
    setError(null);
    try {
      const id = await sftpConnect(connectionId, passwordOverride);
      sessionRef.current = id;
      setSessionId(id);
      await Promise.all([load('local', '', id), load('remote', '.', id)]);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setConnecting(false);
    }
  };

  const mutate = async (side: SftpSide, operation: 'mkdir' | 'rename' | 'delete') => {
    const listing = side === 'local' ? localListing : remoteListing;
    const selected = side === 'local' ? selectedLocal : selectedRemote;
    if (!listing) return;
    let path = selected?.path ?? '';
    let destination: string | undefined;
    if (operation === 'mkdir') {
      const name = window.prompt('New folder name');
      if (!name) return;
      path = joinPath(side, listing.path, name);
    } else if (operation === 'rename') {
      if (!selected) return;
      const name = window.prompt('New name', selected.name);
      if (!name || name === selected.name) return;
      destination = joinPath(side, listing.path, name);
    } else {
      if (!selected || !window.confirm(`Delete ${selected.name}? Directories must be empty.`)) return;
    }
    setError(null);
    try {
      await sftpMutate(side, operation, path, destination, sessionId ?? undefined);
      await load(side, listing.path);
    } catch (caught) {
      setError(String(caught));
    }
  };

  const onTransferEvent = (direction: SftpTransferDirection) => (event: SftpTransferEvent) => {
    if (event.type === 'started' || event.type === 'progress') {
      transferRef.current = event.transfer_id;
      setTransferId(event.transfer_id);
      setTransferTotal(event.total);
      if (event.type === 'progress') setTransferred(event.bytes);
      return;
    }
    transferRef.current = null;
    setTransferId(null);
    if (event.type === 'error') setError(event.message);
    if (event.type === 'completed') {
      setTransferred(event.bytes);
      void load(direction === 'upload' ? 'remote' : 'local', direction === 'upload' ? remotePath : localPath);
    }
  };

  const transfer = async (direction: SftpTransferDirection) => {
    if (!sessionId || transferId) return;
    const source = direction === 'upload' ? selectedLocal : selectedRemote;
    if (!source || source.is_dir) return;
    const targetName = source.name;
    const local = direction === 'upload'
      ? source.path
      : joinPath('local', localListing?.path ?? localPath, targetName);
    const remote = direction === 'download'
      ? source.path
      : joinPath('remote', remoteListing?.path ?? remotePath, targetName);
    setError(null);
    setTransferred(0);
    setTransferTotal(source.size);
    try {
      const id = await sftpTransfer(sessionId, direction, local, remote, onTransferEvent(direction));
      transferRef.current = id;
      setTransferId(id);
    } catch (caught) {
      setError(String(caught));
    }
  };

  return (
    <div className="sftp-overlay" role="dialog" aria-modal="true" aria-label="SFTP">
      <div className="sftp-panel">
        <header className="sftp-header">
          <h2>SFTP</h2>
          <button type="button" onClick={() => void close()} aria-label="Close SFTP">×</button>
        </header>
        <div className="sftp-host-warning">Host identity is not verified for this SFTP session.</div>
        <div className="sftp-connect-bar">
          <label>
            Saved connection
            <select value={connectionId} disabled={!!sessionId} onChange={(event) => setConnectionId(event.target.value)}>
              {connections.length === 0 && <option value="">No saved SSH connections</option>}
              {connections.map((connection) => (
                <option value={connection.id} key={connection.id}>{connection.name} ({connection.host})</option>
              ))}
            </select>
          </label>
          <label>
            One-session password override
            <input
              type="password"
              value={passwordOverride}
              disabled={!!sessionId}
              autoComplete="off"
              onChange={(event) => setPasswordOverride(event.target.value)}
            />
          </label>
          {sessionId ? (
            <button type="button" onClick={() => void disconnect()}>Disconnect</button>
          ) : (
            <button type="button" disabled={!connectionId || connecting} onClick={() => void connect()}>
              {connecting ? 'Connecting…' : 'Connect'}
            </button>
          )}
        </div>
        {error && <div className="sftp-error">{error}</div>}
        <div className="sftp-browser">
          <SftpPane
            side="local"
            listing={localListing}
            path={localPath}
            selected={selectedLocal}
            disabled={!sessionId}
            onPath={setLocalPath}
            onLoad={(path) => void load('local', path)}
            onSelect={setSelectedLocal}
            onMutate={(operation) => void mutate('local', operation)}
          />
          <div className="sftp-transfer-controls">
            <button
              type="button"
              disabled={!sessionId || !!transferId || !selectedLocal || selectedLocal.is_dir}
              onClick={() => void transfer('upload')}
              title="Upload selected local file"
            >
              Upload →
            </button>
            <button
              type="button"
              disabled={!sessionId || !!transferId || !selectedRemote || selectedRemote.is_dir}
              onClick={() => void transfer('download')}
              title="Download selected remote file"
            >
              ← Download
            </button>
          </div>
          <SftpPane
            side="remote"
            listing={remoteListing}
            path={remotePath}
            selected={selectedRemote}
            disabled={!sessionId}
            onPath={setRemotePath}
            onLoad={(path) => void load('remote', path)}
            onSelect={setSelectedRemote}
            onMutate={(operation) => void mutate('remote', operation)}
          />
        </div>
        <footer className="sftp-transfer-status">
          {transferId ? (
            <>
              <progress value={transferred} max={transferTotal ?? Math.max(transferred, 1)} />
              <span>{formatSize(transferred)}{transferTotal != null ? ` / ${formatSize(transferTotal)}` : ''}</span>
              <button type="button" onClick={() => void sftpCancelTransfer(transferId)}>Cancel transfer</button>
            </>
          ) : (
            <span>One transfer at a time. Partial files are removed after cancel or failure.</span>
          )}
        </footer>
      </div>
    </div>
  );
}
