import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SeverityChip } from './SeverityChip';

describe('SeverityChip', () => {
  it('renders red severity', () => {
    render(<SeverityChip severity="red" />);
    expect(screen.getByText('red')).toBeInTheDocument();
    const chip = screen.getByText('red');
    expect(chip).toHaveClass('severity-chip', 'severity-red');
  });

  it('renders yellow severity', () => {
    render(<SeverityChip severity="yellow" />);
    expect(screen.getByText('yellow')).toBeInTheDocument();
    const chip = screen.getByText('yellow');
    expect(chip).toHaveClass('severity-chip', 'severity-yellow');
  });

  it('renders green severity', () => {
    render(<SeverityChip severity="green" />);
    expect(screen.getByText('green')).toBeInTheDocument();
    const chip = screen.getByText('green');
    expect(chip).toHaveClass('severity-chip', 'severity-green');
  });

  it('renders count when provided', () => {
    render(<SeverityChip severity="red" count={5} />);
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.queryByText('red')).not.toBeInTheDocument();
  });

  it('renders zero count', () => {
    render(<SeverityChip severity="green" count={0} />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });
});
