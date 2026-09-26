import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ParameterForm } from './ParameterForm';
import { PARAMETER_DEFINITIONS } from '../hooks/useParameterDetection';

describe('ParameterForm', () => {
  it('should render form with command name', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    render(
      <ParameterForm
        commandDef={PARAMETER_DEFINITIONS.ssh}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    expect(screen.getByRole('heading', { name: /ssh/i })).toBeInTheDocument();
  });

  it('should render all parameters', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    render(
      <ParameterForm
        commandDef={PARAMETER_DEFINITIONS.ssh}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    expect(screen.getByPlaceholderText(/example.com/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/username/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('22')).toBeInTheDocument();
  });

  it('should mark required fields', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    render(
      <ParameterForm
        commandDef={PARAMETER_DEFINITIONS.ssh}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    // Host is required for ssh
    const hostInput = screen.getByPlaceholderText(/example.com/i) as HTMLInputElement;
    expect(hostInput.required).toBe(true);
  });

  it('should call onCancel when cancel is clicked', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    render(
      <ParameterForm
        commandDef={PARAMETER_DEFINITIONS.ssh}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    const cancelButton = screen.getByText(/cancel/i);
    fireEvent.click(cancelButton);

    expect(onCancel).toHaveBeenCalled();
  });

  it('should call onCancel when Escape key is pressed', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    render(
      <ParameterForm
        commandDef={PARAMETER_DEFINITIONS.ssh}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onCancel).toHaveBeenCalled();
  });

  it('should validate required fields on submit', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    render(
      <ParameterForm
        commandDef={PARAMETER_DEFINITIONS.ssh}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    const submitButton = screen.getByText(/execute/i);
    fireEvent.click(submitButton);

    // Should not call onSubmit without required field
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('should submit form with valid data', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    render(
      <ParameterForm
        commandDef={PARAMETER_DEFINITIONS.ssh}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    const hostInput = screen.getByPlaceholderText(/example.com/i);
    fireEvent.change(hostInput, { target: { value: 'test.com' } });

    const submitButton = screen.getByText(/execute/i);
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
      const cmd = (onSubmit.mock.calls[0]?.[0] ?? '') as string;
      expect(cmd).toContain('ssh');
      expect(cmd).toContain('test.com');
    });
  });

  it('should build correct command from form values', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    render(
      <ParameterForm
        commandDef={PARAMETER_DEFINITIONS.ssh}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    const hostInput = screen.getByPlaceholderText(/example.com/i);
    const userInput = screen.getByPlaceholderText(/username/i);
    const portInput = screen.getByPlaceholderText('22');

    fireEvent.change(hostInput, { target: { value: 'example.com' } });
    fireEvent.change(userInput, { target: { value: 'admin' } });
    fireEvent.change(portInput, { target: { value: '2222' } });

    const submitButton = screen.getByText(/execute/i);
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
      const cmd = (onSubmit.mock.calls[0]?.[0] ?? '') as string;
      expect(cmd).toBe('ssh -p 2222 admin@example.com');
    });
  });

  it('should render select fields correctly', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    render(
      <ParameterForm
        commandDef={PARAMETER_DEFINITIONS.scp}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    // scp has a recursive select field
    const recursiveSelect = screen.getByRole('combobox', { name: /recursive/i });
    expect(recursiveSelect).toBeInTheDocument();
  });

  it('should handle number input types', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    render(
      <ParameterForm
        commandDef={PARAMETER_DEFINITIONS.ssh}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    const portInput = screen.getByPlaceholderText('22') as HTMLInputElement;
    expect(portInput.type).toBe('number');
  });

  it('should render curl form correctly', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    render(
      <ParameterForm
        commandDef={PARAMETER_DEFINITIONS.curl}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    expect(screen.getByPlaceholderText(/https:\/\/api/i)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /method/i })).toBeInTheDocument();
  });

  it('should auto-focus first input field', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    render(
      <ParameterForm
        commandDef={PARAMETER_DEFINITIONS.ssh}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    const hostInput = screen.getByPlaceholderText(/example.com/i);
    expect(document.activeElement).toBe(hostInput);
  });
});
