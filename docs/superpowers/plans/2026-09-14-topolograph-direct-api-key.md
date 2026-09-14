# Topolograph Direct API-Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Topolograph's Vault-secret dependency with direct API-key entry and local SQLite persistence across every existing connector operation.

**Architecture:** Extend the existing `topolograph_config` singleton with an `api_key` column while preserving the legacy `secret_id` column and Vault data. `TopolographConfig` becomes the single object-oriented configuration boundary consumed by Tauri connection, upload, pyATS import, dedicated-agent, and Network Architect paths; the existing sidecar client and private runtime closure remain unchanged.

**Tech Stack:** Tauri/Rust, SQLite/refinery, React/TypeScript, Testing Library/Vitest, pytest, Cargo tests.

**Spec:** `docs/superpowers/specs/2026-09-14-topolograph-direct-api-key-design.md`

## Global Constraints

- Store the Topolograph API key unencrypted in TerminAI's local SQLite database, as explicitly selected by the operator.
- Display a persistent warning in Topolograph Settings that the key is stored unencrypted locally.
- Retain the existing `secret_id` database column and existing Vault secret unchanged for rollback, but never use Vault for Topolograph runtime eligibility or operations.
- Never expose the API key in logs, audit rows, error messages, screenshots, prompts, model-visible globals, or sidecar response bodies.
- Pass the API key only into the existing private Topolograph client/runtime closure.
- Keep private localhost/private-LAN deployment, URL validation, TLS warnings, upload limits, audit retention, allowlist, and mutation guards unchanged.
- Do not modify `src-tauri/src/mcp/**`.
- Add no dependencies and perform no unrelated refactoring.
- Preserve all pre-existing dirty Topolograph/STP work and paused Vault-control edits.

---

### Task 1: Persist and use the direct API key in Tauri operations

**Files:**

- Create: `src-tauri/migrations/V0091__topolograph_direct_api_key.sql`
- Modify: `src-tauri/src/commands/topolograph.rs`
- Modify: `src-tauri/src/commands/topolograph/pyats_import.rs`

**Interfaces:**

- Produces: `TopolographConfig { singleton_id, enabled, base_url, api_key, verify_tls, updated_at }` serialized with camelCase.
- Produces: `TopolographConfig::direct_params(&self) -> Result<Value, String>` that validates enabled/base URL/non-empty API key and returns the existing private sidecar binding shape.
- Preserves: legacy SQLite `secret_id` value on every config update.
- Consumes: existing `call_topolograph`, upload validation, response normalization, security warnings, and metadata-only audit functions.

- [ ] **Step 1: Write migration and persistence RED tests**

Add focused tests that apply `V0089`, `V0090`, and `V0091`, then assert:

```rust
assert_eq!(
    columns("topolograph_config"),
    vec![
        "singleton_id", "enabled", "base_url", "secret_id",
        "verify_tls", "updated_at", "api_key",
    ],
);
```

Seed `secret_id = 'legacy-vault-reference'`, save a config whose `api_key` is
`synthetic-direct-key`, and assert both values remain in their respective
columns. Assert `read_config` returns `api_key` and does not expose
`secret_id` through `TopolographConfig`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib commands::topolograph
```

Expected: compile/test failure because `api_key`, migration `V0091`, and the
preserving upsert do not exist.

- [ ] **Step 3: Add the migration and configuration object change**

Create:

```sql
ALTER TABLE topolograph_config
ADD COLUMN api_key TEXT NOT NULL DEFAULT '';
```

Replace `secret_id` in the serialized Rust configuration object with
`api_key`. Trim `api_key` during normalization. Require a non-empty key for an
enabled/complete connector and return the fixed safe message
`Topolograph API key is required` when absent.

Change config persistence to this non-destructive shape:

```sql
INSERT INTO topolograph_config
    (singleton_id, enabled, base_url, api_key, verify_tls, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6)
ON CONFLICT(singleton_id) DO UPDATE SET
    enabled = excluded.enabled,
    base_url = excluded.base_url,
    api_key = excluded.api_key,
    verify_tls = excluded.verify_tls,
    updated_at = excluded.updated_at
