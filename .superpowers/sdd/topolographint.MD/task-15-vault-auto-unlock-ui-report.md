# Task 15: Vault auto-unlock UI report

## Implementation

- Removed the browser `prompt()` fallback from the locked-envelope auto-unlock checkbox.
- With no value in the existing passphrase field, the controlled checkbox remains off and an inline `role="alert"` instructs the operator to enter the passphrase above and try again.
- With a passphrase, the existing Vault API receives the selected envelope ID, `true`, and the controlled field value; envelope metadata is then refreshed as before.
- Disabling remains unchanged: `vault.setAutoUnlock(selectedEnvelope.id, false, null)` followed by metadata refresh.

## RED

Command:

```sh
bunx vitest run src/components/vault/VaultTab.test.tsx
```

Output:

```text
RUN  v4.1.5 /Users/shaunwhi/CCIE Terminal/.worktrees/topolograph-integration
Not implemented: Window's prompt() method
FAIL  src/components/vault/VaultTab.test.tsx > VaultTab auto-unlock > instructs the operator to enter the passphrase without enabling auto-unlock
TestingLibraryElementError: Unable to find an accessible element with the role "alert"
Test Files  1 failed (1)
Tests  1 failed | 1 passed (2)
```

The failure was expected: the pre-change checkbox invoked `prompt()` and rendered no accessible inline instruction.

## GREEN

Focused command:

```sh
bunx vitest run src/components/vault/VaultTab.test.tsx
```

Output:

```text
RUN  v4.1.5 /Users/shaunwhi/CCIE Terminal/.worktrees/topolograph-integration
Test Files  1 passed (1)
Tests  2 passed (2)
```

Relevant frontend suite command:

```sh
bunx vitest run
```

Output:

```text
Test Files  297 passed (297)
Tests  2228 passed (2228)
```

Whitespace command:

```sh
git diff --check
```

Output: exit 0 with no output.

## Files changed

- `src/components/vault/VaultTab.tsx`
- `src/components/vault/VaultTab.test.tsx`
- `Plans/Mistakes.MD` (Task 15 entry only staged; existing dirty entries remain unstaged)
- `.superpowers/sdd/topolographint.MD/task-15-vault-auto-unlock-ui-report.md`

## Self-review

- The new tests exercise the real Tauri command wrapper boundary and verify the visible accessibility behavior rather than a mocked UI element.
- The enabling test uses a synthetic passphrase and verifies one command invocation plus the refreshed checked state; no passphrase is logged by production code or this report.
- The patch is limited to the React Vault tab, its new focused test, and the required mistake/report artifacts. Rust Vault/keyring behavior and the disable branch were not changed.
- Graphify incremental refresh completed its code-only extraction; it reported 997 uncached code files and non-fatal existing parser/dependency warnings.

## Concerns

- Native rebuild/relaunch acceptance from the brief was not run in this focused handoff. It remains an operator follow-up: verify the inline instruction in the native Tauri window, enable with the real envelope passphrase, restart, and confirm auto-unlock.
- The broader Vitest run passed but emitted pre-existing environment warnings for jsdom navigation and a missing Monaco source map; neither caused a test failure.
