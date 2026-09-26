import type { ClassifyResponse } from "./guardrails";

export type CiscoPlatform = "iosxe" | "nxos";

export type CiscoDiagnosticSeverity = "error" | "warning" | "info";

export interface CiscoDiagnostic {
  line: number;
  column: number;
  endColumn: number;
  severity: CiscoDiagnosticSeverity;
  message: string;
  source: "cisco-structural" | "guardrails";
  code: string;
}

export interface CiscoLintResult {
  diagnostics: CiscoDiagnostic[];
  structuralStatus: "ready";
}

const SOURCE = "cisco-structural" as const;

const CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const CHILD_RULES: Array<{
  code: string;
  pattern: RegExp;
  allowedParents: ReadonlySet<string>;
  severity: CiscoDiagnosticSeverity;
  message: string;
}> = [
  {
    code: "orphan-child-command",
    pattern: /^description\b/i,
    allowedParents: new Set([
      "interface",
      "address-family",
      "line",
      "vlan",
      "vrf",
      "policy-map",
      "class-map",
      "route-map",
      "controller",
      "feature",
    ]),
    severity: "warning",
    message: "Description must appear inside a tracked configuration context.",
  },
  {
    code: "orphan-child-command",
    pattern: /^ip\s+address\b/i,
    allowedParents: new Set(["interface"]),
    severity: "warning",
    message: "IP address must appear under an interface context.",
  },
  {
    code: "orphan-child-command",
    pattern: /^ipv6\s+address\b/i,
    allowedParents: new Set(["interface", "address-family"]),
    severity: "warning",
    message: "IPv6 address must appear under an interface or address-family context.",
  },
  {
    code: "orphan-child-command",
    pattern: /^switchport\b/i,
    allowedParents: new Set(["interface"]),
    severity: "warning",
    message: "Switchport commands must appear under an interface context.",
  },
  {
    code: "orphan-child-command",
    pattern: /^spanning-tree\b/i,
    allowedParents: new Set(["interface"]),
    severity: "warning",
    message: "Spanning-tree commands must appear under an interface context.",
  },
  {
    code: "orphan-child-command",
    pattern: /^neighbor\b/i,
    allowedParents: new Set(["router", "address-family"]),
    severity: "warning",
    message: "Neighbor commands must appear under a router or address-family context.",
  },
  {
    code: "orphan-child-command",
    pattern: /^(?:ip\s+access-group|ipv6\s+traffic-filter|access-group)\b/i,
    allowedParents: new Set(["interface"]),
    severity: "warning",
    message: "Access-group commands must appear under an interface context.",
  },
];

const IOSXE_PLATFORM_MISMATCHES: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /^feature\s+\S+/i,
    message: "NX-OS feature commands are not valid on IOS-XE.",
  },
];

function makeDiagnostic(args: {
  line: number;
  column: number;
  endColumn: number;
  severity: CiscoDiagnosticSeverity;
  message: string;
  code: string;
}): CiscoDiagnostic {
  return {
    line: args.line,
    column: args.column,
    endColumn: args.endColumn,
    severity: args.severity,
    message: args.message,
    source: SOURCE,
    code: args.code,
  };
}

function firstNonWhitespaceIndex(line: string): number {
  const match = line.match(/\S/);
  return match?.index ?? -1;
}

function trimmedLine(line: string): { text: string; column: number } {
  const index = firstNonWhitespaceIndex(line);
  if (index < 0) {
    return { text: "", column: 1 };
  }
  return { text: line.slice(index), column: index + 1 };
}

function isSeparatorLine(trimmed: string): boolean {
  return trimmed === "!";
}

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith("!");
}

