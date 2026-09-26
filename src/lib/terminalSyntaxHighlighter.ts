import type { ResolvedSyntaxProfile, SyntaxProfile, Vendor } from "./deviceProfiles";
import { resolveSyntaxProfile } from "./deviceProfiles";

export type SyntaxMatchKind = "success" | "warning" | "failure" | "neutral";

export interface SyntaxMatch {
  start: number;
  length: number;
  phrase: string;
  kind: SyntaxMatchKind;
}

export interface TerminalSyntaxSettings {
  enabled: boolean;
  profile: SyntaxProfile;
  vendor: Vendor;
  platform: string;
}

interface SyntaxRule {
  phrase: string;
  kind: SyntaxMatchKind;
}

interface WriteScanToken {
  startLine: number;
}

const GENERIC_RULES: readonly SyntaxRule[] = [
  { phrase: "connected", kind: "success" },
  { phrase: "success", kind: "success" },
  { phrase: "active", kind: "success" },
  { phrase: "up", kind: "success" },
  { phrase: "degraded", kind: "warning" },
  { phrase: "warning", kind: "warning" },
  { phrase: "pending", kind: "warning" },
  { phrase: "failure", kind: "failure" },
  { phrase: "timeout", kind: "failure" },
  { phrase: "denied", kind: "failure" },
  { phrase: "error", kind: "failure" },
  { phrase: "down", kind: "failure" },
];

const PROFILE_RULES: Readonly<Record<ResolvedSyntaxProfile, readonly SyntaxRule[]>> = {
  generic: GENERIC_RULES,
  cisco: [
    { phrase: "administratively down", kind: "failure" },
    { phrase: "err-disabled", kind: "failure" },
    { phrase: "notconnect", kind: "failure" },
    { phrase: "suspended", kind: "warning" },
    { phrase: "trunking", kind: "success" },
    { phrase: "forwarding", kind: "success" },
    { phrase: "blocking", kind: "warning" },
    ...GENERIC_RULES,
  ],
  junos: [
    { phrase: "interface up", kind: "success" },
    { phrase: "interface down", kind: "failure" },
    { phrase: "established", kind: "success" },
    { phrase: "inactive", kind: "warning" },
    { phrase: "disabled", kind: "failure" },
    { phrase: "enabled", kind: "success" },
    { phrase: "reject", kind: "failure" },
    { phrase: "connect", kind: "warning" },
    { phrase: "idle", kind: "warning" },
    ...GENERIC_RULES,
  ],
  arista: [
    { phrase: "notconnect", kind: "failure" },
    { phrase: "connected", kind: "success" },
    { phrase: "forwarding", kind: "success" },
    { phrase: "blocking", kind: "warning" },
    { phrase: "inactive", kind: "warning" },
    ...GENERIC_RULES,
  ],
};

