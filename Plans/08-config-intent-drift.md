# 08 — Config Intent + Drift Detection

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the engineer declare the *intended* configuration for each device — either as a pinned golden `show running-config` or as a Jinja2 template + variables YAML — then, on a schedule or on-demand, render intent, pull live `show running-config` via Plan 07's fan-out executor, normalize both sides, diff them, and surface drift in a sidebar. A "Remediate" button renders the diff as a config patch and opens it in the existing Monaco editor for review before push.

**Architecture:**
- **Data layer.** Migration `V0035` adds `intent_templates`, `intent_assignments`, `drift_reports`, `drift_schedules`. `intent_templates.kind ∈ ('golden','jinja')`; `body` is the raw config or Jinja template; `vars_yaml` is per-template default variables; `selector_json` encodes device-id-and-tag selectors.
- **Rendering.** Pure-Rust via the `minijinja` crate (no sidecar in the hot path). Golden templates short-circuit rendering. Per-device overrides live in `intent_assignments` (future work — scaffolded but not required for this plan).
- **Normalization.** `src-tauri/src/drift/normalize.rs` — per-vendor rule engine stripping timestamps, counters, encrypted secret tokens, and volatile state so diffs are deterministic. Fixtures under `src-tauri/tests/fixtures/drift/` cover IOS-XE, NX-OS, Junos.
- **Diff.** `src-tauri/src/drift/diff.rs` — line-oriented with semantic grouping (interface, router-bgp, ACL, etc.). Output is a structured `DriftPatch` (added/removed/modified blocks + severity tag). Library choice deferred to Phase 3 — **confirm via `mcp__plugin_context7_context7__query-docs`** before selecting.
- **Execution.** On-demand runs call Plan 07's `fanout_execute` with a fixed `show running-config` command; results are normalized, diffed, and persisted to `drift_reports`.
- **Scheduling.** `src-tauri/src/drift/scheduler.rs` — `tokio-cron-scheduler` handles cron expressions; pause/resume driven by `drift_schedules.enabled`.
- **UI.** `src/components/drift/DriftSidebar.tsx` (new) shows a tree grouped by site/tag with red/yellow/green status dots. Remediate opens the rendered patch in `MonacoEditor` (existing component at `src/components/editor/MonacoEditor.tsx`) in read-only-until-approved mode.

**Tech Stack:** Rust 1.78+, `minijinja` (rendering), `tokio-cron-scheduler` (scheduling — confirm via context7), `rusqlite`, `serde`, Tauri 2, React 19, Zustand 5, Monaco (already wired), `@tauri-apps/api/core`.

**Prerequisites:**
- Plan 00 complete (sidecar + parsing + DB conventions).
- Plan 01 complete (block tags — intent selectors reuse the same tag vocabulary).
- Plan 07 complete (fan-out executor — `fanout_execute(group_id|selector, command) -> run_id`).

**Downstream consumers:** Plan 09 (AI Guardrails) may consume drift reports as blast-radius input; Plan 15 (Troubleshooter) may reference drift_reports.

**Migration number:** `V0035` (reserved in `/Plans/README.md`).

**Reuses:** Plan 07 fan-out executor (do **not** re-implement); Monaco editor at `src/components/editor/MonacoEditor.tsx`; existing `StatusFooter` for notifications; existing tag system from Plan 01.

---

## Phase 1 — Schema + intent CRUD (Monaco-backed editor)

### Task 1.1 — Migration V0035  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/migrations/V0035__intent_and_drift.sql`

- [ ] **Step 1: Write the migration**

```sql
CREATE TABLE IF NOT EXISTS intent_templates (
  id              TEXT PRIMARY KEY,                 -- uuidv4
  name            TEXT NOT NULL,
  vendor          TEXT NOT NULL,                    -- 'cisco' | 'juniper' | 'arista' | ...
  platform        TEXT NOT NULL,                    -- 'iosxe' | 'nxos' | 'junos' | 'eos'
  kind            TEXT NOT NULL CHECK (kind IN ('golden','jinja')),
  body            TEXT NOT NULL,                    -- golden config OR jinja template
  vars_yaml       TEXT NOT NULL DEFAULT '',         -- default vars (jinja only)
  selector_json   TEXT NOT NULL DEFAULT '{}',       -- {"device_ids":[...], "tags":[...]}
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_intent_templates_vendor_platform
  ON intent_templates(vendor, platform);

CREATE TABLE IF NOT EXISTS intent_assignments (
  template_id   TEXT NOT NULL REFERENCES intent_templates(id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL,
  device_kind   TEXT NOT NULL,                      -- 'ssh' | 'netconf' | 'api'
  override_vars_yaml TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (template_id, device_id, device_kind)
);
CREATE INDEX IF NOT EXISTS idx_intent_assignments_device
  ON intent_assignments(device_id, device_kind);

CREATE TABLE IF NOT EXISTS drift_reports (
  id            TEXT PRIMARY KEY,                   -- uuidv4
  template_id   TEXT NOT NULL REFERENCES intent_templates(id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL,
  device_kind   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('in_sync','drift','error')),
  severity      TEXT NOT NULL DEFAULT 'none' CHECK (severity IN ('none','additive','destructive','error')),
  diff_patch    TEXT NOT NULL DEFAULT '',           -- structured JSON of DriftPatch
  error_msg     TEXT,
  captured_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_drift_reports_template_time
  ON drift_reports(template_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_drift_reports_device_time
  ON drift_reports(device_id, device_kind, captured_at DESC);

CREATE TABLE IF NOT EXISTS drift_schedules (
  id            TEXT PRIMARY KEY,
  template_id   TEXT NOT NULL REFERENCES intent_templates(id) ON DELETE CASCADE,
  cron_expr     TEXT NOT NULL,                      -- e.g. '0 0 * * * *' (hourly)
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_run_at   INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_drift_schedules_enabled
  ON drift_schedules(enabled) WHERE enabled = 1;
```

- [ ] **Step 2: Verify migration applies**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib db::tests::migrations_apply
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/migrations/V0035__intent_and_drift.sql
git commit -m "feat(db): V0035 intent templates + drift reports + schedules"
```

### Task 1.2 — Rust intent CRUD commands  `SEQUENTIAL` (depends on 1.1)

**Files:**
- Create: `src-tauri/src/drift/mod.rs`
- Create: `src-tauri/src/drift/intent.rs`
- Create: `src-tauri/src/commands/drift.rs`
- Modify: `src-tauri/src/commands/mod.rs` — add `pub mod drift;`
- Modify: `src-tauri/src/lib.rs` — register commands, add `mod drift;`
- Create: `src-tauri/tests/drift_intent_crud_test.rs`

- [ ] **Step 1: Write the failing test**

```rust
use ccie_terminal_lib::drift::intent::{IntentRepo, IntentTemplate, IntentKind, IntentSelector};

