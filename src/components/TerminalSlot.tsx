import { useEffect, useRef, useState, useCallback } from 'react';
import * as terminalRegistry from '../lib/terminalRegistry';
import { ptyWrite } from '../lib/tauri';
import { CommandSuggestions } from './CommandSuggestions';
import { useCommandSuggestions } from '../hooks/useCommandSuggestions';

type TerminalSlotProps = {
  terminalId: string;
  shell: string;
  cwd: string;
  skipTabRegistration?: boolean;
  onRegistered?: (ptyTabId: string) => void;
  attach?: boolean;
  replayBytes?: number[];
};

export function TerminalSlot({
  terminalId, shell, cwd, skipTabRegistration, onRegistered, attach, replayBytes,
}: TerminalSlotProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [currentInput, setCurrentInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const lineBufferRef = useRef<string>('');

  const { suggestions, loading, getSuggestions, clearSuggestions } = useCommandSuggestions(cwd);

  useEffect(() => {
    if (!slotRef.current) return;
    const entry = terminalRegistry.getOrCreate(terminalId, {
      shell,
      cwd,
      skipTabRegistration,
      attach,
      replayBytes,
      onPtyReady: (ptyTabId) => onRegistered?.(ptyTabId),
    });
    terminalRegistry.attach(terminalId, slotRef.current);
    if (entry.ptyTabId) onRegistered?.(entry.ptyTabId);
    return () => {
      terminalRegistry.detach(terminalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  // Track terminal input for suggestions
  useEffect(() => {
    // Check if entry exists first
    if (!terminalRegistry.has(terminalId)) return;

    const entry = terminalRegistry.getOrCreate(terminalId, { shell, cwd, skipTabRegistration });
    if (!entry?.xterm) return;

    const disposable = entry.xterm.onData((data: string) => {
      const charCode = data.charCodeAt(0);

      // Enter or Ctrl+C - reset
      if (charCode === 13 || charCode === 3) {
        lineBufferRef.current = '';
        setCurrentInput('');
        setShowSuggestions(false);
        clearSuggestions();
      }
      // Backspace
      else if (charCode === 127 || charCode === 8) {
        lineBufferRef.current = lineBufferRef.current.slice(0, -1);
        setCurrentInput(lineBufferRef.current);
      }
      // Printable characters
      else if (charCode >= 32 && charCode <= 126) {
        lineBufferRef.current += data;
        setCurrentInput(lineBufferRef.current);
      }
    });

    return () => disposable.dispose();
  }, [terminalId, clearSuggestions]);

  // History suggestions stay active for the complete typed prefix. The hook
  // applies the independent AI length and inactivity preferences.
  useEffect(() => {
    const trimmed = currentInput.trim();
    if (trimmed.length >= 2) {
      getSuggestions(currentInput);
      setShowSuggestions(true);
      setSelectedIndex(0);
    } else {
      setShowSuggestions(false);
      clearSuggestions();
    }
  }, [currentInput, getSuggestions, clearSuggestions]);

  const handleSelectSuggestion = useCallback((command: string) => {
    setShowSuggestions(false);
    clearSuggestions();

    const ptyTabId = terminalRegistry.ptyTabIdFor(terminalId);
    if (!ptyTabId) return;

    // Complete the difference: if the suggestion extends what's typed, append
    // only the new part; otherwise clear the line and write the full command.
    const current = lineBufferRef.current;
    let textToWrite: string;
    if (command.startsWith(current)) {
      textToWrite = command.slice(current.length);
    } else {
      // Backspace over the current buffer, then write the full command.
      textToWrite = '\b \b'.repeat(current.length) + command;
    }

    ptyWrite(ptyTabId, new TextEncoder().encode(textToWrite)).catch(() => {});
    lineBufferRef.current = command;
  }, [terminalId, clearSuggestions]);

  // xterm forwards its onData event to the PTY before passive observers can
  // cancel it. Capture Tab at the DOM boundary so accepting a visible result
  // never also sends a literal Tab to the shell.
  useEffect(() => {
    if (!showSuggestions || suggestions.length === 0 || selectedIndex < 0) return;

    const handleTabCapture = (event: KeyboardEvent) => {
      if (
        event.key !== 'Tab'
        || event.shiftKey
        || event.metaKey
        || event.ctrlKey
        || event.altKey
      ) return;

      const target = event.target as Node | null;
      if (!target || !slotRef.current?.contains(target)) return;

      const selectedCommand = suggestions[selectedIndex]?.command;
      if (!selectedCommand) return;

      event.preventDefault();
      event.stopPropagation();
      handleSelectSuggestion(selectedCommand);
    };

    window.addEventListener('keydown', handleTabCapture, true);
    return () => window.removeEventListener('keydown', handleTabCapture, true);
  }, [handleSelectSuggestion, selectedIndex, showSuggestions, suggestions]);

  return (
    <>
      <div ref={slotRef} className="terminal-slot" style={{ width: '100%', height: '100%' }} />
      {showSuggestions && (
        <CommandSuggestions
          suggestions={suggestions}
          onSelect={handleSelectSuggestion}
          onClose={() => {
            setShowSuggestions(false);
            clearSuggestions();
          }}
          visible={showSuggestions}
          selectedIndex={selectedIndex}
          loading={loading}
        />
      )}
    </>
  );
}
