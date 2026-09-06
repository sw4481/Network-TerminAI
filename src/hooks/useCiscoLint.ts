import { useEffect, useMemo, useRef, useState } from "react";
import {
  guardrailDiagnostic,
  lintCiscoConfig,
  type CiscoDiagnostic,
  type CiscoPlatform,
} from "../lib/ciscoLint";
import { classifyCommand } from "../lib/guardrails";

export interface CiscoGuardrailStatus {
  state: "idle" | "running" | "ready" | "unavailable";
  reason: string | null;
}

export interface CiscoLintView {
  diagnostics: CiscoDiagnostic[];
  guardrails: CiscoGuardrailStatus;
}

interface GuardrailState extends CiscoLintView {
  content: string | null;
  platform: CiscoPlatform | null;
  debounceMs: number;
}

const IDLE: CiscoGuardrailStatus = { state: "idle", reason: null };

const SEVERITY_ORDER: Record<CiscoDiagnostic["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function sortDiagnostics(diagnostics: CiscoDiagnostic[]): CiscoDiagnostic[] {
  return diagnostics.sort(
    (left, right) =>
      left.line - right.line ||
      left.column - right.column ||
      SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
      left.code.localeCompare(right.code),
  );
}

function errorReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /[\u0000-\u001f\u007f]/g,
    " ",
  );
}

export function useCiscoLint({
  content,
  platform,
  debounceMs = 400,
}: {
  content: string;
  platform: CiscoPlatform | null;
  debounceMs?: number;
}): CiscoLintView {
  const requestToken = useRef(0);
  const [guardrailState, setGuardrailState] = useState<GuardrailState>({
    content: null,
    platform: null,
    debounceMs,
    diagnostics: [],
    guardrails: IDLE,
  });

  const structuralDiagnostics = useMemo(
    () => (platform ? lintCiscoConfig(content, platform).diagnostics : []),
    [content, platform],
  );

  useEffect(() => {
    const token = ++requestToken.current;
    if (!platform) {
      return;
    }

    const sourceLines = content
      .split(/\r\n|\r|\n/)
      .map((command, index) => ({
        command,
        line: index + 1,
        column: (command.match(/\S/)?.index ?? 0) + 1,
      }))
      .filter(({ command }) => {
        const trimmed = command.trim();
        return trimmed !== "" && !trimmed.startsWith("!");
      });

    const timeout = window.setTimeout(async () => {
      if (requestToken.current !== token) return;
      setGuardrailState({
        content,
        platform,
        debounceMs,
        diagnostics: [],
        guardrails: { state: "running", reason: null },
      });

      try {
        const results = await Promise.all(
          sourceLines.map(({ command }) =>
            classifyCommand("cisco", platform, command),
          ),
        );
        if (requestToken.current !== token) return;

        const diagnostics = results.flatMap((result, index) => {
          const source = sourceLines[index];
          const diagnostic = guardrailDiagnostic(
            source.line,
            source.column,
            platform,
            source.command,
            result,
          );
          return diagnostic ? [diagnostic] : [];
        });
        setGuardrailState({
          content,
          platform,
          debounceMs,
          diagnostics,
          guardrails: { state: "ready", reason: null },
        });
      } catch (error) {
        if (requestToken.current !== token) return;
        setGuardrailState({
          content,
          platform,
          debounceMs,
          diagnostics: [],
          guardrails: { state: "unavailable", reason: errorReason(error) },
        });
      }
    }, debounceMs);

    return () => {
      window.clearTimeout(timeout);
      if (requestToken.current === token) {
        requestToken.current += 1;
      }
    };
  }, [content, platform, debounceMs]);

  if (!platform) {
    return { diagnostics: [], guardrails: IDLE };
  }

  const stateIsCurrent =
    guardrailState.content === content &&
    guardrailState.platform === platform &&
    guardrailState.debounceMs === debounceMs;
  const guardrailDiagnostics = stateIsCurrent
    ? guardrailState.diagnostics
    : [];

  return {
    diagnostics: sortDiagnostics([
      ...structuralDiagnostics,
      ...guardrailDiagnostics,
    ]),
    guardrails: stateIsCurrent ? guardrailState.guardrails : IDLE,
  };
}
