/** asciinema v2 cast file reader (parser only — no UI). */

export interface CastHeader {
  version: number;
  width: number;
  height: number;
  timestamp?: number;
  env?: Record<string, string>;
}

export interface CastEvent {
  /** Seconds since recording start. */
  t: number;
  /** "o" = output, "i" = input. */
  channel: "o" | "i";
  /** UTF-8 string of bytes. */
  data: string;
}

export interface ParsedCast {
  header: CastHeader;
  events: CastEvent[];
  totalDuration: number;
}

export function parseCast(text: string): ParsedCast {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Error("empty cast file");
  }
  const header = JSON.parse(lines[0]) as CastHeader;
  if (header.version !== 2) {
    throw new Error(`unsupported cast version: ${header.version}`);
  }
  const events: CastEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    const arr = JSON.parse(lines[i]) as [number, "o" | "i", string];
    events.push({ t: arr[0], channel: arr[1], data: arr[2] });
  }
  const totalDuration = events.length > 0 ? events[events.length - 1].t : 0;
  return { header, events, totalDuration };
}