```

This intentionally leaves `secret_id` unchanged on existing rows.

- [ ] **Step 4: Write operation and non-disclosure RED tests**

Replace Vault-preflight tests with literal behavior tests proving:

```rust
let config = TopolographConfig {
    enabled: true,
    base_url: "https://topolograph.example".into(),
    api_key: "synthetic-direct-key".into(),
    verify_tls: false,
    ..TopolographConfig::default()
};
```

- direct params contain the existing `token`, `enabled`, `configured`, and
  `unlocked` sidecar fields;
- empty key fails before a sidecar call;
- connection tests use the form-supplied key;
- uploads and pyATS imports use the persisted key;
- response and audit serialization do not contain `synthetic-direct-key`;
- the operation and runtime-binding functions no longer accept a Vault lookup callback or `secret_id` argument, making Vault access impossible through their interfaces.

- [ ] **Step 5: Remove Topolograph Vault reads and pass the config key directly**

Delete the selected-secret lookup/preflight functions from
`topolograph.rs`. Implement `TopolographConfig::direct_params` and make both
`topolograph_dedicated_runtime_binding` and
`topolograph_architect_runtime_binding` consume only the persisted
configuration. Update connection, upload, and pyATS import helpers to consume
the direct configuration rather than `(config, Zeroizing<Vec<u8>>)`. Do not
change the sidecar RPC method names or result schemas.

- [ ] **Step 6: Verify Task 1 and commit**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib commands::topolograph
git diff --check
```

Commit only Task 1 files:

```bash
git add src-tauri/migrations/V0091__topolograph_direct_api_key.sql src-tauri/src/commands/topolograph.rs src-tauri/src/commands/topolograph/pyats_import.rs
git commit -m "feat(topolograph): use direct API key config"
```

---

### Task 2: Verify both bundled-agent entry points use the direct binding

**Files:**

- Modify: `src-tauri/src/commands/ai.rs`

**Interfaces:**

- Consumes: Task 1 `topolograph_dedicated_runtime_binding(state) -> Result<Value, String>` and `topolograph_architect_runtime_binding(state) -> Option<Value>`.
- Produces: dedicated Topolograph binding on both plain ReACT and ReACT-code entry points.
- Preserves: Architect optional omission so unrelated vendor work is not blocked by an unusable Topolograph connector.
- Preserves: existing `topolograph_runtime` parameter shape consumed by the sidecar.

- [ ] **Step 1: Write dedicated and Architect binding RED tests**

Add tests covering both `agent.react_loop` and `agent.react_code_loop` parameter
builders. Use `synthetic-direct-key` and assert:

```rust
assert_eq!(binding["token"], "synthetic-direct-key");
assert!(params.get("vault_secrets").is_none_or(Value::is_null));
```

Assert the plain ReACT and ReACT-code builders attach a supplied direct binding
only for `topolograph` and `network-architect`. At the command entry points,
assert the dedicated `topolograph` agent uses the strict binding in both flows,
while `network-architect` uses the optional binding. No Topolograph flow may
call `_retrieve_vault_secrets` unless an unrelated attached tool explicitly
declares its own non-Topolograph Vault entry.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib commands::ai::tests
cargo test --manifest-path src-tauri/Cargo.toml --lib commands::topolograph::tests
```

Expected: failure if the plain ReACT Topolograph path still uses the optional
Architect binding or any dedicated path depends on a Topolograph Vault entry.

- [ ] **Step 3: Simplify the two runtime bindings**

Use Task 1's strict dedicated binding for `topolograph` and optional binding for
`network-architect` in both agent commands. Keep
`attach_topolograph_runtime_binding` and the sidecar parameter name unchanged.
Do not call `_retrieve_vault_secrets` for the prepackaged Topolograph agent.

- [ ] **Step 4: Verify Task 2 and commit**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib commands::ai::tests
git diff --check
```

Commit only Task 2 files:

```bash
git add src-tauri/src/commands/ai.rs
git commit -m "fix(agent): bind Topolograph direct key runtime"
```

---

### Task 3: Replace the Vault selector with direct entry in Settings

**Files:**

- Modify: `src/lib/tauri.ts`
- Modify: `src/components/settings/TopolographSettingsTab.tsx`
- Modify: `src/components/settings/TopolographSettingsTab.test.tsx`
- Modify: `src/components/topology/TopologyIntegrationWorkspace.tsx`
- Modify: `src/components/topology/TopologyIntegrationWorkspace.test.tsx`

**Interfaces:**

- Consumes: Task 1 camelCase `TopolographConfig.apiKey`.
- Produces: an `API key` password field, persistent plaintext-storage warning, and API-key-based readiness state.
- Preserves: existing Tauri wrapper names and command payload envelopes.

- [ ] **Step 1: Write Settings RED tests**

Change the fixture to:

```typescript
const config: TopolographConfig = {
  singletonId: "topolograph",
  enabled: true,
  baseUrl: "https://topolograph.local:8080",
  apiKey: "synthetic-direct-key",
  verifyTls: true,
  updatedAt: 1,
};
```

