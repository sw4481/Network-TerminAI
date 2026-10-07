import { beforeEach, describe, expect, it } from 'vitest';
import { usePanesStore, type PaneNode } from './panesStore';
import { useTabs } from './tabsStore';
import { useTerminalConnectionStore } from './terminalConnectionStore';
import { MANAGED_SSH_SHELL_MARKER } from '../lib/sessionRestore';

const layout: PaneNode = {
  type: 'split', id: 'split', direction: 'horizontal', size: 100,
  children: [
    { type: 'leaf', id: 'managed-root', terminalId: 'managed-tab', size: 50 },
    { type: 'leaf', id: 'local-child', terminalId: 'local-pty', size: 50 },
  ],
};

beforeEach(() => {
  useTerminalConnectionStore.setState({ byTerminalId: {}, terminalIdByBackendPtyId: {} });
  usePanesStore.setState({ layoutsByTab: new Map([['managed-tab', layout]]), focusedPaneId: 'managed-root' });
  useTabs.setState({
    tabs: [{ id: 'managed-tab', title: 'Core', shell_cmd: MANAGED_SSH_SHELL_MARKER,
      cwd: '/', created_at: 0, tab_type: 'terminal' }],
    activeTabId: 'managed-tab', blocks: {},
  });
});

describe('managed root pane close', () => {
  it('does not remove the managed PTY from its layout through Cmd+W', () => {
    expect(usePanesStore.getState().closePane('managed-root')).toBe(layout);
    expect(usePanesStore.getState().layoutsByTab.get('managed-tab')).toBe(layout);
  });
});
