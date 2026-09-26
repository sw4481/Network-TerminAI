import { useState } from 'react';

interface PcapAdvancedFormProps {
  onRun: (rawCommands: string) => void;
}

/**
 * Escape hatch for vendor flows the builder doesn't support out of the box
 * (e.g. classic IOS 15.x capture-point + capture-buffer, or EOS show-tech-
 * style flows). Hands the textarea contents to the caller, which is
 * responsible for sending those lines through whatever SSH path applies.
 */
export function PcapAdvancedForm({ onRun }: PcapAdvancedFormProps) {
  const [text, setText] = useState('');
  return (
    <form
      className="pcap-advanced-form"
      data-testid="pcap-advanced-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onRun(text);
      }}
    >
      <label>
        Raw capture commands (one per line)
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          placeholder={
            'monitor capture point ip cef CAP all both\nmonitor capture buffer BUF size 10 max-size 9500 circular\nmonitor capture point associate CAP BUF\nmonitor capture point start CAP'
          }
          data-testid="pcap-advanced-textarea"
        />
      </label>
      <button type="submit" disabled={!text.trim()}>
        Run raw commands
      </button>
    </form>
  );
}