#[tokio::test]
async fn intent_crud_roundtrip() {
    let db = crate::test_helpers::test_db().await;
    let repo = IntentRepo::new(db.clone());
    let id = repo.create(IntentTemplate {
        id: String::new(), // filled by repo
        name: "core-switch-golden".into(),
        vendor: "cisco".into(),
        platform: "iosxe".into(),
        kind: IntentKind::Golden,
        body: "hostname core-01\n!\n".into(),
        vars_yaml: String::new(),
        selector: IntentSelector { device_ids: vec![], tags: vec!["core".into()] },
    }).await.unwrap();
    let got = repo.get(&id).await.unwrap().unwrap();
    assert_eq!(got.name, "core-switch-golden");
    assert_eq!(got.selector.tags, vec!["core"]);
    let list = repo.list_by_vendor_platform("cisco", "iosxe").await.unwrap();
    assert_eq!(list.len(), 1);
    repo.update_body(&id, "hostname core-01\nno service pad\n!\n").await.unwrap();
    repo.delete(&id).await.unwrap();
    assert!(repo.get(&id).await.unwrap().is_none());
}
```

- [ ] **Step 2: Implement `drift/intent.rs`**

Types:
```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum IntentKind { Golden, Jinja }

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct IntentSelector {
    #[serde(default)] pub device_ids: Vec<String>,
    #[serde(default)] pub tags: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IntentTemplate {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub platform: String,
    pub kind: IntentKind,
    pub body: String,
    pub vars_yaml: String,
    pub selector: IntentSelector,
}
```

`IntentRepo` methods: `create`, `get`, `list_by_vendor_platform`, `list_all`, `update_body`, `update_vars`, `update_selector`, `delete`. Use `uuid::Uuid::new_v4()` for IDs. Serialize `selector` via `serde_json::to_string`. Bump `updated_at` on every mutation.

- [ ] **Step 3: Implement Tauri commands in `commands/drift.rs`**

```rust
#[tauri::command]
pub async fn intent_create(tpl: IntentTemplate, db: State<'_, Db>) -> Result<String, String>;

#[tauri::command]
pub async fn intent_get(id: String, db: State<'_, Db>) -> Result<Option<IntentTemplate>, String>;

#[tauri::command]
pub async fn intent_list(vendor: Option<String>, platform: Option<String>, db: State<'_, Db>) -> Result<Vec<IntentTemplate>, String>;

#[tauri::command]
pub async fn intent_update_body(id: String, body: String, db: State<'_, Db>) -> Result<(), String>;

#[tauri::command]
pub async fn intent_update_vars(id: String, vars_yaml: String, db: State<'_, Db>) -> Result<(), String>;

#[tauri::command]
pub async fn intent_update_selector(id: String, selector: IntentSelector, db: State<'_, Db>) -> Result<(), String>;

#[tauri::command]
pub async fn intent_delete(id: String, db: State<'_, Db>) -> Result<(), String>;
```

- [ ] **Step 4: Register commands in `lib.rs`**

Follow the existing `.invoke_handler(tauri::generate_handler![...])` pattern already in repo — **do not invent a new handler style**.

- [ ] **Step 5: Run — expect PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test drift_intent_crud_test
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/
git commit -m "feat(drift): intent_templates CRUD + Tauri commands"
```

### Task 1.3 — Frontend intent store + API wrapper  `PARALLEL with 1.4`

**Files:**
- Create: `src/lib/drift.ts`
- Create: `src/state/intentStore.ts`
- Create: `src/lib/drift.test.ts`

- [ ] **Step 1: Write failing TS test**

```ts
import { describe, it, expect, vi } from "vitest";
import { intentCreate, intentList } from "./drift";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "intent_create") return "uuid-1";
    if (cmd === "intent_list") return [];
    throw new Error(`unexpected ${cmd}`);
  }),
}));

describe("drift intent API", () => {
  it("creates and lists templates", async () => {
    const id = await intentCreate({
      id: "", name: "t", vendor: "cisco", platform: "iosxe",
      kind: "golden", body: "", vars_yaml: "",
      selector: { device_ids: [], tags: [] },
    });
    expect(id).toBe("uuid-1");
    const rows = await intentList();
    expect(Array.isArray(rows)).toBe(true);
  });
});
```

- [ ] **Step 2: Implement `src/lib/drift.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";

export type IntentKind = "golden" | "jinja";
export type IntentSelector = { device_ids: string[]; tags: string[] };
export type IntentTemplate = {
  id: string;
  name: string;
  vendor: string;
  platform: string;
  kind: IntentKind;
  body: string;
  vars_yaml: string;
  selector: IntentSelector;
};

export const intentCreate = (tpl: IntentTemplate) => invoke<string>("intent_create", { tpl });
export const intentGet = (id: string) => invoke<IntentTemplate | null>("intent_get", { id });
export const intentList = (vendor?: string, platform?: string) =>
  invoke<IntentTemplate[]>("intent_list", { vendor, platform });
export const intentUpdateBody = (id: string, body: string) =>
  invoke<void>("intent_update_body", { id, body });
export const intentUpdateVars = (id: string, varsYaml: string) =>
  invoke<void>("intent_update_vars", { id, vars_yaml: varsYaml });
export const intentUpdateSelector = (id: string, selector: IntentSelector) =>
  invoke<void>("intent_update_selector", { id, selector });
export const intentDelete = (id: string) => invoke<void>("intent_delete", { id });
```

- [ ] **Step 3: Implement `intentStore.ts` (Zustand)**

State: `templates: IntentTemplate[]`, `selectedId: string | null`, plus `refresh()`, `select(id)`, `create(tpl)`, `updateBody(id, body)`, `remove(id)`. Mirror existing zustand patterns from `src/state/blocksStore.ts`.

- [ ] **Step 4: Run — expect PASS** (`bun run test src/lib/drift.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/
git commit -m "feat(drift): frontend intent api wrapper + zustand store"
```

### Task 1.4 — Intent editor UI (Monaco-backed)  `PARALLEL with 1.3`

**Files:**
- Create: `src/components/drift/IntentLibrary.tsx` + `.css`
- Create: `src/components/drift/IntentEditorPanel.tsx` + `.css`
- Create: `src/components/drift/IntentEditorPanel.test.tsx`

- [ ] **Step 1: Dispatch `frontend-design` skill (pre-impl)**

Brief: "Design an intent library: left rail listing templates grouped by vendor/platform with a `+` button; center pane is the Monaco editor showing `body` (language: `plaintext` for golden, `jinja2` via a simple custom-language registration for jinja); right rail shows name, vendor, platform, kind radio, selector editor (device-id list + tag chips reusing Plan 01's `TagChipStrip`), and a `vars.yaml` sub-editor (collapsible, visible only when kind=jinja). Match the Warp-inspired palette used in `src/App.css`. Deliver: ASCII wireframe + Tailwind/CSS class names. Save output to `docs/design/intent-editor.md`."

- [ ] **Step 2: Write failing component test** — rendering with a seeded template shows name in header; switching kind from golden → jinja reveals the `vars.yaml` sub-editor; saving calls `intentUpdateBody`.

- [ ] **Step 3: Implement `IntentLibrary` + `IntentEditorPanel`**

Reuse `MonacoEditor` from `src/components/editor/MonacoEditor.tsx`:
```tsx
<MonacoEditor
  value={template.body}
  language={template.kind === "jinja" ? "jinja2" : "plaintext"}
  onChange={setBody}
  settings={DEFAULT_EDITOR_SETTINGS}
  onSave={handleSave}   // ⌘S
  enableLsp={false}
  tabId={`intent-${template.id}`}
/>
```

Register a minimal Monaco `jinja2` language (tokens for `{{ }}`, `{% %}`, `{# #}`) in `src/components/drift/jinjaLanguage.ts`, loaded lazily when an intent panel with `kind="jinja"` mounts.

- [ ] **Step 4: Run — expect PASS** (`bun run test src/components/drift/`).

- [ ] **Step 5: Commit**

```bash
git add src/components/drift/ docs/design/intent-editor.md
git commit -m "feat(drift): intent library + Monaco-backed editor panel"
```

### Task 1.5 — Phase 1 regression  `SEQUENTIAL`

- [ ] **Step 1:** `bun run test` — all green.
- [ ] **Step 2:** `cargo test --manifest-path src-tauri/Cargo.toml` — all green.
- [ ] **Step 3:** `bunx playwright test --grep @smoke` — all green.
- [ ] **Step 4: Code review subagent** — dispatch `feature-dev:code-reviewer` over the phase diff with prompt: "Review Phase 1 of Plan 08 (`/Plans/08-config-intent-drift.md`). Focus: schema correctness (V0035), intent CRUD transaction safety, frontend type parity with Rust structs. Report `must-fix` vs. `nits`."
- [ ] **Step 5: Post-impl `frontend-design` review** of the intent editor with screenshots.
- [ ] **Step 6: Update plan file** — check all Phase 1 boxes + append:

```markdown
## Phase 1 — COMPLETED YYYY-MM-DD
Migration V0035 applied; intent CRUD commands (`intent_create`, `intent_list`, `intent_update_body`, ...) landed; Monaco-backed intent editor live with jinja language definition.
```

- [ ] **Step 7: Commit plan update.**

---

## Phase 2 — Config normalizer + MiniJinja renderer (pure Rust)

### Task 2.1 — Confirm `minijinja` API  `SEQUENTIAL`

- [ ] **Step 1: Query context7**

```text
mcp__plugin_context7_context7__resolve-library-id("minijinja")
mcp__plugin_context7_context7__query-docs(<resolved-id>, query="render template from string with context from serde_yaml value")
```

Paste the authoritative `Environment::new()` → `add_template_owned` → `render` signature into this plan before writing code. Do **not** guess the API.

- [ ] **Step 2: Add dependency**

In `src-tauri/Cargo.toml`:
```toml
minijinja = "2"
serde_yaml = "0.9"
```
Pin to whatever major version context7 confirmed.

- [ ] **Step 3: Commit** `chore(drift): add minijinja + serde_yaml deps`

### Task 2.2 — Renderer  `SEQUENTIAL` (depends on 2.1)

**Files:**
- Create: `src-tauri/src/drift/render.rs`
- Create: `src-tauri/tests/drift_render_test.rs`

- [ ] **Step 1: Write the failing test**

```rust
use ccie_terminal_lib::drift::render::render_intent;
use ccie_terminal_lib::drift::intent::{IntentTemplate, IntentKind, IntentSelector};

#[test]
fn golden_returns_body_verbatim() {
    let tpl = IntentTemplate {
        id: "t1".into(), name: "g".into(),
        vendor: "cisco".into(), platform: "iosxe".into(),
        kind: IntentKind::Golden,
        body: "hostname core-01\n!\n".into(),
        vars_yaml: String::new(),
        selector: IntentSelector::default(),
    };
    let rendered = render_intent(&tpl, None).unwrap();
    assert_eq!(rendered, "hostname core-01\n!\n");
}

#[test]
fn jinja_renders_with_vars() {
    let tpl = IntentTemplate {
        id: "t2".into(), name: "j".into(),
        vendor: "cisco".into(), platform: "iosxe".into(),
        kind: IntentKind::Jinja,
        body: "hostname {{ hostname }}\ninterface Loopback0\n ip address {{ loopback_ip }} 255.255.255.255\n".into(),
        vars_yaml: "hostname: core-01\nloopback_ip: 10.0.0.1\n".into(),
        selector: IntentSelector::default(),
    };
    let rendered = render_intent(&tpl, None).unwrap();
    assert!(rendered.contains("hostname core-01"));
    assert!(rendered.contains("ip address 10.0.0.1"));
}

#[test]
fn jinja_override_vars_win() {
    let tpl = IntentTemplate {
        id: "t3".into(), name: "j".into(),
        vendor: "cisco".into(), platform: "iosxe".into(),
        kind: IntentKind::Jinja,
        body: "hostname {{ hostname }}\n".into(),
        vars_yaml: "hostname: default\n".into(),
        selector: IntentSelector::default(),
    };
    let rendered = render_intent(&tpl, Some("hostname: override\n")).unwrap();
    assert!(rendered.contains("hostname override"));
}
```

- [ ] **Step 2: Implement `render.rs`**

```rust
use crate::drift::intent::{IntentKind, IntentTemplate};
use anyhow::{Context, Result};
use minijinja::{Environment, context};
use serde_yaml::Value as YamlValue;

pub fn render_intent(tpl: &IntentTemplate, override_vars_yaml: Option<&str>) -> Result<String> {
    if matches!(tpl.kind, IntentKind::Golden) {
        return Ok(tpl.body.clone());
    }
    let defaults: YamlValue = if tpl.vars_yaml.is_empty() {
        YamlValue::Null
    } else {
        serde_yaml::from_str(&tpl.vars_yaml).context("parsing default vars_yaml")?
    };
    let overrides: YamlValue = match override_vars_yaml {
        None | Some("") => YamlValue::Null,
        Some(s) => serde_yaml::from_str(s).context("parsing override vars_yaml")?,
    };
    let merged = merge_yaml(defaults, overrides);
    let json = serde_json::to_value(&merged).context("yaml->json for minijinja context")?;
    let mut env = Environment::new();
    env.add_template_owned("intent", tpl.body.clone()).context("adding template")?;
    let tmpl = env.get_template("intent")?;
    Ok(tmpl.render(context! { ..json_as_context(&json) })?)
}
```

Helpers: `merge_yaml(defaults, overrides)` — recursive mapping merge, override wins on conflict; `json_as_context(&json) -> impl serde::Serialize` — pass-through wrapper. If the exact `context!` macro usage differs from what context7 returns, use whatever the docs confirm (e.g. `tmpl.render(&json)?`). **No guessing** — match the verified API.

- [ ] **Step 3: Run — expect PASS** (`cargo test --test drift_render_test`).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/
git commit -m "feat(drift): minijinja renderer with yaml defaults + overrides"
```

### Task 2.3 — Config normalizer  `PARALLEL with 2.2 tests only after render lands`

**Files:**
- Create: `src-tauri/src/drift/normalize.rs`
- Create: `src-tauri/tests/fixtures/drift/iosxe_running.txt`
- Create: `src-tauri/tests/fixtures/drift/iosxe_running_normalized.txt`
- Create: `src-tauri/tests/fixtures/drift/nxos_running.txt`
- Create: `src-tauri/tests/fixtures/drift/nxos_running_normalized.txt`
- Create: `src-tauri/tests/fixtures/drift/junos_running.txt`
- Create: `src-tauri/tests/fixtures/drift/junos_running_normalized.txt`
- Create: `src-tauri/tests/drift_normalize_test.rs`

- [ ] **Step 1: Capture real fixtures**

Paste real (or sanitized) `show running-config` output per vendor. Each fixture should include at least one of: timestamp line (`Building configuration...`, `Last configuration change`), encrypted secrets (`enable secret 5 $1$...`, `password 7 ...`), counter/uptime banner, NTP servers, interface, BGP config. Commit the `*_running.txt` first; generate `*_normalized.txt` by running the normalizer output back into the fixture in step 4.

- [ ] **Step 2: Write failing test**

```rust
use ccie_terminal_lib::drift::normalize::{normalize, Vendor};
use std::fs;

#[test]
fn normalize_iosxe_matches_fixture() {
    let raw = fs::read_to_string("tests/fixtures/drift/iosxe_running.txt").unwrap();
    let expected = fs::read_to_string("tests/fixtures/drift/iosxe_running_normalized.txt").unwrap();
    let got = normalize(Vendor::CiscoIosXe, &raw);
    assert_eq!(got.trim_end(), expected.trim_end(), "IOS-XE normalize mismatch");
}

// Repeat for CiscoNxos, JuniperJunos.
```

- [ ] **Step 3: Implement normalizer**

```rust
#[derive(Copy, Clone, Debug)]
pub enum Vendor { CiscoIosXe, CiscoNxos, JuniperJunos, AristaEos }

pub fn normalize(vendor: Vendor, raw: &str) -> String {
    let rules: &[&dyn Fn(&str) -> Option<String>] = match vendor {
        Vendor::CiscoIosXe | Vendor::CiscoNxos | Vendor::AristaEos => IOS_LIKE_RULES,
        Vendor::JuniperJunos => JUNOS_RULES,
    };
    raw.lines()
        .filter_map(|line| apply_rules(line, rules))
        .collect::<Vec<_>>()
        .join("\n")
}
```

Rules to implement (each returns `Some(transformed)` to keep or `None` to drop):

IOS-like:
- Drop lines matching `^! Last configuration change`, `^! NVRAM config last updated`, `^Building configuration`, `^Current configuration : \d+ bytes`.
- Drop lines matching `^\s*!Time:`.
- Replace `(enable secret 5 |password 7 |key 7 |md5 7 )\S+` → `\1<REDACTED>`.
- Replace `(username \S+ secret 5 )\S+` → `\1<REDACTED>`.
- Trim trailing whitespace.
- Collapse runs of blank lines into at most one.

Junos:
- Drop `## Last commit: ...`.
- Replace `encrypted-password "\S+"` → `encrypted-password "<REDACTED>"`.
- Replace `ssh-rsa "\S+"` → `ssh-rsa "<REDACTED>"`.
- Drop `inactive: ` prefix — treat as-is to avoid false positives? **Decision: keep `inactive:` since it's intent-bearing.**
- Trim trailing whitespace.

Use `regex::Regex` with `lazy_static!` or `once_cell::sync::Lazy`. Add `regex = "1"` and `once_cell = "1"` to `src-tauri/Cargo.toml` if not already present.

- [ ] **Step 4: Generate the expected fixtures once**

Write a one-shot Rust binary `src-tauri/src/bin/gen_normalize_fixtures.rs` that reads each `*_running.txt`, writes `*_normalized.txt`. Run it, inspect outputs manually, commit. Delete the binary after (it lives only for fixture generation).

Alternative: eyeball-generate each expected file by hand and commit directly — acceptable since fixtures are small.

- [ ] **Step 5: Run — expect PASS.**

- [ ] **Step 6: Commit**

```bash
git add src-tauri/
git commit -m "feat(drift): per-vendor config normalizer with fixtures"
```

### Task 2.4 — Expose render + normalize as Tauri commands  `SEQUENTIAL` (depends on 2.2, 2.3)

**Files:**
- Modify: `src-tauri/src/commands/drift.rs`

Add:
```rust
#[tauri::command]
pub async fn intent_render(id: String, override_vars_yaml: Option<String>, db: State<'_, Db>) -> Result<String, String>;

#[tauri::command]
pub async fn config_normalize(vendor: String, platform: String, raw: String) -> Result<String, String>;
```

- [ ] **Step 1: Write failing Tauri command test.**
- [ ] **Step 2: Implement — delegate to `render_intent` and `normalize`.**
- [ ] **Step 3: Frontend wrapper** in `src/lib/drift.ts`:
```ts
export const intentRender = (id: string, override_vars_yaml?: string) =>
  invoke<string>("intent_render", { id, override_vars_yaml });
export const configNormalize = (vendor: string, platform: string, raw: string) =>
  invoke<string>("config_normalize", { vendor, platform, raw });
```
- [ ] **Step 4: Commit** `feat(drift): expose render + normalize as Tauri commands`

### Task 2.5 — Phase 2 regression  `SEQUENTIAL`

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml drift` — all green.
- [ ] `bun run test` — all green.
- [ ] Dispatch `feature-dev:code-reviewer` with prompt: "Review Phase 2 of Plan 08. Focus: correctness of minijinja rendering, soundness of per-vendor normalizer rules (any false-positive redactions? missing volatile fields?), fixture coverage across IOS-XE/NX-OS/Junos."
- [ ] Update plan file: check Phase 2 boxes + append completion block.
- [ ] Commit plan.

---

## Phase 3 — Diff engine (structured patch)

### Task 3.1 — Select a diff strategy  `SEQUENTIAL`

- [ ] **Step 1: Survey**

Candidates:
- `similar` crate (Rust) — text/line-oriented diff with grouping.
- `dissimilar` crate — myers diff, minimal.
- Hand-rolled line diff + semantic grouper.

Query context7:
```
mcp__plugin_context7_context7__resolve-library-id("similar")
mcp__plugin_context7_context7__query-docs(<id>, "TextDiff grouped_ops for line diff with unified hunk output")
```

Paste the chosen API surface here before coding. Default pick if `similar` is confirmed healthy: **`similar = "2"`** with `TextDiff::from_lines` + `grouped_ops(n)` for hunk grouping. No guessing — require a verified doc excerpt.

- [ ] **Step 2: Add dep**

```toml
similar = "2"
```

- [ ] **Step 3: Commit** `chore(drift): add similar crate for line diff`

### Task 3.2 — `DriftPatch` model + diff engine  `SEQUENTIAL` (depends on 3.1)

**Files:**
- Create: `src-tauri/src/drift/diff.rs`
- Create: `src-tauri/tests/drift_diff_test.rs`

- [ ] **Step 1: Types**

```rust
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind { Added, Removed, Modified }

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Severity { None, Additive, Destructive, Error }

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DriftBlock {
    pub group: String,           // "interface GigabitEthernet1/0/1", "router bgp 65000", "ip access-list ACL_A", "global"
    pub kind: ChangeKind,
    pub intent_lines: Vec<String>,
    pub running_lines: Vec<String>,
    pub severity: Severity,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DriftPatch {
    pub blocks: Vec<DriftBlock>,
    pub overall_severity: Severity,  // max of block severities
    pub summary: DriftSummary,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DriftSummary {
    pub added: usize,
    pub removed: usize,
    pub modified: usize,
}
```

- [ ] **Step 2: Semantic grouper**

`group_lines(vendor, config) -> Vec<(group_name, Vec<String>)>` splits the config into blocks:
- IOS-like: each top-level line + its indented children is a group. Special keys: lines starting with `interface `, `router bgp `, `router ospf `, `ip access-list `, `ipv6 access-list `, `route-map `, `crypto `, `vrf definition `. Anything else at top level goes under `global`.
- Junos: each curly-brace stanza is a group keyed by path (`protocols bgp group INTERNAL`).

- [ ] **Step 3: Diff implementation**

```rust
pub fn diff_configs(vendor: Vendor, intent: &str, running: &str) -> DriftPatch {
    let intent_groups = group_lines(vendor, intent);
    let running_groups = group_lines(vendor, running);
    // Build map keyed by group name.
    // For each group present in intent but not running -> Removed (destructive if critical).
    // For each group present in running but not intent -> Added (additive).
    // For each shared group, run `similar::TextDiff::from_lines` over their bodies;
    // if any non-equal op, mark Modified and classify severity.
    ...
}
```

Severity rules:
- `Destructive` when intent block is `router bgp *`, `ip access-list *`, `crypto *`, or `interface *` with `ip address` missing on running side.
- `Additive` when running has extras that intent does not (e.g. debug commands, temp ACL entries).
- `None` when groups match byte-for-byte.

- [ ] **Step 4: Tests**

```rust
#[test]
fn detects_missing_bgp_neighbor_as_destructive() { /* intent has `neighbor 10.0.0.1`, running lacks it */ }

#[test]
fn extra_debug_is_additive() { /* running has `debug ip ospf`, intent doesn't */ }

#[test]
fn bytewise_match_is_in_sync() { /* identical configs -> blocks empty, overall None */ }

#[test]
fn missing_acl_entry_is_destructive() {}
```

- [ ] **Step 5: Run — expect PASS.**

- [ ] **Step 6: Commit** `feat(drift): structured diff engine with semantic grouping + severity`

### Task 3.3 — `diff_intent_vs_running` Tauri command  `SEQUENTIAL` (depends on 3.2)

**Files:**
- Modify: `src-tauri/src/commands/drift.rs`
- Modify: `src/lib/drift.ts`

```rust
#[tauri::command]
pub async fn drift_compute(
    template_id: String,
    device_id: String,
    device_kind: String,
    running_raw: String,
    db: State<'_, Db>,
) -> Result<DriftPatch, String>;
```

Flow: load template → render → normalize both sides (vendor from template) → `diff_configs` → return patch. Does **not** persist yet — Phase 4 handles persistence.

- [ ] **Step 1: Test + implement + wire TS wrapper.**
- [ ] **Step 2: Commit.**

### Task 3.4 — Phase 3 regression  `SEQUENTIAL`

- [ ] Full test suite.
- [ ] Code review subagent.
- [ ] Update plan + completion block. Commit.

---

## Phase 4 — On-demand drift run (reuses Plan 07 fan-out)

### Task 4.1 — Integrate with Plan 07 fan-out  `SEQUENTIAL`

**Prereq:** Plan 07 must expose at minimum:
- `fanout_execute(selector: Selector, command: String) -> FanoutRunId`
- `fanout_run_poll(run_id) -> FanoutRunStatus { per_device: Vec<{device_id, device_kind, status, stdout, error}> }`

If Plan 07's final API differs, update **this plan** to match before coding — do not silently adapt. Re-check the contract in `/Plans/07-multi-device-fanout.md` before starting Phase 4.

**Files:**
- Create: `src-tauri/src/drift/runner.rs`
- Create: `src-tauri/tests/drift_runner_test.rs`
- Modify: `src-tauri/src/commands/drift.rs`

- [ ] **Step 1: `DriftRunner`**

```rust
pub struct DriftRunner<'a> {
    db: &'a Db,
    fanout: &'a crate::fanout::FanoutExecutor,  // from Plan 07
}

impl<'a> DriftRunner<'a> {
    pub async fn run_on_demand(&self, template_id: &str) -> Result<Vec<DriftReport>>;
}
```

`run_on_demand`:
1. Load template + selector.
2. Call `fanout.execute(selector, "show running-config")`.
3. Poll until complete (respect Plan 07's timeout semantics).
4. For each device result:
   - On error: insert `drift_reports` row with `status='error'`, `severity='error'`, `error_msg`.
   - On success: render intent, normalize both, diff, insert `drift_reports` row with computed status + `diff_patch` (JSON of `DriftPatch`).
5. Return the persisted rows.

- [ ] **Step 2: Persistence**

Add `DriftReportRepo` with `insert(report)`, `list_by_template(template_id, limit)`, `list_recent_by_device(device_id, device_kind, limit)`, `get(id)`.

- [ ] **Step 3: Tauri command**

```rust
#[tauri::command]
pub async fn drift_run_on_demand(
    template_id: String,
    db: State<'_, Db>,
    fanout: State<'_, FanoutExecutor>,
) -> Result<Vec<DriftReport>, String>;
```

- [ ] **Step 4: Integration test with a stubbed fanout**

```rust
// Build an in-memory mock FanoutExecutor returning canned stdout per device.
// Seed 2 devices (one in-sync, one drifted). Run on-demand. Assert:
//   - Exactly 2 drift_reports rows persisted.
//   - in-sync row has status='in_sync' severity='none'.
//   - drifted row has status='drift' severity matching destructiveness of its block.
```

- [ ] **Step 5: Frontend wrapper**

```ts
export const driftRunOnDemand = (template_id: string) =>
  invoke<DriftReport[]>("drift_run_on_demand", { template_id });
```

- [ ] **Step 6: Commit** `feat(drift): on-demand drift runner via plan-07 fanout`

### Task 4.2 — List + fetch drift reports  `PARALLEL with 4.1 finalization`

**Files:**
- Modify: `src-tauri/src/commands/drift.rs`
- Modify: `src/lib/drift.ts`

```rust
#[tauri::command]
pub async fn drift_reports_list(template_id: String, limit: Option<i64>, db: State<'_, Db>) -> Result<Vec<DriftReport>, String>;

#[tauri::command]
pub async fn drift_report_get(id: String, db: State<'_, Db>) -> Result<Option<DriftReport>, String>;

#[tauri::command]
pub async fn drift_reports_by_device(device_id: String, device_kind: String, limit: Option<i64>, db: State<'_, Db>) -> Result<Vec<DriftReport>, String>;
```

- [ ] **Step 1: Test + implement + TS wrapper.**
- [ ] **Step 2: Commit.**

### Task 4.3 — Phase 4 regression  `SEQUENTIAL`

- [ ] Full suite. Code review. Update plan. Commit.

---

## Phase 5 — Scheduler (tokio cron)

### Task 5.1 — Confirm `tokio-cron-scheduler` API  `SEQUENTIAL`

- [ ] **Step 1: Query context7**

```
mcp__plugin_context7_context7__resolve-library-id("tokio-cron-scheduler")
mcp__plugin_context7_context7__query-docs(<id>, "create scheduler, add cron job, pause, remove, handle panics")
```

Paste the verified `JobScheduler::new()` / `Job::new_async(...)` / `scheduler.add(job).await` / `scheduler.remove(&uuid).await` signatures here before coding.

- [ ] **Step 2: Add dep**

```toml
tokio-cron-scheduler = "0.11"   # adjust to what context7 confirms
```

- [ ] **Step 3: Commit.**

### Task 5.2 — Scheduler implementation  `SEQUENTIAL` (depends on 5.1, Phase 4)

**Files:**
- Create: `src-tauri/src/drift/scheduler.rs`
- Create: `src-tauri/tests/drift_scheduler_test.rs`
- Modify: `src-tauri/src/lib.rs` — start scheduler at app setup

- [ ] **Step 1: Types**

```rust
pub struct DriftScheduler {
    inner: JobScheduler,
    job_ids: RwLock<HashMap<String /* schedule_id */, Uuid /* job uuid */>>,
    runner: Arc<DriftRunner<'static>>,
}

impl DriftScheduler {
    pub async fn new(runner: Arc<DriftRunner<'static>>) -> Result<Self>;
    pub async fn load_from_db(&self, db: &Db) -> Result<()>;
    pub async fn create(&self, template_id: &str, cron_expr: &str, db: &Db) -> Result<String /* schedule_id */>;
    pub async fn pause(&self, schedule_id: &str, db: &Db) -> Result<()>;
    pub async fn resume(&self, schedule_id: &str, db: &Db) -> Result<()>;
    pub async fn delete(&self, schedule_id: &str, db: &Db) -> Result<()>;
}
```

Job body: call `runner.run_on_demand(template_id)`. On panic inside job, the scheduler must stay healthy (catch + log + continue). Update `drift_schedules.last_run_at` after each run.

- [ ] **Step 2: Default cron expression**

`0 0 * * * *` (every hour, at minute 0). Constant `DEFAULT_CRON_HOURLY`.

- [ ] **Step 3: Tauri commands**

```rust
#[tauri::command]
pub async fn drift_schedule_create(template_id: String, cron_expr: Option<String>, db: State<'_, Db>, sched: State<'_, DriftScheduler>) -> Result<String, String>;

#[tauri::command]
pub async fn drift_schedule_pause(schedule_id: String, db: State<'_, Db>, sched: State<'_, DriftScheduler>) -> Result<(), String>;

#[tauri::command]
pub async fn drift_schedule_resume(schedule_id: String, db: State<'_, Db>, sched: State<'_, DriftScheduler>) -> Result<(), String>;

#[tauri::command]
pub async fn drift_schedule_delete(schedule_id: String, db: State<'_, Db>, sched: State<'_, DriftScheduler>) -> Result<(), String>;

#[tauri::command]
pub async fn drift_schedule_list(db: State<'_, Db>) -> Result<Vec<DriftSchedule>, String>;
```

- [ ] **Step 4: App setup**

In `lib.rs` `setup`, after db is ready: construct `DriftRunner`, then `DriftScheduler::new(...)`, then `scheduler.load_from_db(&db).await?` to register all `enabled=1` schedules.

- [ ] **Step 5: Integration test**

Create a schedule with cron `* * * * * *` (every second), wait 2s, confirm at least one `drift_reports` row appeared and `drift_schedules.last_run_at` bumped. Pause, wait 2s, confirm no new rows. Resume, confirm rows resume.

- [ ] **Step 6: Commit** `feat(drift): tokio-cron scheduler with pause/resume`

### Task 5.3 — Notifications  `PARALLEL with 5.2 test finalization`

**Files:**
- Modify: `src/components/StatusFooter.tsx` — subscribe to drift events
- Create: `src/lib/driftEvents.ts` — Tauri event listener helpers
- Modify: `src-tauri/src/drift/scheduler.rs` — emit events

Events emitted (use `app.emit_all` from existing pattern — inspect `src-tauri/src/agent_bridge.rs` first to match style, **do not invent**):
- `drift://run.started` — `{template_id, schedule_id?}`
- `drift://run.completed` — `{template_id, total, drifted, in_sync, errors}`
- `drift://run.drift_found` — `{template_id, device_id, severity}` (per destructive-severity report)

Frontend:
- Footer chip `src/components/StatusFooter.tsx` shows "N devices drift" when any recent `drift://run.drift_found` has `severity='destructive'`.
- System notification (Tauri notification plugin — confirm permission in `capabilities/default.json`) on destructive drift. Query context7 for `tauri-plugin-notification` before wiring.

- [ ] **Step 1: Research notification plugin via context7.**
- [ ] **Step 2: Tests** — mock event emission, assert footer chip + notification call.
- [ ] **Step 3: Commit** `feat(drift): footer + system notifications on drift`

### Task 5.4 — Phase 5 regression  `SEQUENTIAL`

- [ ] Full suite (bun, cargo, playwright smoke).
- [ ] Launch `bun run tauri dev`, create an hourly schedule, force-trigger via `drift_run_on_demand`, confirm footer updates and notification fires.
- [ ] Code review subagent.
- [ ] Update plan + completion block. Commit.

---

## Phase 6 — UI sidebar + remediation flow

### Task 6.1 — Pre-impl `frontend-design`  `SEQUENTIAL`

- [ ] **Step 1: Dispatch `frontend-design` skill**

Brief: "Design a drift sidebar (right-docked, collapsible, 380px default). Groups devices by site tag; each device row shows status dot (green/yellow/red), device id, last-checked timestamp, severity chip. Expanding a device shows its latest `DriftPatch` summary (added/removed/modified counts) and a `Remediate` button. Tapping a block opens a full-width diff view with intent-vs-running side-by-side and a 'Open in editor' button that loads the computed patch into Monaco. Show empty-state + error-state designs. Existing palette: `src/App.css`. Deliver: wireframes for sidebar collapsed, expanded device, full-width diff view, and Monaco remediation view. Save to `docs/design/drift-sidebar.md`."

- [ ] **Step 2: Commit design doc.**

### Task 6.2 — `DriftSidebar` component  `SEQUENTIAL` (depends on 6.1)

**Files:**
- Create: `src/components/drift/DriftSidebar.tsx` + `.css`
- Create: `src/components/drift/DriftDeviceRow.tsx` + `.css`
- Create: `src/components/drift/DriftSeverityChip.tsx` + `.css`
- Create: `src/components/drift/DriftSidebar.test.tsx`
- Create: `src/state/driftStore.ts`

- [ ] **Step 1: Zustand store**

```ts
interface DriftState {
  reportsByTemplate: Record<string, DriftReport[]>;
  loading: boolean;
  refresh(templateId: string): Promise<void>;
  runOnDemand(templateId: string): Promise<void>;
  subscribeEvents(): () => void;   // wires drift:// events to store mutations
}
```

- [ ] **Step 2: Group-by-tag logic**

Devices grouped by the first matching tag in `intent_templates.selector.tags`, or by `device_kind` if no tag. Reuse Plan 01's tag vocabulary — query `block_tags` if device tags live there (verify by reading `src/state/blocksStore.ts` before coding).

- [ ] **Step 3: Render**

- Collapsed sidebar: vertical strip with severity-colored dots.
- Expanded: group headers; device rows; click-to-expand reveals counts + `Remediate`.
- Empty state: "No intent templates yet — create one".
- Error state: "Last run errored on N devices — [view]".

- [ ] **Step 4: Tests** — mounting, group collapse/expand, severity chip color correctness, remediate button dispatch.

- [ ] **Step 5: Commit** `feat(drift): sidebar with grouped drift reports`

### Task 6.3 — Full-width diff view  `PARALLEL with 6.4`

**Files:**
- Create: `src/components/drift/DriftDiffView.tsx` + `.css`
- Create: `src/components/drift/DriftDiffView.test.tsx`

Renders a `DriftPatch` as two side-by-side panels (intent / running) with per-`DriftBlock` highlighted changes. Colour rules:
- Destructive block → red background in intent column.
- Additive block → yellow in running column.
- Modified block → blue with line-level hunks.
Includes "Open in editor" button → routes to Task 6.4.

- [ ] **Step 1: Tests** — renders expected colours for seeded patches.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Commit.**

### Task 6.4 — Remediation flow (Monaco review)  `PARALLEL with 6.3`

**Files:**
- Create: `src/components/drift/RemediationPanel.tsx` + `.css`
- Modify: `src/components/editor/MonacoEditor.tsx` — **read only if not already** via `readOnly` prop (it is — see line 70 of `src/components/editor/MonacoEditor.tsx`).
- Create: `src/lib/remediation.ts`
- Create: `src/lib/remediation.test.ts`

- [ ] **Step 1: Patch formatter**

```ts
// src/lib/remediation.ts
export function patchToConfigCommands(vendor: string, patch: DriftPatch): string {
  // For IOS-like vendors:
  //   Destructive removed -> emit "no <line>" for each removed line (when safe).
  //   Additive extras in running -> emit "no <line>" to remove from running.
  //   Modified blocks -> emit "<group header>", then intent lines, with `no` commands for running-only lines.
  // For Junos -> "delete <path>" / "set <path> <value>" syntax.
}
```

- [ ] **Step 2: Tests** for both vendor families using fixtures from Phase 3 tests.

- [ ] **Step 3: `RemediationPanel` component**

Flow:
1. User clicks "Remediate" on a drift row.
2. Panel opens, runs `patchToConfigCommands(vendor, patch)`, shows result in `MonacoEditor` with `readOnly=true`, `language="plaintext"` (or `junos` if we later add), `filePath={"intent://remediation/<device_id>"}`.
3. Two buttons: `Copy` (clipboard) and `Unlock for edit` (toggles `readOnly=false` after a confirmation dialog). **No push-to-device wiring in this plan** — that is a follow-on (explicitly scope-cut; Plan 09 may gate it with guardrails).

- [ ] **Step 4: Tests** — component renders patch; copy fires clipboard; unlock requires confirmation.

- [ ] **Step 5: Commit** `feat(drift): remediation panel with Monaco review`

### Task 6.5 — Wire sidebar into app shell  `SEQUENTIAL` (depends on 6.2, 6.3, 6.4)

**Files:**
- Modify: `src/App.tsx` or the nearest shell container (inspect first — do not guess layout)
- Modify: `src/state/driftStore.ts` — mount event subscription once at app startup

- [ ] **Step 1: Inspect shell**

```bash
grep -n "StatusFooter\|AgentPanel\|PaneContainer" src/App.tsx
```

Place `<DriftSidebar />` alongside the right-side rails already present. Gate behind a feature toggle if the app has a settings panel for it; otherwise render unconditionally.

- [ ] **Step 2: Subscribe to drift events on mount.**
- [ ] **Step 3: E2E smoke**: seed a template + one drifted mock device, open the app, confirm sidebar shows a red dot and "Remediate" opens the Monaco panel.

- [ ] **Step 4: Commit.**

### Task 6.6 — Post-impl `frontend-design` review + docs  `SEQUENTIAL`

- [ ] **Step 1: Screenshots** of sidebar (collapsed + expanded + remediation).
- [ ] **Step 2: Dispatch `frontend-design` skill** with screenshots; apply any fixes.
- [ ] **Step 3: Documentation**
  - Create: `docs/DRIFT.md` — architecture, how to create intent, how remediation works, limitations (no push).
  - Update: `docs/USER_GUIDE.md` — "Drift sidebar" keyboard shortcuts if any were added.
- [ ] **Step 4: Commit** `docs: drift detection user + architecture docs`

### Task 6.7 — Phase 6 regression  `SEQUENTIAL`

- [ ] `bun run test` — green.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` — green.
- [ ] `bunx playwright test --grep @smoke` — green. Add a drift-specific `@smoke` playwright test exercising the remediate flow end-to-end.
- [ ] Code review subagent — final pass over the full plan diff.
- [ ] Update `/Plans/README.md` status column for Plan 08 to ✅.
- [ ] Update this plan file — all boxes checked, append final completion block.
- [ ] Commit.

---

## Self-review checklist (before marking plan complete)

- [ ] Migration number **V0035** matches `/Plans/README.md` reservation row.
- [ ] Tables `intent_templates`, `intent_assignments`, `drift_reports`, `drift_schedules` match the brief — column names, types, constraints, and CHECK enums.
- [ ] Every `Tauri command` has: Rust-side test, TS wrapper, TS test.
- [ ] **No guessing** on library APIs — `minijinja` (Phase 2), `similar` (Phase 3), `tokio-cron-scheduler` (Phase 5), and `tauri-plugin-notification` (Phase 5) each have a `context7` query step BEFORE code is written.
- [ ] Plan 07's fan-out API contract is re-verified at Phase 4 start (`/Plans/07-multi-device-fanout.md`); we adapt this plan to it, not the other way around.
- [ ] Phase 2 normalizer has fixtures for all three vendors called out in the brief (IOS-XE, NX-OS, Junos). Arista EOS reuses IOS-like rules — verify at review.
- [ ] Phase 6 includes BOTH a pre-impl `frontend-design` brief and a post-impl screenshot review.
- [ ] Monaco editor reuse explicitly cites `src/components/editor/MonacoEditor.tsx` — no bespoke editor.
- [ ] Remediation panel ships **review-only** — no push-to-device wiring. Explicitly noted as scope-cut (future Plan 09 gate).
- [ ] Every phase ends with regression + code review + plan-file checkbox update + commit.
- [ ] Parallel vs sequential labels correct — tasks that touch the same file are sequential (e.g. 1.2 and 1.3 both write `commands/drift.rs` → sequential; 2.2 render + 2.3 normalize touch different files → parallel).
- [ ] All new frontend types (`IntentTemplate`, `DriftPatch`, `DriftBlock`, `DriftReport`, `DriftSchedule`) match their Rust counterparts field-for-field and via `#[serde(rename_all = "snake_case")]` where enums are used.

## Completion log

## Phase 1 — COMPLETED 2026-05-18
V0035 schema (intent_templates, intent_assignments, drift_reports, drift_schedules) applied. IntentRepo CRUD over rusqlite. 8 Tauri intent_* commands wired. Frontend lib + zustand store + Monaco-backed IntentEditor (tabs: Body, Vars (jinja-only), Selector). 7 cargo + 8 vitest tests green.

## Phase 2 — COMPLETED 2026-05-18
minijinja 2 renderer with YAML-default + override merge (recursive, Null is no-op). Per-vendor normalizer (IOS-XE/NX-OS/IOS-XR/EOS/Junos/Generic) with rule-based drop + redact. Idempotent. Tauri commands intent_render + config_normalize. 13 cargo tests green.

## Phase 3 — COMPLETED 2026-05-18
Diff engine on top of `similar` 2 with TextDiff::from_lines + grouped_ops(2) and a thin block-header annotator (interface/router/acl/etc, plus Junos curly stanzas). DriftPatch / DriftBlock / LineChange types serialize cleanly. drift_diff Tauri command. 8 cargo tests green.

## Phase 4 — COMPLETED 2026-05-18
DriftRunner dispatches `show running-config` via Plan 07 fan-out, reads back per-device blocks, normalizes both sides, diffs, and persists drift_reports rows. Failed devices get error rows. 4 Tauri commands (drift_run_on_demand, drift_reports_list, drift_report_get, drift_reports_by_device). 3 cargo tests green.

## Phase 5 — COMPLETED 2026-05-18
tokio-cron-scheduler 0.13 wired via DriftScheduler (lazy AppState slot, mirrors fanout pattern). add/pause/resume/delete plus boot-time replay of enabled schedules. ScheduleSink trait emits `drift://schedule_run` events. 5 Tauri commands. 3 cargo tests green (CRUD + secondly cron actually fires + pause/resume).

## Phase 6 — COMPLETED 2026-05-18
DriftSidebar (template picker + report tree + per-block diff view), ScheduleEditor (cron presets + validation), RemediationDialog (Monaco patch with `no <command>` derivation, push gated until approval checkbox). Drift menu (Open Sidebar Cmd+Shift+D, Manage Intents). Wired into App.tsx via menu listeners. 7 vitest tests green.

Final tally: 34 cargo drift tests + 22 vitest drift tests, all green. Vitest baseline 825 pass / 9 fail (9 pre-existing). Plan 08 complete on main 2026-05-18.

<!-- Append `## Phase N — COMPLETED YYYY-MM-DD` blocks below as phases finish. -->
