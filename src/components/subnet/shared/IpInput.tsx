export interface IpInputProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  error?: string;
  placeholder?: string;
}

export function IpInput({ value, onChange, onBlur, error, placeholder }: IpInputProps) {
  return (
    <div className="ip-input-container">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder || '192.168.1.0/24'}
        className={`ip-input ${error ? 'ip-input-error' : ''}`}
        aria-label="IP address with subnet mask"
        aria-invalid={!!error}
        aria-describedby={error ? 'ip-input-error' : undefined}
      />
      {error && (
        <div id="ip-input-error" className="ip-input-error-text" role="alert">
          ⚠ {error}
        </div>
      )}
    </div>
  );
}
