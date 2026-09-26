import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useMetadataStore } from '../state/metadataStore';
import MetadataCard from './MetadataCard';

// panesStore is read for the focused-pane id (drives a refresh effect).
// Stub it so mounting doesn't touch real pane state.
vi.mock('../state/panesStore', () => ({
  usePanesStore: Object.assign(
    (selector: (s: any) => unknown) => selector({ focusedPaneId: null }),
    { getState: () => ({ focusedPaneId: null }) },
  ),
}));

beforeEach(() => {
  useMetadataStore.setState({
    open: true, loading: false, error: null,
    position: { x: 10, y: 10 },
    // Override refresh so the on-open/on-focus effect can't clobber the
    // seeded data with a real (empty) pane lookup.
    refresh: () => Promise.resolve(),
    data: {
      git: { branch: 'main', dirty: true, changedCount: 3, ahead: 1, behind: 0 },
      ports: [{ port: 8000, procName: 'python3' }],
      ssh: { host: '192.168.1.1', user: 'admin', port: 22, source: 'chain' },
      gatheredAt: 1700000000,
    },
  });
});

describe('MetadataCard', () => {
  it('renders all three sections from data', () => {
    render(<MetadataCard />);
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText(/8000/)).toBeInTheDocument();
    expect(screen.getByText(/192\.168\.1\.1/)).toBeInTheDocument();
    expect(screen.getByText(/chain/i)).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    useMetadataStore.setState({ open: false });
    const { container } = render(<MetadataCard />);
    expect(container.firstChild).toBeNull();
  });

  it('shows empty states when sections are absent', () => {
    useMetadataStore.setState({
      data: { git: null, ports: [], ssh: null, gatheredAt: 1700000000 },
    });
    render(<MetadataCard />);
    expect(screen.getByText(/not a git repo/i)).toBeInTheDocument();
    expect(screen.getByText(/no listening ports/i)).toBeInTheDocument();
    expect(screen.getByText(/not an ssh session/i)).toBeInTheDocument();
  });
});
