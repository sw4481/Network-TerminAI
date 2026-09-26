import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SubnetTab } from './SubnetTab';

describe('SubnetTab', () => {
  const mockTab = {
    id: 'test-subnet-tab',
    title: 'Subnet Calculator',
    shell_cmd: '',
    cwd: '',
    created_at: Date.now(),
    tab_type: 'subnet' as const,
  };

  it('renders without crashing', () => {
    render(<SubnetTab tab={mockTab} />);
    expect(screen.getByText('CIDR Calculator')).toBeInTheDocument();
  });

  it('renders feature sidebar', () => {
    render(<SubnetTab tab={mockTab} />);
    expect(screen.getByText('CIDR')).toBeInTheDocument();
    expect(screen.getByText('Split')).toBeInTheDocument();
    expect(screen.getByText('VLSM')).toBeInTheDocument();
  });

  it('switches tools when sidebar button clicked', () => {
    render(<SubnetTab tab={mockTab} />);

    // Default tool is CIDR
    expect(screen.getByText('CIDR Calculator')).toBeInTheDocument();

    // Click Split button
    fireEvent.click(screen.getByText('Split'));

    // Should show Subnet Splitter
    expect(screen.getByText('Subnet Splitter')).toBeInTheDocument();
  });

  it('renders quick reference toggle', () => {
    render(<SubnetTab tab={mockTab} />);
    expect(screen.getByText(/Reference/i)).toBeInTheDocument();
  });
});
