import { useState } from 'react';

export interface CopyButtonProps {
  text: string;
}

export function CopyButton({ text }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="btn-copy"
      aria-label={`Copy ${text}`}
      title="Copy to clipboard"
    >
      {copied ? '✓' : '📋'}
    </button>
  );
}
