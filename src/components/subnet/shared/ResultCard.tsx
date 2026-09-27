import type { ReactNode } from 'react';

export interface ResultCardProps {
  title?: string;
  children: ReactNode;
  className?: string;
}

export function ResultCard({ title, children, className = '' }: ResultCardProps) {
  return (
    <div className={`result-card ${className}`}>
      {title && <h3 className="result-card-title">{title}</h3>}
      <div className="result-card-content">{children}</div>
    </div>
  );
}
