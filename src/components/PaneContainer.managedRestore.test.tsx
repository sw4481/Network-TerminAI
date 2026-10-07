import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PaneContainer } from './PaneContainer';
import type { PaneNode } from '../state/panesStore';
import { MANAGED_SSH_SHELL_MARKER } from '../lib/sessionRestore';
import { defaultShell } from '../lib/defaultShell';

vi.mock('./Pane', () => ({
  Pane: ({ terminalId, shell }: { terminalId: string; shell: string }) =>
    <div data-testid={terminalId} data-shell={shell} />,
}));
vi.mock('./PaneHandle', () => ({ PaneHandle: () => null }));
vi.mock('../state/panesStore', () => ({
  usePanesStore: (selector: (state: { resizePane: () => void }) => unknown) =>
    selector({ resizePane: () => {} }),
}));

const layout: PaneNode = {
  type: 'split', id: 'layout', direction: 'horizontal', size: 100,
  children: [
    { type: 'leaf', id: 'root', terminalId: 'managed-root', size: 50 },
    { type: 'leaf', id: 'other', terminalId: 'local-split', size: 50 },
  ],
};

describe('PaneContainer managed SSH restore', () => {
  it('retains only the managed root read-only; a saved manual split gets a local shell', () => {
    render(<PaneContainer node={layout} shell={MANAGED_SSH_SHELL_MARKER}
      managedRootTerminalId="managed-root" cwd="/" />);
    expect(screen.getByTestId('managed-root').getAttribute('data-shell')).toBe(MANAGED_SSH_SHELL_MARKER);
    expect(screen.getByTestId('local-split').getAttribute('data-shell')).toBe(defaultShell());
  });

  it('leaves ordinary local and macOS split shells unchanged', () => {
    render(<PaneContainer node={layout} shell="/bin/zsh" cwd="/" />);
    expect(screen.getByTestId('managed-root').getAttribute('data-shell')).toBe('/bin/zsh');
    expect(screen.getByTestId('local-split').getAttribute('data-shell')).toBe('/bin/zsh');
  });
});