Assert the `API key` control is `type="password"`, the persistent warning says
`Warning: this API key is stored unencrypted in TerminAI's local database.`, and no
`vault_list_envelopes` or `vault_list_secrets` invocation occurs. Assert Save
and Test Connection pass the current `apiKey`, and an enabled connector with an
empty key disables Test Connection and shows an actionable message.

- [ ] **Step 2: Run Settings tests and verify RED**

Run:

```bash
bunx vitest run src/components/settings/TopolographSettingsTab.test.tsx
```

Expected: failure because the Settings tab still renders the Vault selector.

- [ ] **Step 3: Implement the direct-entry Settings flow**

Update the TypeScript configuration type to `apiKey`. Remove all Vault imports,
metadata state, list calls, locked-secret messages, and selector markup from
`TopolographSettingsTab`. Render a controlled password input and the persistent
warning. Keep URL normalization, TLS warnings, activity refresh, report stages,
and busy states unchanged. Update the operator guide to instruct entering the
generated Topolograph token in this field and to repeat the unencrypted local
storage warning.

- [ ] **Step 4: Write workspace readiness RED tests**

Replace `secretId` fixtures with `apiKey`. Assert that empty `apiKey` maps to
the incomplete state and that no Vault-locked state or Vault-unlock instruction
is rendered. Keep upload, pyATS fetch, browser launch, warnings, and bounded
error tests unchanged.

- [ ] **Step 5: Implement API-key readiness in the workspace**

Change Topolograph workspace readiness to require `enabled`, `baseUrl`, and
`apiKey`. Replace the incomplete message with
`Topolograph setup is incomplete. Enter a base URL and API key in Settings.`
Remove only the obsolete Vault-lock mapping and preserve all other explicit
states and operation behavior.

- [ ] **Step 6: Verify Task 3 and commit**

Run:

```bash
bunx vitest run src/components/settings/TopolographSettingsTab.test.tsx src/components/topology/TopologyIntegrationWorkspace.test.tsx
bun run test
bun run build:relaxed
git diff --check
```

Commit only Task 3 files:

```bash
git add src/lib/tauri.ts src/components/settings/TopolographSettingsTab.tsx src/components/settings/TopolographSettingsTab.test.tsx src/components/topology/TopologyIntegrationWorkspace.tsx src/components/topology/TopologyIntegrationWorkspace.test.tsx
git commit -m "feat(settings): enter Topolograph API key directly"
```

---

### Task 4: Cross-boundary verification and native acceptance

**Files:** None; this is a verification-only gate. A failure returns to the task
that owns the affected file and repeats its test/review loop.

**Interfaces:**

- Consumes: Tasks 1-3 complete direct-key flow.
- Produces: verified native Settings, canary connection, upload/import, and bundled-agent behavior.

- [ ] **Step 1: Run repository verification gates**

Run:

```bash
sidecar/.venv/bin/pytest -q sidecar/tests/test_topolograph.py sidecar/tests/test_topolograph_pyats_import.py sidecar/tests/test_topolograph_task5.py
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings
bun run test
bun run build:relaxed
git diff --check
git diff --name-only HEAD -- src-tauri/src/mcp
```

Required results: all tests/builds pass, Clippy has no warnings, whitespace is clean, and the generic MCP diff command prints nothing.

- [ ] **Step 2: Refresh Graphify and review the resulting dependency path**

Run:

```bash
graphify update .
graphify query "topolograph config token runtime binding settings database"
```

Confirm the Settings, Tauri config, direct operations, and both agent entry
points share the same direct configuration source with no Topolograph-to-Vault
edge in changed code.

- [ ] **Step 3: Relaunch the native development app**

Terminate only the exact validated stale packaged app process, keep unrelated
processes untouched, and launch the branch with:

```bash
./run.sh
```

Confirm the native Topolograph Settings surface renders the direct password
field and storage warning and has no Vault selector.

- [ ] **Step 4: Complete operator-entered live acceptance**

The operator enters the real key directly; automation must never type, read, or
capture it. Then verify:

1. Save succeeds and persists across restart.
2. Test Connection returns live MCP identity, latency, required-tool inventory, and bounded-probe stages from the running canary.
3. A disposable LSDB/YAML upload or pyATS switch import succeeds.
4. The prepackaged Topolograph agent answers `List available Topolograph graphs` with a real graph result.
5. Logs, audit rows, UI screenshots, and model events contain no key or raw topology payload.
