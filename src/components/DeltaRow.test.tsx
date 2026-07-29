import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeltaRow } from './DeltaRow';
import type { ClassifiedDelta } from '../lib/changeVerify';

describe('DeltaRow', () => {
  const mockDelta: ClassifiedDelta = {
    command: 'show ip interface brief',
    family: 'ios',
    severity: 'red',
    path: '/interfaces/GigabitEthernet0/0/status',
    before: 'up',
    after: 'down',
    message: 'Interface status changed',
  };

  it('renders severity chip', () => {
    const onApprove = vi.fn();
    render(<DeltaRow delta={mockDelta} onApprove={onApprove} />);

    expect(screen.getByText('red')).toBeInTheDocument();
  });

  it('renders path', () => {
    const onApprove = vi.fn();
    render(<DeltaRow delta={mockDelta} onApprove={onApprove} />);

    expect(screen.getByText('/interfaces/GigabitEthernet0/0/status')).toBeInTheDocument();
  });

  it('renders before and after values', () => {
    const onApprove = vi.fn();
    render(<DeltaRow delta={mockDelta} onApprove={onApprove} />);

    expect(screen.getByText('"up"')).toBeInTheDocument();
    expect(screen.getByText('"down"')).toBeInTheDocument();
  });

  it('renders message', () => {
    const onApprove = vi.fn();
    render(<DeltaRow delta={mockDelta} onApprove={onApprove} />);

    expect(screen.getByText('Interface status changed')).toBeInTheDocument();
  });

  it('shows Approve button for red severity', () => {
    const onApprove = vi.fn();
    render(<DeltaRow delta={mockDelta} onApprove={onApprove} />);

    const approveBtn = screen.getByRole('button', { name: /approve/i });
    expect(approveBtn).toBeInTheDocument();
  });

  it('shows Approve button for yellow severity', () => {
    const onApprove = vi.fn();
    const yellowDelta = { ...mockDelta, severity: 'yellow' as const };
    render(<DeltaRow delta={yellowDelta} onApprove={onApprove} />);

    const approveBtn = screen.getByRole('button', { name: /approve/i });
    expect(approveBtn).toBeInTheDocument();
  });

  it('does not show Approve button for green severity', () => {
    const onApprove = vi.fn();
    const greenDelta = { ...mockDelta, severity: 'green' as const };
    render(<DeltaRow delta={greenDelta} onApprove={onApprove} />);

    const approveBtn = screen.queryByRole('button', { name: /approve/i });
    expect(approveBtn).not.toBeInTheDocument();
  });

  it('calls onApprove when Approve button clicked', () => {
    const onApprove = vi.fn();
    render(<DeltaRow delta={mockDelta} onApprove={onApprove} />);

    const approveBtn = screen.getByRole('button', { name: /approve/i });
    fireEvent.click(approveBtn);

    expect(onApprove).toHaveBeenCalledOnce();
  });
});
