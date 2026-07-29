import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const getOrCreate = vi.fn((_id?: any, _opts?: any) => ({ ptyTabId: 'pty-1' }));
const attach = vi.fn((_id?: any, _slot?: any) => {});
const detach = vi.fn((_id?: any) => {});
vi.mock('../lib/terminalRegistry', () => ({
  getOrCreate: (id?: any, opts?: any) => getOrCreate(id, opts),
  attach: (id?: any, slot?: any) => attach(id, slot),
  detach: (id?: any) => detach(id),
  has: (_id?: any) => false,
  ptyTabIdFor: (_id?: any) => undefined,
}));

import { TerminalSlot } from './TerminalSlot';

beforeEach(() => { getOrCreate.mockClear(); attach.mockClear(); detach.mockClear(); });

describe('TerminalSlot', () => {
  it('creates + attaches on mount, detaches (not disposes) on unmount', () => {
    const onRegistered = vi.fn();
    const { unmount } = render(
      <TerminalSlot terminalId="t1" shell="/bin/zsh" cwd="/home" onRegistered={onRegistered} />,
    );
    expect(getOrCreate).toHaveBeenCalledWith('t1', expect.objectContaining({ shell: '/bin/zsh', cwd: '/home' }));
    expect(attach).toHaveBeenCalledWith('t1', expect.any(HTMLElement));
    expect(onRegistered).toHaveBeenCalledWith('pty-1');
    unmount();
    expect(detach).toHaveBeenCalledWith('t1');
  });
});
