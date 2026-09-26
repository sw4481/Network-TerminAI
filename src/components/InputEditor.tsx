import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import './InputEditor.css';

interface InputEditorProps {
  prompt?: string;
  onExecute: (command: string) => void;
  disabled?: boolean;
}

export function InputEditor({ prompt = '$ ', onExecute, disabled = false }: InputEditorProps) {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus on mount
  useEffect(() => {
    if (textareaRef.current && !disabled) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter - execute command (Shift+Enter for newline)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const cmd = value.trim();
      if (cmd) {
        // Add to history
        setHistory(prev => [...prev, cmd]);
        setHistoryIndex(-1);

        // Execute
        onExecute(cmd);

        // Clear input
        setValue('');
      }
      return;
    }

    // Up arrow - previous command
    if (e.key === 'ArrowUp' && !e.shiftKey) {
      e.preventDefault();
      if (history.length === 0) return;

      const newIndex = historyIndex === -1
        ? history.length - 1
        : Math.max(0, historyIndex - 1);

      setHistoryIndex(newIndex);
      setValue(history[newIndex]);
      return;
    }

    // Down arrow - next command
    if (e.key === 'ArrowDown' && !e.shiftKey) {
      e.preventDefault();
      if (historyIndex === -1) return;

      if (historyIndex === history.length - 1) {
        setHistoryIndex(-1);
        setValue('');
      } else {
        const newIndex = historyIndex + 1;
        setHistoryIndex(newIndex);
        setValue(history[newIndex]);
      }
      return;
    }

    // Ctrl+C - clear current input
    if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
      if (value === '') {
        // If empty, send SIGINT to PTY
        onExecute('\x03');
        return;
      }
      // If not empty, let default copy behavior work
      return;
    }

    // Ctrl+D - EOF
    if (e.key === 'd' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (value === '') {
        onExecute('\x04'); // Send EOF
      }
      return;
    }
  };

  return (
    <div className="input-editor">
      <div className="input-prompt">{prompt}</div>
      <textarea
        ref={textareaRef}
        className="input-textarea"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder="Type a command..."
        rows={1}
        spellCheck={false}
      />
    </div>
  );
}