const MAX_MATCHES_PER_LINE = 50;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findSyntaxMatches(
  line: string,
  profile: ResolvedSyntaxProfile,
  limit = MAX_MATCHES_PER_LINE,
): SyntaxMatch[] {
  const matches: SyntaxMatch[] = [];
  const occupied = new Set<number>();
  for (const rule of PROFILE_RULES[profile]) {
    if (matches.length >= limit) break;
    const expression = new RegExp(
      `(^|[^A-Za-z0-9_])(${escapeRegex(rule.phrase)})(?=$|[^A-Za-z0-9_])`,
      "gi",
    );
    for (const match of line.matchAll(expression)) {
      if (matches.length >= limit) break;
      const start = (match.index ?? 0) + match[1].length;
      const end = start + match[2].length;
      let overlaps = false;
      for (let index = start; index < end; index += 1) {
        if (occupied.has(index)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      for (let index = start; index < end; index += 1) occupied.add(index);
      matches.push({ start, length: match[2].length, phrase: match[2], kind: rule.kind });
    }
  }
  return matches.sort((left, right) => left.start - right.start);
}

function absoluteCursorLine(terminal: any): number {
  const buffer = terminal.buffer?.active;
  return Number(buffer?.baseY ?? 0) + Number(buffer?.cursorY ?? 0);
}

function furthestCursorUp(data: string | Uint8Array): number {
  const text = typeof data === "string" ? data : new TextDecoder().decode(data);
  let maximum = 0;
  for (const match of text.matchAll(/\x1b\[(\d*)A/g)) {
    maximum = Math.max(maximum, Number(match[1] || 1));
  }
  return maximum;
}

export class TerminalSyntaxHighlighter {
  private readonly decorationsByLine = new Map<number, Set<any>>();
  private suspended = false;
  private unavailable = false;

  constructor(
    private readonly terminal: any,
    private readonly getSettings: () => TerminalSyntaxSettings | null,
  ) {}

  beginWrite(data: string | Uint8Array): WriteScanToken | null {
    if (this.suspended || this.unavailable) return null;
    return { startLine: Math.max(0, absoluteCursorLine(this.terminal) - furthestCursorUp(data)) };
  }

  completeWrite(token: WriteScanToken | null): void {
    if (!token || this.suspended || this.unavailable) return;
    const settings = this.getSettings();
    if (!settings?.enabled) {
      this.clearAll();
      return;
    }
    if (
      typeof this.terminal.registerMarker !== "function" ||
      typeof this.terminal.registerDecoration !== "function"
    ) {
      this.unavailable = true;
      this.clearAll();
      return;
    }
    const endLine = absoluteCursorLine(this.terminal);
    const startLine = Math.min(token.startLine, endLine);
    for (let line = startLine; line <= Math.max(token.startLine, endLine); line += 1) {
      this.decorateLine(line, settings);
    }
  }

  enterAlternateScreen(): void {
    this.suspended = true;
    this.clearAll();
  }

  exitAlternateScreen(): void {
    this.suspended = false;
  }

  refreshVisible(): void {
    this.clearAll();
    if (this.suspended || this.unavailable) return;
    const settings = this.getSettings();
    if (!settings?.enabled) return;
    const buffer = this.terminal.buffer?.active;
    const first = Number(buffer?.viewportY ?? buffer?.baseY ?? 0);
    const last = first + Math.max(0, Number(this.terminal.rows ?? 24) - 1);
    for (let line = first; line <= last; line += 1) this.decorateLine(line, settings);
  }

  dispose(): void {
    this.clearAll();
  }

  private decorateLine(lineIndex: number, settings: TerminalSyntaxSettings): void {
    this.clearLine(lineIndex);
    const buffer = this.terminal.buffer?.active;
    const line = buffer?.getLine?.(lineIndex);
    const text = line?.translateToString?.(true) ?? "";
    if (!text) return;
    const profile = resolveSyntaxProfile(settings.profile, settings.vendor, settings.platform);
    const matches = findSyntaxMatches(text, profile);
    if (matches.length === 0) return;

    const decorations = new Set<any>();
    const cursorLine = absoluteCursorLine(this.terminal);
    try {
      for (const match of matches) {
        const marker = this.terminal.registerMarker(lineIndex - cursorLine);
        if (!marker) continue;
        const decoration = this.terminal.registerDecoration({
          marker,
          x: match.start,
          width: match.length,
          layer: "top",
        });
        if (!decoration) {
          marker.dispose?.();
          continue;
        }
        decoration.onRender?.((element: HTMLElement) => {
          element.classList.add("terminal-syntax-decoration", `terminal-syntax-${match.kind}`);
          element.setAttribute("aria-hidden", "true");
        });
        marker.onDispose?.(() => {
          decorations.delete(decoration);
          if (
            decorations.size === 0 &&
            this.decorationsByLine.get(lineIndex) === decorations
          ) {
            this.decorationsByLine.delete(lineIndex);
          }
        });
        decorations.add(decoration);
      }
    } catch {
      for (const decoration of decorations) decoration.dispose?.();
      this.unavailable = true;
      return;
    }
    if (decorations.size > 0) this.decorationsByLine.set(lineIndex, decorations);
  }

  private clearLine(lineIndex: number): void {
    const decorations = this.decorationsByLine.get(lineIndex);
    if (!decorations) return;
    for (const decoration of decorations) decoration.dispose?.();
    this.decorationsByLine.delete(lineIndex);
  }

  private clearAll(): void {
    for (const line of [...this.decorationsByLine.keys()]) this.clearLine(line);
  }
}

export function writeTerminalOutput(
  terminal: any,
  highlighter: TerminalSyntaxHighlighter,
  data: string | Uint8Array,
): void {
  const token = highlighter.beginWrite(data);
  terminal.write(data, () => highlighter.completeWrite(token));
}
