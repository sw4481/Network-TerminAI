import { invoke } from '@tauri-apps/api/core';

export interface NaturalToCommandResponse {
  command: string;
  explanation: string;
}

export interface ErrorAnalysisResponse {
  errorType: string;
  explanation: string;
  suggestions: string[];
}

/**
 * Convert natural language to a command.
 *
 * @param natural - Natural language description of what the user wants to do
 * @param cwd - Current working directory
 * @param tabId - Active tab ID (required for context)
 * @param paneId - Focused pane ID (optional, provides additional context)
 */
export async function aiNaturalToCommand(
  natural: string,
  cwd: string,
  tabId: string,
  paneId?: string
): Promise<NaturalToCommandResponse> {
  return invoke('ai_natural_to_command', {
    naturalLanguage: natural,
    cwd,
    tabId,
    paneId: paneId ?? null,
  });
}

/**
 * Analyze a command error and provide suggestions.
 *
 * @param command - The command that failed
 * @param output - The command output
 * @param exitCode - The exit code
 * @param cwd - Current working directory
 * @param tabId - Active tab ID (required for context)
 * @param paneId - Focused pane ID (optional, provides additional context)
 */
export async function aiAnalyzeError(
  command: string,
  output: string,
  exitCode: number,
  cwd: string,
  tabId: string,
  paneId?: string
): Promise<ErrorAnalysisResponse> {
  return invoke('ai_analyze_error', {
    command,
    output,
    exitCode,
    cwd,
    tabId,
    paneId: paneId ?? null,
  });
}
