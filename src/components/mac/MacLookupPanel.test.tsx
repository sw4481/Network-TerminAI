import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { MacLookupPanel } from './MacLookupPanel';
import type { MacLookupResult, RegistryInfo } from '../../lib/macLookup';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const registry: RegistryInfo = {
  snapshot_at: '2026-10-14T12:00:00Z',
  loaded_from: 'bundled',
  record_count: 54321,
  sources: [{ registry: 'MA-L', url: 'https://standards-oui.ieee.org/oui/oui.csv' }],
  cache_warning: null,
};
const result: MacLookupResult = {
  normalized: '00:11:22:33:44:55',
  formats: {
    colon: '00:11:22:33:44:55',
    hyphen: '00-11-22-33-44-55',
    dotted: '0011.2233.4455',
    plain: '001122334455',
  },
  oui: '00:11:22',
  binary: '00000000 00010001 00100010 00110011 01000100 01010101',
  is_multicast: false,
  is_locally_administered: false,
  is_broadcast: false,
  is_zero: false,
  warnings: [],
  assignment: {
    registry: 'MA-L',
    prefix: '001122',
    prefix_length: 24,
    organization: 'Example Networks Ltd',
    organization_address: '123 Example Road\nSuite 2\nLondon GB',
    block_start: '00:11:22:00:00:00',
    block_end: '00:11:22:FF:FF:FF',
    address_count: 16777216,
  },
  registry,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function lookup(address = '0011.2233.4455') {
  fireEvent.change(screen.getByLabelText('MAC address'), { target: { value: address } });
  fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
  return screen.findByText('Example Networks Ltd');
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'mac_registry_info') return registry;
    if (command === 'mac_lookup' && args && 'address' in args) return result;
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);

