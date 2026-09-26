import { useEffect, useRef, useState } from "react";
import { parseCast, type ParsedCast } from "../../lib/cast";
import { recording, type RedactionRow } from "../../lib/recording";
import "./CastPlayer.css";

const SPEEDS = [0.5, 1, 2, 4];

interface Props {
  recordingId: string;
}

export function CastPlayer({ recordingId }: Props) {
  const [cast, setCast] = useState<ParsedCast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [position, setPosition] = useState(0);
  const [redactions, setRedactions] = useState<RedactionRow[]>([]);
  const [showInspector, setShowInspector] = useState(false);
  const outputRef = useRef<HTMLPreElement | null>(null);
  const eventIdxRef = useRef(0);

  useEffect(() => {
    let cancel = false;
    async function load() {
      try {
        const text = await recording.readCast(recordingId);
        const parsed = parseCast(text);
        const summary = await recording.redactionSummary(recordingId);
        if (!cancel) {
          setCast(parsed);
          setRedactions(summary);
        }
      } catch (e) {
        if (!cancel) setError(String(e));
      }
    }
    void load();
    return () => {
      cancel = true;
    };
  }, [recordingId]);

  // Render up to current position. Cheap implementation — concatenate
  // events whose t <= position. xterm.js could be wired in later for
  // proper VT processing.
  useEffect(() => {
    if (!cast || !outputRef.current) return;
    let buf = "";
    let idx = 0;
    for (const ev of cast.events) {
      if (ev.channel !== "o") continue;
      if (ev.t > position) break;
      buf += ev.data;
      idx++;
    }
    eventIdxRef.current = idx;
    outputRef.current.textContent = buf;
  }, [cast, position]);

  // Playback timer.
  useEffect(() => {
    if (!playing || !cast) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setPosition((p) => {
        const next = p + dt * speed;
        if (cast && next >= cast.totalDuration) {
          setPlaying(false);
          return cast.totalDuration;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, cast]);

  if (error) {
    return (
      <div className="cast-player cast-player-error">
        Failed to load recording: {error}
      </div>
    );
  }
  if (!cast) {
    return <div className="cast-player">Loading recording…</div>;
  }

  return (
    <div className="cast-player" data-testid="cast-player">
      <div className="cast-controls">
        <button
          className="cast-btn"
          onClick={() => setPlaying((p) => !p)}
          data-testid="cast-play-pause"
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <button
          className="cast-btn"
          onClick={() => {
            setPlaying(false);
            setPosition(0);
          }}
          title="Restart (r)"
        >
          ⏮
        </button>
        <input
          type="range"
          min={0}
          max={cast.totalDuration}
          step={0.01}
          value={position}
          onChange={(e) => setPosition(parseFloat(e.target.value))}
          className="cast-scrubber"
          data-testid="cast-scrubber"
        />
        <span className="cast-time">
          {position.toFixed(1)}s / {cast.totalDuration.toFixed(1)}s
        </span>
        <select
          value={speed}
          onChange={(e) => setSpeed(parseFloat(e.target.value))}
          className="cast-speed"
          data-testid="cast-speed"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
        <button
          className="cast-btn"
          onClick={() => setShowInspector((s) => !s)}
          data-testid="cast-inspector-toggle"
        >
          {showInspector ? "Hide" : "Inspect"} Redactions
        </button>
      </div>

      <div className="cast-body">
        <pre ref={outputRef} className="cast-output" />
        {showInspector && (
          <aside className="cast-inspector">
            <h4>Redactions</h4>
            <p className="cast-inspector-note">
              Redacted bytes were overwritten before disk write.
              They cannot be recovered.
            </p>
            {redactions.length === 0 ? (
              <p>No redactions recorded.</p>
            ) : (
              <ul>
                {redactions.map((r) => (
                  <li key={r.pattern}>
                    <code>{r.pattern}</code>
                    <span className="cast-inspector-count">
                      {r.matches} match{r.matches === 1 ? "" : "es"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
