import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BundleEditor } from './BundleEditor';
import type { CheckBundle } from '../lib/changeVerify';

describe('BundleEditor', () => {
  const mockOnSave = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    mockOnSave.mockClear();
    mockOnCancel.mockClear();
  });

  it('renders create mode when no existing bundle', () => {
    render(
      <BundleEditor
        vendor="cisco"
        platform="ios"
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.getByText('Create Bundle')).toBeInTheDocument();
  });

  it('renders edit mode when existing bundle provided', () => {
    const existingBundle: CheckBundle = {
      id: 'bundle-1',
      name: 'Test Bundle',
      description: 'Test description',
      vendor: 'cisco',
      platform: 'ios',
      commands: ['show version', 'show ip interface brief'],
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    render(
      <BundleEditor
        vendor="cisco"
        platform="ios"
        existing={existingBundle}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.getByText('Edit Bundle')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Test Bundle')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Test description')).toBeInTheDocument();
    expect(screen.getByDisplayValue(/show version/)).toBeInTheDocument();
  });

  it('allows editing name field', () => {
    render(
      <BundleEditor
        vendor="cisco"
        platform="ios"
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    const nameInput = screen.getByLabelText(/Name/i);
    fireEvent.change(nameInput, { target: { value: 'New Bundle Name' } });

    expect(nameInput).toHaveValue('New Bundle Name');
  });

  it('allows editing description field', () => {
    render(
      <BundleEditor
        vendor="cisco"
        platform="ios"
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    const descInput = screen.getByLabelText(/Description/i);
    fireEvent.change(descInput, { target: { value: 'New description' } });

    expect(descInput).toHaveValue('New description');
  });

  it('allows editing commands field', () => {
    render(
      <BundleEditor
        vendor="cisco"
        platform="ios"
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    const commandsInput = screen.getByLabelText(/Commands/i);
    fireEvent.change(commandsInput, {
      target: { value: 'show version\nshow ip interface brief' },
    });

    expect(commandsInput).toHaveValue('show version\nshow ip interface brief');
  });

  it('calls onCancel when cancel button clicked', () => {
    render(
      <BundleEditor
        vendor="cisco"
        platform="ios"
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    const cancelBtn = screen.getByRole('button', { name: /cancel/i });
    fireEvent.click(cancelBtn);

    expect(mockOnCancel).toHaveBeenCalledOnce();
  });

  it('calls onCancel when close button clicked', () => {
    render(
      <BundleEditor
        vendor="cisco"
        platform="ios"
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    const closeBtn = screen.getByLabelText(/close/i);
    fireEvent.click(closeBtn);

    expect(mockOnCancel).toHaveBeenCalledOnce();
  });

  it('validates name is required', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(
      <BundleEditor
        vendor="cisco"
        platform="ios"
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    const commandsInput = screen.getByLabelText(/Commands/i);
    fireEvent.change(commandsInput, { target: { value: 'show version' } });

    const saveBtn = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('Bundle name is required');
    });
    expect(mockOnSave).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('validates at least one command is required', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(
      <BundleEditor
        vendor="cisco"
        platform="ios"
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    const nameInput = screen.getByLabelText(/Name/i);
    fireEvent.change(nameInput, { target: { value: 'Test Bundle' } });

    const saveBtn = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('At least one command is required');
    });
    expect(mockOnSave).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('calls onSave with correct data', async () => {
    mockOnSave.mockResolvedValue(undefined);

    render(
      <BundleEditor
        vendor="cisco"
        platform="ios"
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    const nameInput = screen.getByLabelText(/Name/i);
    fireEvent.change(nameInput, { target: { value: 'Test Bundle' } });

    const descInput = screen.getByLabelText(/Description/i);
    fireEvent.change(descInput, { target: { value: 'Test description' } });

    const commandsInput = screen.getByLabelText(/Commands/i);
    fireEvent.change(commandsInput, {
      target: { value: 'show version\nshow ip interface brief' },
    });

    const saveBtn = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockOnSave).toHaveBeenCalledWith(
        'Test Bundle',
        'Test description',
        ['show version', 'show ip interface brief'],
      );
    });
  });

  it('filters out empty command lines', async () => {
    mockOnSave.mockResolvedValue(undefined);

    render(
      <BundleEditor
        vendor="cisco"
        platform="ios"
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    const nameInput = screen.getByLabelText(/Name/i);
    fireEvent.change(nameInput, { target: { value: 'Test Bundle' } });

    const commandsInput = screen.getByLabelText(/Commands/i);
    fireEvent.change(commandsInput, {
      target: { value: 'show version\n\n\nshow ip interface brief\n  ' },
    });

    const saveBtn = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockOnSave).toHaveBeenCalledWith(
        'Test Bundle',
        null,
        ['show version', 'show ip interface brief'],
      );
    });
  });

  it('passes null for empty description', async () => {
    mockOnSave.mockResolvedValue(undefined);

    render(
      <BundleEditor
        vendor="cisco"
        platform="ios"
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    const nameInput = screen.getByLabelText(/Name/i);
    fireEvent.change(nameInput, { target: { value: 'Test Bundle' } });

    const commandsInput = screen.getByLabelText(/Commands/i);
    fireEvent.change(commandsInput, { target: { value: 'show version' } });

    const saveBtn = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockOnSave).toHaveBeenCalledWith('Test Bundle', null, ['show version']);
    });
  });

  it('displays vendor and platform', () => {
    render(
      <BundleEditor
        vendor="cisco"
        platform="ios-xe"
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.getByText('Vendor: cisco')).toBeInTheDocument();
    expect(screen.getByText('Platform: ios-xe')).toBeInTheDocument();
  });
});