describe('MacLookupPanel', () => {
  it('provides a level-two heading above result-card headings', () => {
    render(<MacLookupPanel />);
    expect(screen.getByRole('heading', { level: 2, name: 'Lookup a MAC address' })).toBeVisible();
  });

  it('clears the previous result when the input changes so an edited address cannot appear resolved', async () => {
    render(<MacLookupPanel />);
    await lookup();
    fireEvent.change(screen.getByLabelText('MAC address'), { target: { value: 'aabbccddeeff' } });
    expect(screen.queryByText('Example Networks Ltd')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Address identity' })).not.toBeInTheDocument();
    expect(screen.getByText(/54,321 records/)).toBeVisible();
  });

  it('clears a previous result if a subsequent lookup of the unchanged input fails', async () => {
    render(<MacLookupPanel />);
    await lookup();
    vi.mocked(invoke).mockRejectedValueOnce(new Error('Lookup unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Lookup unavailable');
    expect(screen.queryByText('Example Networks Ltd')).not.toBeInTheDocument();
  });

  it('provides the fixed IEEE IAB registry source link', async () => {
    vi.mocked(invoke).mockResolvedValue({
      ...registry,
      sources: [{ registry: 'IAB', url: 'https://standards-oui.ieee.org/iab/iab.csv' }],
    });
    render(<MacLookupPanel />);
    expect(await screen.findByRole('link', { name: 'IEEE IAB' })).toHaveAttribute('href', 'https://standards-oui.ieee.org/iab/iab.csv');
  });

  // These checks catch missing labels/autofocus, wrong invoke payloads, and lost result fields.
  it('looks up with Enter and renders assignment, flags, formats, copies, and registry provenance', async () => {
    const user = userEvent.setup();
    render(<MacLookupPanel />);
    const input = screen.getByLabelText('MAC address');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('placeholder', expect.stringContaining('0011.2233.4455'));
    await user.type(input, '0011.2233.4455{Enter}');
    expect(await screen.findByText('Example Networks Ltd')).toBeVisible();
    expect(invoke).toHaveBeenCalledWith('mac_lookup', { address: '0011.2233.4455' });
    expect(screen.getByText('123 Example Road Suite 2 London GB')).toHaveTextContent('123 Example Road');
    expect(screen.getByText('123 Example Road Suite 2 London GB').textContent).toBe('123 Example Road\nSuite 2\nLondon GB');
    expect(screen.getByText('Unicast')).toBeVisible();
    expect(screen.getByText('Universally administered')).toBeVisible();
    for (const format of Object.values(result.formats)) {
      expect(screen.getByRole('button', { name: `Copy ${format}` })).toBeVisible();
    }
    expect(screen.getByText(result.binary)).toBeVisible();
    expect(screen.getByText('00:11:22:00:00:00')).toBeVisible();
    expect(screen.getByText('00:11:22:FF:FF:FF')).toBeVisible();
    expect(screen.getByText(/16,777,216/)).toBeVisible();
    expect(screen.getByText(/54,321 records/)).toBeVisible();
    expect(screen.getByText(/2026-10-14/)).toBeVisible();
    expect(screen.getByRole('link', { name: /MA-L/ })).toHaveAttribute('href', 'https://standards-oui.ieee.org/oui/oui.csv');
    await user.click(screen.getByRole('button', { name: 'Copy 0011.2233.4455' }));
    expect(await navigator.clipboard.readText()).toBe('0011.2233.4455');
  });

  it('shows backend validation errors as an alert without guessing a result', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'mac_registry_info') return registry;
      throw 'MAC address must contain exactly 12 hexadecimal digits';
    });
    render(<MacLookupPanel />);
    fireEvent.change(screen.getByLabelText('MAC address'), { target: { value: 'not-a-mac' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('12 hexadecimal digits');
    expect(screen.queryByText('Example Networks Ltd')).not.toBeInTheDocument();
    expect(screen.getByLabelText('MAC address')).toHaveAttribute('aria-invalid', 'true');
  });

  it('explains unknown globally administered addresses without inferring a manufacturer', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === 'mac_registry_info' ? registry : { ...result, assignment: null });
    render(<MacLookupPanel />);
    fireEvent.change(screen.getByLabelText('MAC address'), { target: { value: '001122334455' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText(/No IEEE assignment found/)).toBeVisible();
    expect(screen.getByText(/does not identify a device model/i)).toBeVisible();
  });

  it('distinguishes local or randomized addresses and CID assignees from device manufacturers', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === 'mac_registry_info' ? registry : {
      ...result, is_locally_administered: true,
      warnings: ['This is a locally administered address.'],
      assignment: { ...result.assignment!, registry: 'CID', organization: 'Example Local Assignee' },
    });
    render(<MacLookupPanel />);
    fireEvent.change(screen.getByLabelText('MAC address'), { target: { value: '021122334455' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText('Example Local Assignee')).toBeVisible();
    expect(screen.getByText('Locally administered')).toBeVisible();
    expect(screen.getByText(/may be randomized/i)).toBeVisible();
    expect(screen.getByText(/not a device manufacturer/i)).toBeVisible();
    expect(screen.getByText('This is a locally administered address.')).toBeVisible();
  });

  it('renders broadcast, multicast, zero-address flags and cache warnings from the backend', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === 'mac_registry_info' ? registry : {
      ...result, is_multicast: true, is_broadcast: true, is_zero: true,
      registry: { ...registry, cache_warning: 'Updated cache unavailable; bundled snapshot loaded.' },
    });
    render(<MacLookupPanel />);
    await lookup();
    expect(screen.getByText('Multicast')).toBeVisible();
    expect(screen.getByText('Broadcast')).toBeVisible();
    expect(screen.getByText('All-zero address')).toBeVisible();
    expect(screen.getByText(/Updated cache unavailable/)).toBeVisible();
  });

  // Deferred native IPC catches missing request-generation guards.
  it('does not show a delayed lookup answer after the input changes', async () => {
    const pending = deferred<MacLookupResult>();
    vi.mocked(invoke).mockImplementation(async (command) => command === 'mac_registry_info' ? registry : pending.promise);
    render(<MacLookupPanel />);
    fireEvent.change(screen.getByLabelText('MAC address'), { target: { value: '001122334455' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(screen.getByRole('status')).toHaveTextContent(/Looking up/);
    expect(screen.getByRole('button', { name: 'Look up' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('MAC address'), { target: { value: 'aabbccddeeff' } });
    await act(async () => pending.resolve(result));
    expect(screen.queryByText('Example Networks Ltd')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Look up' })).toBeEnabled();
  });

  it('keeps the latest submitted lookup when earlier responses arrive last', async () => {
    const old = deferred<MacLookupResult>();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'mac_registry_info') return registry;
      if (args && 'address' in args && args.address === 'old') return old.promise;
      return { ...result, assignment: { ...result.assignment!, organization: 'Latest Networks' } };
    });
    render(<MacLookupPanel />);
    const input = screen.getByLabelText('MAC address');
    fireEvent.change(input, { target: { value: 'old' } });
    fireEvent.submit(input.closest('form')!);
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByText('Latest Networks')).toBeVisible();
    await act(async () => old.resolve(result));
    expect(screen.getByText('Latest Networks')).toBeVisible();
    expect(screen.queryByText('Example Networks Ltd')).not.toBeInTheDocument();
  });

  it('ignores a delayed validation failure for an earlier input', async () => {
    const pending = deferred<MacLookupResult>();
    vi.mocked(invoke).mockImplementation(async (command) => command === 'mac_registry_info' ? registry : pending.promise);
    render(<MacLookupPanel />);
    const input = screen.getByLabelText('MAC address');
    fireEvent.change(input, { target: { value: 'old' } });
    fireEvent.submit(input.closest('form')!);
    fireEvent.change(input, { target: { value: 'new' } });
    await act(async () => pending.reject(new Error('Invalid old input')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('updates metadata and recomputes the displayed MAC with the new registry', async () => {
    const pending = deferred<RegistryInfo>();
    const updated = { ...registry, loaded_from: 'updated' as const, snapshot_at: '2026-10-15T12:00:00Z', record_count: 55000 };
    let downloaded = false;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'mac_registry_info') return downloaded ? updated : registry;
      if (command === 'mac_registry_update') { const info = await pending.promise; downloaded = true; return info; }
      if (command === 'mac_lookup') {
        if (downloaded && args && 'address' in args && args.address === result.normalized) {
          return { ...result, registry: updated, assignment: { ...result.assignment!, organization: 'Updated Networks' } };
        }
        return result;
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<MacLookupPanel />);
    await lookup();
    fireEvent.click(screen.getByRole('button', { name: 'Update Registry' }));
    expect(screen.getByRole('status')).toHaveTextContent('Downloading and validating IEEE registries…');
    expect(screen.getByRole('button', { name: 'Update Registry' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Look up' })).toBeDisabled();
    expect(screen.getByText('Example Networks Ltd')).toBeVisible();
    await act(async () => pending.resolve(updated));
    expect(await screen.findByText('Updated Networks')).toBeVisible();
    expect(screen.getByText(/55,000 records/)).toBeVisible();
    expect(screen.getByText(/2026-10-15/)).toBeVisible();
    expect(screen.getByText(/Updated snapshot/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Update Registry' })).toBeEnabled();
  });

  it('preserves the result and active dataset when registry update fails', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'mac_registry_info') return registry;
      if (command === 'mac_registry_update') throw new Error('IEEE download unavailable');
      return result;
    });
    render(<MacLookupPanel />);
    await lookup();
    fireEvent.click(screen.getByRole('button', { name: 'Update Registry' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/IEEE download unavailable/);
    expect(screen.getByRole('alert')).toHaveTextContent(/previous dataset stays active/i);
    expect(screen.getByText('Example Networks Ltd')).toBeVisible();
    expect(screen.getByText(/54,321 records/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Update Registry' })).toBeEnabled();
  });

  it('does not let an in-flight lookup overwrite a completed registry update', async () => {
    const old = deferred<MacLookupResult>();
    const updated = { ...registry, loaded_from: 'updated' as const, record_count: 55000 };
    let downloaded = false;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'mac_registry_info') return downloaded ? updated : registry;
      if (command === 'mac_registry_update') { downloaded = true; return updated; }
      return old.promise;
    });
    render(<MacLookupPanel />);
    const input = screen.getByLabelText('MAC address');
    fireEvent.change(input, { target: { value: '001122334455' } });
    fireEvent.submit(input.closest('form')!);
    fireEvent.click(screen.getByRole('button', { name: 'Update Registry' }));
    await waitFor(() => expect(screen.getByText(/55,000 records/)).toBeVisible());
    await act(async () => old.resolve(result));
    expect(screen.queryByText('Example Networks Ltd')).not.toBeInTheDocument();
    expect(screen.getByText(/55,000 records/)).toBeVisible();
  });

  it('reports metadata errors safely and keeps lookup available', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'mac_registry_info') throw { detail: 'unstructured native failure' };
      return result;
    });
    render(<MacLookupPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Registry information unavailable/);
    expect(screen.getByRole('alert')).not.toHaveTextContent('[object Object]');
    await lookup();
    expect(screen.getByText(/54,321 records/)).toBeVisible();
  });
});
