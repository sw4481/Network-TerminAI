import './SeverityChip.css';

export type Severity = "red" | "yellow" | "green";

interface SeverityChipProps {
  severity: Severity;
  count?: number;
}

export function SeverityChip({ severity, count }: SeverityChipProps) {
  return (
    <span
      className={`severity-chip severity-${severity}`}
      data-testid={`severity-chip-${severity}`}
    >
      {count !== undefined ? count : severity}
    </span>
  );
}
