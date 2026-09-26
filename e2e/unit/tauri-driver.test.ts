import { describe, expect, it } from 'bun:test';

import { resolveTauriBinaryPath } from '../tauri-driver';

describe('resolveTauriBinaryPath', () => {
  it('uses the current TerminAI executable name from the repository target', () => {
    expect(
      resolveTauriBinaryPath({
        cwd: '/workspace/terminai',
        platform: 'darwin',
        env: {},
      }),
    ).toBe('/workspace/terminai/src-tauri/target/debug/TerminAI');
  });

  it('honours the shared Cargo target directory', () => {
    expect(
      resolveTauriBinaryPath({
        cwd: '/workspace/terminai-worktree',
        platform: 'darwin',
        env: { CARGO_TARGET_DIR: '/workspace/terminai/src-tauri/target' },
      }),
    ).toBe('/workspace/terminai/src-tauri/target/debug/TerminAI');
  });

  it('prefers an explicit E2E executable on every platform', () => {
    expect(
      resolveTauriBinaryPath({
        cwd: '/workspace/terminai',
        platform: 'win32',
        env: {
          CARGO_TARGET_DIR: '/workspace/terminai/src-tauri/target',
          E2E_TAURI_BIN: '/fixtures/TerminAI-test.exe',
        },
      }),
    ).toBe('/fixtures/TerminAI-test.exe');
  });
});