function detectCliPrompt(line: string): CiscoDiagnostic | null {
  const match = line.match(/^[A-Za-z][A-Za-z0-9_.-]*(?:\([^)]*\))?[#>(]/);
  if (!match) {
    return null;
  }
  return makeDiagnostic({
    line: 1,
    column: 1,
    endColumn: match[0].length + 1,
    severity: "warning",
    message: "Line looks like a captured CLI prompt.",
    code: "cli-prompt",
  });
}

function detectControlCharacter(line: string, lineNumber: number): CiscoDiagnostic | null {
  const match = line.match(CONTROL_CHAR_RE);
  if (!match || match.index === undefined) {
    return null;
  }
  return makeDiagnostic({
    line: lineNumber,
    column: match.index + 1,
    endColumn: match.index + 2,
    severity: "warning",
    message: "Line contains a control character.",
    code: "control-character",
  });
}

function detectSuspiciousOutput(
  line: string,
  lineNumber: number,
  column: number,
): CiscoDiagnostic | null {
  if (!/^(?:Codes:|Legend:|Flags:|Interface\s{2,}|Port\s{2,}|Protocol\s{2,}|Vlan\s{2,}|Gateway\s{2,}|Internet\s{2,})/.test(line)) {
    return null;
  }

  return makeDiagnostic({
    line: lineNumber,
    column,
    endColumn: column + line.trimStart().length,
    severity: "warning",
    message: "Line looks like command output rather than configuration.",
    code: "suspicious-output",
  });
}

function classifyContext(trimmed: string, platform: CiscoPlatform): string | null {
  if (/^interface\s+\S+/i.test(trimmed)) {
    return "interface";
  }
  if (/^router\s+\S+/i.test(trimmed)) {
    return "router";
  }
  if (/^address-family\b/i.test(trimmed)) {
    return "address-family";
  }
  if (/^line\s+\S+/i.test(trimmed)) {
    return "line";
  }
  if (/^vlan\s+\S+/i.test(trimmed)) {
    return "vlan";
  }
  if (/^vrf\s+(?:definition|context)\s+\S+/i.test(trimmed) || /^vrf\s+\S+/i.test(trimmed)) {
    return "vrf";
  }
  if (/^policy-map\s+\S+/i.test(trimmed)) {
    return "policy-map";
  }
  if (/^class-map\s+\S+/i.test(trimmed)) {
    return "class-map";
  }
  if (/^route-map\s+\S+/i.test(trimmed)) {
    return "route-map";
  }
  if (/^controller\s+\S+/i.test(trimmed)) {
    return "controller";
  }
  if (platform === "nxos" && /^feature\s+\S+/i.test(trimmed)) {
    return "feature";
  }
  return null;
}

function detectPlatformMismatch(
  trimmed: string,
  platform: CiscoPlatform,
  lineNumber: number,
  column: number,
): CiscoDiagnostic | null {
  if (platform !== "iosxe") {
    return null;
  }

  for (const rule of IOSXE_PLATFORM_MISMATCHES) {
    if (rule.pattern.test(trimmed)) {
      return makeDiagnostic({
        line: lineNumber,
        column,
        endColumn: column + trimmed.length,
        severity: "warning",
        message: rule.message,
        code: "platform-mismatch",
      });
    }
  }

  return null;
}

function detectOrphanChildCommand(
  trimmed: string,
  contextStack: string[],
  lineNumber: number,
  column: number,
): CiscoDiagnostic | null {
  for (const rule of CHILD_RULES) {
    if (!rule.pattern.test(trimmed)) {
      continue;
    }

    const currentContext = contextStack[contextStack.length - 1];
    const hasCompatibleParent =
      currentContext !== undefined && rule.allowedParents.has(currentContext);
    if (hasCompatibleParent) {
      return null;
    }

    return makeDiagnostic({
      line: lineNumber,
      column,
      endColumn: column + trimmed.length,
      severity: rule.severity,
      message: rule.message,
      code: rule.code,
    });
  }

  return null;
}

function handleExit(trimmed: string, contextStack: string[]): { unmatched: boolean } {
  const comparison = trimmed.trim().toLowerCase();
  if (comparison === "exit-address-family") {
    if (contextStack[contextStack.length - 1] !== "address-family") {
      return { unmatched: true };
    }
    contextStack.pop();
    return { unmatched: false };
  }

  if (comparison === "exit") {
    if (contextStack.length === 0) {
      return { unmatched: true };
    }
    contextStack.pop();
    return { unmatched: false };
  }

  return { unmatched: false };
}

export function ciscoLanguageId(platform: CiscoPlatform): "cisco-iosxe" | "cisco-nxos" {
  return platform === "iosxe" ? "cisco-iosxe" : "cisco-nxos";
}

export function guardrailDiagnostic(
  line: number,
  column: number,
  platform: CiscoPlatform,
  command: string,
  result: ClassifyResponse,
): CiscoDiagnostic | null {
  if (result.tier === "T0") {
    return null;
  }

  const label = result.tier === "Ambiguous" ? "Ambiguous" : result.tier;
  return {
    line,
    column,
    endColumn: column + command.trimStart().length,
    severity: result.tier === "T3" ? "error" : "warning",
    message: `${label} ${platform} guardrail for "${command}": ${result.reasoning}`,
    source: "guardrails",
    code: `guardrail-${result.rule_id ?? result.tier.toLowerCase()}`,
  };
}

export function lintCiscoConfig(text: string, platform: CiscoPlatform): CiscoLintResult {
  const diagnostics: CiscoDiagnostic[] = [];
  const contextStack: string[] = [];
  const lines = text.split(/\r\n|\r|\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const lineNumber = index + 1;
    const { text: trimmed, column } = trimmedLine(rawLine);

    if (trimmed === "") {
      continue;
    }

    if (isSeparatorLine(trimmed) || isCommentLine(trimmed)) {
      contextStack.length = 0;
      continue;
    }

    const promptDiagnostic = detectCliPrompt(rawLine);
    if (promptDiagnostic) {
      diagnostics.push({ ...promptDiagnostic, line: lineNumber });
      continue;
    }

    const controlDiagnostic = detectControlCharacter(rawLine, lineNumber);
    if (controlDiagnostic) {
      diagnostics.push(controlDiagnostic);
    }

    const suspiciousOutputDiagnostic = detectSuspiciousOutput(trimmed, lineNumber, column);
    if (suspiciousOutputDiagnostic) {
      diagnostics.push(suspiciousOutputDiagnostic);
      continue;
    }

    const exitDiagnostic = handleExit(trimmed, contextStack);
    if (exitDiagnostic.unmatched) {
      diagnostics.push(
        makeDiagnostic({
          line: lineNumber,
          column,
          endColumn: column + trimmed.length,
          severity: "warning",
          message: "Exit does not match a tracked configuration context.",
          code: "unmatched-exit",
        }),
      );
      continue;
    }

    const platformMismatch = detectPlatformMismatch(trimmed, platform, lineNumber, column);
    if (platformMismatch) {
      diagnostics.push(platformMismatch);
    }

    const orphanChild = detectOrphanChildCommand(trimmed, contextStack, lineNumber, column);
    if (orphanChild) {
      diagnostics.push(orphanChild);
      continue;
    }

    const context = classifyContext(trimmed, platform);
    if (context) {
      contextStack.push(context);
    }
  }

  return { diagnostics, structuralStatus: "ready" };
}
