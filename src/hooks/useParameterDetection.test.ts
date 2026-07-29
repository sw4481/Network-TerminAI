import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useParameterDetection, PARAMETER_DEFINITIONS } from './useParameterDetection';

describe('useParameterDetection', () => {
  beforeEach(() => {
    vi.clearAllTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return null for empty input', () => {
    const { result } = renderHook(() => useParameterDetection(''));

    expect(result.current.commandDef).toBeNull();
    expect(result.current.shouldShow).toBe(false);
  });

  it('should return null for complete command', () => {
    const { result } = renderHook(() => useParameterDetection('ls -la'));

    expect(result.current.commandDef).toBeNull();
    expect(result.current.shouldShow).toBe(false);
  });

  it('should detect incomplete ssh command', () => {
    const { result } = renderHook(() => useParameterDetection('ssh '));

    expect(result.current.commandDef).toBeDefined();
    expect(result.current.commandDef?.command).toBe('ssh');
    expect(result.current.shouldShow).toBe(false); // Initially false
  });

  it('should show form after delay', async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => useParameterDetection('ssh '));

    expect(result.current.shouldShow).toBe(false);

    // Fast-forward 500ms
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.shouldShow).toBe(true);

    vi.useRealTimers();
  });

  it('should cancel delay on input change', async () => {
    vi.useFakeTimers();

    const { result, rerender } = renderHook(
      ({ input }) => useParameterDetection(input),
      { initialProps: { input: 'ssh ' } }
    );

    // Wait 250ms (half of delay)
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(result.current.shouldShow).toBe(false);

    // User types more before delay completes (still ends with space to trigger)
    rerender({ input: 'ssh user@ ' });

    // Complete the original delay
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    // Should still be false because timer was reset
    expect(result.current.shouldShow).toBe(false);

    // Now wait another 500ms for the new timer
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.shouldShow).toBe(true);

    vi.useRealTimers();
  });

  it('should detect incomplete scp command', () => {
    const { result } = renderHook(() => useParameterDetection('scp '));

    expect(result.current.commandDef).toBeDefined();
    expect(result.current.commandDef?.command).toBe('scp');
  });

  it('should detect incomplete find command', () => {
    const { result } = renderHook(() => useParameterDetection('find '));

    expect(result.current.commandDef).toBeDefined();
    expect(result.current.commandDef?.command).toBe('find');
  });

  it('should detect incomplete grep command', () => {
    const { result } = renderHook(() => useParameterDetection('grep '));

    expect(result.current.commandDef).toBeDefined();
    expect(result.current.commandDef?.command).toBe('grep');
  });

  it('should detect incomplete curl command', () => {
    const { result } = renderHook(() => useParameterDetection('curl '));

    expect(result.current.commandDef).toBeDefined();
    expect(result.current.commandDef?.command).toBe('curl');
  });

  it('should not trigger for commands with partial arguments', () => {
    const { result } = renderHook(() => useParameterDetection('ssh user@example.com'));

    // Should detect the command but not show form yet
    expect(result.current.commandDef).toBeDefined();
  });

  it('should have parameter definitions', () => {
    expect(PARAMETER_DEFINITIONS).toBeDefined();
    expect(PARAMETER_DEFINITIONS.ssh).toBeDefined();
    expect(PARAMETER_DEFINITIONS.scp).toBeDefined();
    expect(PARAMETER_DEFINITIONS.find).toBeDefined();
    expect(PARAMETER_DEFINITIONS.grep).toBeDefined();
    expect(PARAMETER_DEFINITIONS.curl).toBeDefined();
  });

  it('should have required parameters for ssh', () => {
    const sshDef = PARAMETER_DEFINITIONS.ssh;

    expect(sshDef.parameters).toBeDefined();
    expect(sshDef.parameters.length).toBeGreaterThan(0);

    const hostParam = sshDef.parameters.find(p => p.name === 'host');
    expect(hostParam).toBeDefined();
    expect(hostParam?.required).toBe(true);
  });

  it('should build command correctly from buildCommand', () => {
    const sshDef = PARAMETER_DEFINITIONS.ssh;

    const command = sshDef.buildCommand({
      host: 'example.com',
      user: 'admin',
      port: '22'
    });

    expect(command).toContain('ssh');
    expect(command).toContain('example.com');
    expect(command).toContain('admin');
  });

  it('should reset shouldShow when input becomes non-triggering', async () => {
    vi.useFakeTimers();

    const { result, rerender } = renderHook(
      ({ input }) => useParameterDetection(input),
      { initialProps: { input: 'ssh ' } }
    );

    // Trigger form
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.shouldShow).toBe(true);

    // Change to non-triggering input
    rerender({ input: 'ls -la' });

    expect(result.current.shouldShow).toBe(false);
    expect(result.current.commandDef).toBeNull();

    vi.useRealTimers();
  });
});
