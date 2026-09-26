import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BundlePicker } from './BundlePicker';
import { useChangeVerifyStore } from '../state/changeVerifyStore';
import type { CheckBundle } from '../lib/changeVerify';

vi.mock('../state/changeVerifyStore');

describe('BundlePicker', () => {
  const mockBundles: CheckBundle[] = [
    {
      id: 'bundle-1',
      name: 'Pre-Upgrade Checks',
      description: 'Check before upgrade',
      vendor: 'cisco',
      platform: 'ios',
      commands: ['show version', 'show ip interface brief'],
      created_at: Date.now(),
      updated_at: Date.now(),
    },
    {
      id: 'bundle-2',
      name: 'Post-Upgrade Checks',
      description: null,
      vendor: 'cisco',
      platform: 'ios',
      commands: ['show version'],
      created_at: Date.now(),
      updated_at: Date.now(),
    },
  ];

  const mockLoadBundles = vi.fn();
  const onSelect = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const onCreateNew = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useChangeVerifyStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      bundles: mockBundles,
      loading: false,
      loadBundles: mockLoadBundles,
      selectedBundleId: null,
    });
  });

  it('calls loadBundles on mount with vendor and platform', () => {
    render(
      <BundlePicker
        vendor="cisco"
        platform="ios"
        onSelect={onSelect}
        onEdit={onEdit}
        onDelete={onDelete}
        onCreateNew={onCreateNew}
      />
    );

    expect(mockLoadBundles).toHaveBeenCalledWith('cisco', 'ios');
  });

  it('renders bundles from store', () => {
    render(
      <BundlePicker
        vendor="cisco"
        platform="ios"
        onSelect={onSelect}
        onEdit={onEdit}
        onDelete={onDelete}
        onCreateNew={onCreateNew}
      />
    );

    expect(screen.getByText('Pre-Upgrade Checks')).toBeInTheDocument();
    expect(screen.getByText('Post-Upgrade Checks')).toBeInTheDocument();
    expect(screen.getByText('2 commands')).toBeInTheDocument();
    expect(screen.getByText('1 commands')).toBeInTheDocument();
  });

  it('renders description when present', () => {
    render(
      <BundlePicker
        vendor="cisco"
        platform="ios"
        onSelect={onSelect}
        onEdit={onEdit}
        onDelete={onDelete}
        onCreateNew={onCreateNew}
      />
    );

    expect(screen.getByText('Check before upgrade')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    (useChangeVerifyStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      bundles: [],
      loading: true,
      loadBundles: mockLoadBundles,
      selectedBundleId: null,
    });

    render(
      <BundlePicker
        vendor="cisco"
        platform="ios"
        onSelect={onSelect}
        onEdit={onEdit}
        onDelete={onDelete}
        onCreateNew={onCreateNew}
      />
    );

    expect(screen.getByText('Loading bundles...')).toBeInTheDocument();
  });

  it('shows empty state when no bundles', () => {
    (useChangeVerifyStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      bundles: [],
      loading: false,
      loadBundles: mockLoadBundles,
      selectedBundleId: null,
    });

    render(
      <BundlePicker
        vendor="cisco"
        platform="ios"
        onSelect={onSelect}
        onEdit={onEdit}
        onDelete={onDelete}
        onCreateNew={onCreateNew}
      />
    );

    expect(screen.getByText(/No bundles found/i)).toBeInTheDocument();
  });

  it('calls onSelect when bundle clicked', () => {
    render(
      <BundlePicker
        vendor="cisco"
        platform="ios"
        onSelect={onSelect}
        onEdit={onEdit}
        onDelete={onDelete}
        onCreateNew={onCreateNew}
      />
    );

    const bundle = screen.getByText('Pre-Upgrade Checks').closest('.bundle-item');
    fireEvent.click(bundle!);

    expect(onSelect).toHaveBeenCalledWith('bundle-1');
  });

  it('calls onEdit when edit button clicked', () => {
    render(
      <BundlePicker
        vendor="cisco"
        platform="ios"
        onSelect={onSelect}
        onEdit={onEdit}
        onDelete={onDelete}
        onCreateNew={onCreateNew}
      />
    );

    const editBtn = screen.getAllByLabelText('Edit bundle')[0];
    fireEvent.click(editBtn);

    expect(onEdit).toHaveBeenCalledWith('bundle-1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('calls onDelete when delete button clicked after confirmation', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <BundlePicker
        vendor="cisco"
        platform="ios"
        onSelect={onSelect}
        onEdit={onEdit}
        onDelete={onDelete}
        onCreateNew={onCreateNew}
      />
    );

    const deleteBtn = screen.getAllByLabelText('Delete bundle')[0];
    fireEvent.click(deleteBtn);

    expect(confirmSpy).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalledWith('bundle-1');

    confirmSpy.mockRestore();
  });

  it('calls onCreateNew when create button clicked', () => {
    render(
      <BundlePicker
        vendor="cisco"
        platform="ios"
        onSelect={onSelect}
        onEdit={onEdit}
        onDelete={onDelete}
        onCreateNew={onCreateNew}
      />
    );

    const createBtn = screen.getByText(/Create New Bundle/i);
    fireEvent.click(createBtn);

    expect(onCreateNew).toHaveBeenCalledOnce();
  });

  it('highlights selected bundle', () => {
    (useChangeVerifyStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      bundles: mockBundles,
      loading: false,
      loadBundles: mockLoadBundles,
      selectedBundleId: 'bundle-1',
    });

    render(
      <BundlePicker
        vendor="cisco"
        platform="ios"
        onSelect={onSelect}
        onEdit={onEdit}
        onDelete={onDelete}
        onCreateNew={onCreateNew}
      />
    );

    const bundle = screen.getByText('Pre-Upgrade Checks').closest('.bundle-item');
    expect(bundle).toHaveClass('selected');
  });
});
