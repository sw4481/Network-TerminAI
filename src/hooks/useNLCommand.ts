import { useState, useCallback } from "react";
import { agentNLToCommand } from "../lib/tauri";

/**
 * Hook for natural language to command translation.
 * Detects `#` prefix and translates NL to shell command.
 */
export function useNLCommand(shell: string, cwd: string) {
  const [isTranslating, setIsTranslating] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  /**
   * Check if input starts with `# ` (natural language prefix).
   */
  const isNLInput = useCallback((input: string): boolean => {
    return input.startsWith("# ");
  }, []);

  /**
   * Extract natural language query from input (removes `# ` prefix).
   */
  const extractNLQuery = useCallback((input: string): string => {
    if (input.startsWith("# ")) {
      return input.slice(2).trim();
    }
    return input;
  }, []);

  /**
   * Translate natural language to command.
   * Returns the generated command, or null if translation fails.
   */
  const translateToCommand = useCallback(
    async (nlQuery: string): Promise<string | null> => {
      setIsTranslating(true);
      setLastError(null);

      try {
        const command = await agentNLToCommand({
          nlQuery,
          shell,
          cwd,
        });
        setIsTranslating(false);
        return command;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        setLastError(errorMessage);
        setIsTranslating(false);
        return null;
      }
    },
    [shell, cwd]
  );

  return {
    isNLInput,
    extractNLQuery,
    translateToCommand,
    isTranslating,
    lastError,
  };
}
