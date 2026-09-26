import React, { useEffect, useRef } from 'react';
import { useMetadataStore } from '../state/metadataStore';
import { usePanesStore } from '../state/panesStore';
import './MetadataCard.css';

const MetadataCard: React.FC = () => {
  const { open, data, loading, error, position, setPosition, refresh, toggle } =
    useMetadataStore();
  const focusedPaneId = usePanesStore((s) => s.focusedPaneId);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  // Refresh when the focused pane changes while open.
  useEffect(() => {
    if (open) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedPaneId]);

  if (!open) return null;

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { dx: e.clientX - position.x, dy: e.clientY - position.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    setPosition(e.clientX - dragRef.current.dx, e.clientY - dragRef.current.dy);
  };
  const onPointerUp = () => { dragRef.current = null; };

  const asOf = new Date((data?.gatheredAt ?? 0) * 1000).toLocaleTimeString();

  return (
    <div className="metadata-card" style={{ left: position.x, top: position.y }}>
      <div
        className="metadata-card__header"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <span className="metadata-card__title">Pane Context</span>
        <button
          className="metadata-card__btn"
          onClick={() => refresh()}
          aria-label="Refresh"
          title="Refresh"
        >
          <span className={loading ? 'spin' : ''}>↻</span>
        </button>
        <button className="metadata-card__btn" onClick={() => toggle()} aria-label="Close">×</button>
      </div>

      <div className="metadata-card__body">
        {error && <div className="metadata-card__error">{error}</div>}

        <section className="metadata-card__section">
          <h4>Git</h4>
          {data?.git ? (
            <div className="metadata-card__git">
              <span className="branch">⎇ <span className="branch-name">{data.git.branch}</span></span>
              {data.git.dirty && <span className="dirty-dot" title="uncommitted changes">●</span>}
              <span className="muted">{data.git.changedCount} changed</span>
              <span className="muted">↑{data.git.ahead} ↓{data.git.behind}</span>
            </div>
          ) : (
            <div className="muted">Not a git repo</div>
          )}
        </section>

        <section className="metadata-card__section">
          <h4>Listening Ports</h4>
          {data && data.ports.length > 0 ? (
            <ul className="metadata-card__ports">
              {data.ports.map((p) => (
                <li key={p.port}><code>:{p.port}</code> {p.procName}</li>
              ))}
            </ul>
          ) : (
            <div className="muted">No listening ports</div>
          )}
        </section>

        <section className="metadata-card__section">
          <h4>SSH</h4>
          {data?.ssh ? (
            <div className="metadata-card__ssh">
              <code>
                {data.ssh.user ? `${data.ssh.user}@` : ''}{data.ssh.host}
                {data.ssh.port ? `:${data.ssh.port}` : ''}
              </code>
              <span className={`badge badge--${data.ssh.source}`}>via {data.ssh.source}</span>
            </div>
          ) : (
            <div className="muted">Not an SSH session</div>
          )}
        </section>
      </div>

      <div className="metadata-card__footer muted">as of {asOf}</div>
    </div>
  );
};

export default MetadataCard;
