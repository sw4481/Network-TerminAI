# Topolograph Direct API-Key Configuration

## Status

Approved in chat on 2026-09-14, pending written-spec review.

## Goal

Let the operator enter the Topolograph API key directly in TerminAI's
Topolograph Settings surface so connection tests, uploads, pyATS imports, and
agent operations work after application startup without unlocking a Vault
envelope.

## Security Decision

The operator explicitly selected the existing Meraki-style persistence model:
store the API key unencrypted in TerminAI's local SQLite database. The Settings
surface must display a persistent warning explaining this. This decision
overrides the original Topolograph contract that stored only a Vault secret ID
and decrypted the selected secret per operation.

The API key must still never appear in logs, audit rows, error messages,
screenshots produced by automated acceptance, model prompts, model-visible
globals, or sidecar response bodies. TerminAI passes it only into the existing
private Topolograph client/runtime closure.

## Persistence and Migration

- Add an `api_key TEXT NOT NULL DEFAULT ''` column to `topolograph_config` in a
  forward-only migration.
- Retain the existing `secret_id` database column and the existing Vault secret
  unchanged for rollback and data preservation, but stop using `secret_id` for
  Topolograph runtime eligibility or operations.
- Update the Topolograph configuration contract to use `apiKey`/`api_key`.
- An enabled connector is complete only when normalized `base_url` and a
  non-empty `api_key` are present.

## Settings Experience

- Replace the Vault-secret selector with a password input labelled `API key`.
- Load and save the value through the Topolograph configuration commands, using
  the same direct-entry interaction model as Meraki.
- Display a persistent warning that the key is stored unencrypted in the local
  application database.
- Keep enablement, base URL, and TLS-verification controls unchanged.
- Test Connection uses the current form values, so a key can be tested before
  or after saving.
- Empty keys are rejected when enabling, testing, uploading, importing, or
  invoking Topolograph through an agent.

## Runtime Data Flow

1. Settings sends the Topolograph config to the existing dedicated Tauri
   commands.
2. Tauri validates URL/TLS/key state and passes only base URL, TLS choice, and
   API key to the existing sidecar adapter.
3. The sidecar captures the key privately in `TopolographClient`; it is not
   copied into model prompts or sandbox globals.
4. Test Connection, native uploads, pyATS LSDB import, the bundled Topolograph
   agent, and the Network Architect specialist all use this same config source.
5. Audit persistence remains metadata-only.

The generic MCP subsystem remains untouched.

## Compatibility and Cleanup

- Existing Topolograph installations with only `secret_id` become incomplete
  until the operator enters and saves an API key in Settings.
- No Vault envelope, secret, keychain item, container, or volume is deleted or
  altered.
- Vault auto-unlock remains a separate subsystem. This change removes it from
  the Topolograph acceptance path rather than changing Vault cryptography or
  keyring behavior.

## Error Handling

- Missing API key: fixed, actionable connector-incomplete error.
- Upstream authentication failure: existing sanitized upstream error mapping;
  never include request headers or response bodies.
- Database or sidecar failure: existing sanitized error codes and metadata-only
  audit event.

## Verification

Implementation is test-first. Required coverage:

- migration and config save/load with the new column;
- enabled/incomplete validation and URL normalization;
- connection, upload, pyATS import, dedicated-agent, and Architect runtime
  bindings all use the configured key without Vault access;
- frontend direct-entry, warning, save, test, and disabled states;
- regression checks proving the key is absent from logs, errors, audits, model
  globals, and serialized sidecar output;
- focused Rust/Vitest/pytest suites, full relevant suites, build, Clippy, and
  `git diff --check`;
- native Settings save and Test Connection against the running canary;
- bundled Topolograph agent returns a real live graph result after restart.
