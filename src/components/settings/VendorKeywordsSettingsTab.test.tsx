import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import VendorKeywordsSettingsTab from './VendorKeywordsSettingsTab';
import * as tauri from '../../lib/tauri';

vi.mock('../../lib/tauri', () => ({
  vendorKeywordDefaults: vi.fn(),
  vendorKeywordsGet: vi.fn(),
  vendorKeywordsSet: vi.fn(),
}));

const DEFAULTS = {
  vendors: [
    { id: 'ise', display: 'Cisco ISE (identity)', keywords: ['ise', 'radius'] },
    { id: 'mist', display: 'Juniper Mist', keywords: ['mist', 'juniper'] },
  ],
};

describe('VendorKeywordsSettingsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauri.vendorKeywordDefaults).mockResolvedValue(DEFAULTS as any);
    vi.mocked(tauri.vendorKeywordsGet).mockResolvedValue('{}');
    vi.mocked(tauri.vendorKeywordsSet).mockResolvedValue(undefined);
  });

  it('renders a field per vendor pre-filled with defaults', async () => {
    render(<VendorKeywordsSettingsTab />);
    await waitFor(() => {
      expect(screen.getByText('Cisco ISE (identity)')).toBeInTheDocument();
      expect(screen.getByDisplayValue('ise, radius')).toBeInTheDocument();
      expect(screen.getByDisplayValue('mist, juniper')).toBeInTheDocument();
    });
  });

  it('pre-fills a saved override over the default', async () => {
    vi.mocked(tauri.vendorKeywordsGet).mockResolvedValue(
      JSON.stringify({ ise: ['ise', 'my-auth'] }),
    );
    render(<VendorKeywordsSettingsTab />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('ise, my-auth')).toBeInTheDocument();
    });
  });

  it('saves only vendors edited away from their default', async () => {
    render(<VendorKeywordsSettingsTab />);
    const iseField = await screen.findByDisplayValue('ise, radius');
    fireEvent.change(iseField, { target: { value: 'ise, radius, my-auth' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(tauri.vendorKeywordsSet).toHaveBeenCalledWith(
        JSON.stringify({ ise: ['ise', 'radius', 'my-auth'] }),
      );
    });
  });

  it('reset restores a vendor to its default and drops it from the save', async () => {
    vi.mocked(tauri.vendorKeywordsGet).mockResolvedValue(
      JSON.stringify({ ise: ['ise', 'my-auth'] }),
    );
    render(<VendorKeywordsSettingsTab />);
    const resetBtns = await screen.findAllByRole('button', { name: /reset/i });
    fireEvent.click(resetBtns[0]);
    await waitFor(() => {
      expect(screen.getByDisplayValue('ise, radius')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(tauri.vendorKeywordsSet).toHaveBeenCalledWith('{}');
    });
  });

  it('does not save a vendor whose text equals its default ignoring case', async () => {
    vi.mocked(tauri.vendorKeywordDefaults).mockResolvedValue({
      vendors: [{ id: 'ise', display: 'Cisco ISE (identity)', keywords: ['ISE', 'Radius'] }],
    } as any);
    vi.mocked(tauri.vendorKeywordsGet).mockResolvedValue('{}');
    render(<VendorKeywordsSettingsTab />);
    const field = await screen.findByDisplayValue('ISE, Radius');
    fireEvent.change(field, { target: { value: 'ise, radius' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(tauri.vendorKeywordsSet).toHaveBeenCalledWith('{}');
    });
  });

  it('does not wipe overrides when defaults fail to load', async () => {
    vi.mocked(tauri.vendorKeywordDefaults).mockRejectedValue(new Error('sidecar down'));
    vi.mocked(tauri.vendorKeywordsGet).mockResolvedValue(
      JSON.stringify({ ise: ['ise', 'my-auth'] }),
    );
    render(<VendorKeywordsSettingsTab />);
    // wait for the mount effect to settle (error status shown)
    const saveBtn = await screen.findByRole('button', { name: /save/i });
    expect(saveBtn).toBeDisabled();
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(tauri.vendorKeywordsSet).not.toHaveBeenCalled();
    });
  });
});
