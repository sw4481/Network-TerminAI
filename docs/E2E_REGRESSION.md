# E2E Regression Checklist

Manual smoke tests that exist outside the (currently broken) Playwright
harness. Run these before tagging a release. Each section calls out the
specific feature/plan it covers.

## Deep-link sharing (Plan 01 / Phase 3, Task 3.1)

The `ccie-terminal://` URL scheme is registered via `tauri-plugin-deep-link`
and delivered to the frontend as a `deep-link:block-share` event. Two paths
must be exercised: a share that already lives in the local store (scroll-to)
and one that has to be re-imported from `block_shares.payload_json`.

### Setup

1. Build & install the app once so macOS LaunchServices picks up the new
   `CFBundleURLTypes` entry that `tauri-plugin-deep-link` writes during
   bundling:
   ```sh
   cd "$HOME/Network-TerminAI"
   bun run tauri build --debug
   open src-tauri/target/debug/bundle/macos/CCIE\ Terminal.app
   ```
   (A `tauri dev` build also registers the scheme on macOS.)
2. Start a terminal tab, run `echo hello`, and use the share popover (Task 3.3)
   or `block_share_create` directly to mint a share id. Copy the id.

### Path A — block exists locally, scroll to it

1. Keep the same app session running so the block + its `shareId` are still
   in `useBlocksStore`.
2. From a separate Terminal.app window run:
   ```sh
   open "ccie-terminal://block/<share_id>"
   ```
3. Expected:
   - The CCIE Terminal window comes to the foreground.
   - The matching block row scrolls into the viewport (`scrollIntoView`,
     centred).
   - **No** "Imported shared block ..." banner appears (we found it locally).
   - `tracing::info!` logs include `received deep-link URL` and
     `routing block share to frontend`.

### Path B — block missing locally, import from payload

1. Quit the app, relaunch it, and open a fresh terminal tab so the store
   no longer contains the block (the share row stays in
   `block_shares.payload_json`).
2. Run the same `open` command:
   ```sh
   open "ccie-terminal://block/<share_id>"
   ```
3. Expected:
   - Window foregrounds.
   - A small banner appears at the top centred reading
     `Imported shared block <first 8 chars of share id>…`.
   - The banner auto-dismisses after roughly 4 seconds (also has an `×`
     close button).
   - The imported block appears in the active tab's block list.

### Negative path — non-block URLs are ignored

Run:
```sh
open "ccie-terminal://other/anything"
open "ccie-terminal://block/"
```

Expected:
- Window foregrounds (the OS still hands the URL to the app).
- No banner, no scroll.
- Logs show `ignoring deep-link URL (not a block share)`.

### Why this is a manual checklist instead of an automated E2E test

`e2e/playwright.config.ts` currently fails to load because of an ESM/CJS
mismatch left over from Phase 1; fixing it is tracked separately. Until
that is resolved, the OS-level URL dispatch is verified manually here.
The pure URL parser (`commands::blocks::parse_share_url`) is covered by
`src-tauri/tests/deep_link_test.rs`, which runs in CI.
