import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dump, load } from "js-yaml";
import { test, expect, type Page } from "@playwright/test";
import { createDefaultAppearanceSettings } from "../../src/theme/defaults";
import { BLANK_PLAYBOOK_YAML } from "../../src/features/troubleshoot/playbook-validate";
import type {
  AuthoringCatalog,
  Catalog,
  MetricRow,
  StartRequest,
  TelemetrySnapshot,
  WidgetDefinition,
  WidgetPage,
  WidgetSummary,
  ConfigDraft,
  ConfigScope,
} from "../../src/features/telemetry/types";

const origin = "http://127.0.0.1:1438";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const assets = new URL("../../src-tauri/telemetry/", import.meta.url);
const widgets = (
  load(readFileSync(new URL("widgets.yaml", assets), "utf8")) as {
    widgets: WidgetDefinition[];
  }
).widgets;
const layouts = (
  load(readFileSync(new URL("layouts.yaml", assets), "utf8")) as {
    layouts: Catalog["layouts"][string][];
  }
).layouts;
const templates: Catalog["templates"] = {};
const manifest = JSON.parse(
  readFileSync(new URL("catalog.json", assets), "utf8"),
) as {
  templates: {
    id: string;
    platform: "ios" | "iosxe";
    command: string;
    path: string;
    sha256: string;
  }[];
};
for (const asset of manifest.templates) {
  const text = readFileSync(new URL(asset.path, assets), "utf8");
  if (createHash("sha256").update(text).digest("hex") !== asset.sha256)
    throw new Error("Fixture template hash changed");
  templates[asset.id] = { ...asset, text };
}
/** Presentation fixtures only; no native collector, saved data, credentials or device access. */
class SyntheticTelemetryBackend {
  readonly denied: string[] = [];
  readonly receipts: string[] = [];
  readonly files = new Map<string, string>();
  readonly widgetFailures = new Set<string>();
  nextOpen: string | null = null;
  nextSave: string | null = null;
  fileFailure = false;
  applyFailure = false;
  readonly appliedDrafts: ConfigDraft[] = [];
  readonly starts: StartRequest[] = [];
  private delayedLocalReads: { resolve(value: unknown): void; value: unknown }[] = [];
  private delayLocalReads = false;
  get localReadsPending() { return this.delayedLocalReads.length; }
  advanceLocalObservation() {
    this.state.sequence++;
    for (const widget of this.state.widgets.filter((w) => w.target_id === "local")) {
      widget.observed_at_ms += 5000;
      widget.last_success_at_ms = widget.observed_at_ms;
    }
    this.delayLocalReads = true;
  }
  releaseLocalReads() {
    this.delayLocalReads = false;
    for (const pending of this.delayedLocalReads) pending.resolve(pending.value);
    this.delayedLocalReads = [];
  }
  private delayedPreview?: { resolve(value: unknown): void; value: unknown };
  delayPreview = false;
  releasePreview() { this.delayedPreview?.resolve(this.delayedPreview.value); this.delayedPreview = undefined; }
  get previewPending() { return !!this.delayedPreview; }
  nativeDecisions: { requestId: number; approved: boolean; failed: boolean }[] = [];
  private currentDraft: ConfigDraft | null = null;
  private draftHash(draft: ConfigDraft) { return createHash("sha256").update(JSON.stringify(draft)).digest("hex"); }
  readonly handlers = new Map<string, Set<number>>();
  readonly names = Array.from({ length: 10 }, (_, i) => ({
    id: `switch-${i}`,
    name: `Switch ${i + 1}`,
    platform: "iosxe",
  }));
  private state: TelemetrySnapshot = {
    workspace_id: "",
    generation: 1,
    sequence: 1,
    running: false,
    targets: [],
    widgets: [],
    series: [],
    diagnostics: [],
  };
  private pages = new Map<string, WidgetPage>();
  private restoreResolve?: (value: null) => void;
  releaseRestore() {
    this.restoreResolve?.(null);
  }
  advanceObservation() {
    this.state.sequence++;
    for (const w of this.state.widgets.filter(
      (w) => w.target_id === "switch-0",
    )) {
      w.observed_at_ms += 30000;
      w.last_success_at_ms = w.observed_at_ms;
    }
    const cpu = this.pages.get("switch-0:cpu")!;
    cpu.metadata.state = "stale";
    cpu.metadata.observed_at_ms = 1699999900000;
    cpu.metadata.last_success_at_ms = cpu.metadata.observed_at_ms;
    const memory = this.pages.get("switch-0:memory")!;
    memory.metadata.state = "failed";
    memory.metadata.severity = "info";
    memory.metadata.last_success_at_ms = null;
    memory.metadata.row_count = 0;
    memory.metadata.diagnostics = [{code:"fixture_parse", message:"Fixture memory collection failed", path:"memory",line:null,column:null}];
    memory.rows = [];
  }
  expireHistories() {
    this.state.sequence++;
    this.state.series = [];
  }
  private read<T>(value: T, revision = "source") {
    return {
      workspace_id: this.state.workspace_id,
      generation: this.state.generation,
      sequence: this.state.sequence,
      revision,
      value: clone(value),
    };
  }
  private catalog(local: boolean, scope: ConfigScope = local ? "local" : { device: "switch-0" }): AuthoringCatalog {
    const selected = widgets.filter((w) =>
      local ? w.source.kind === "local" : w.source.kind === "ssh",
    );
    const builtin: Catalog = {
      widgets: Object.fromEntries(selected.map((w) => [w.widget, w])),
      layouts: Object.fromEntries(layouts.filter((l) => local ? l.layout === "local_pc" : l.layout === "device").map((l) => [l.layout, l])),
      templates: local ? {} : templates,
    };
    const equalOverride = typeof scope !== "string" && ("device" in scope || scope.profile === "iosxe") ? selected.filter((widget) => widget.widget === "cpu") : [];
    const origins: AuthoringCatalog["origins"] = { widgets: Object.fromEntries(selected.map((widget) => [widget.widget, "builtin"])), layouts: Object.fromEntries(Object.keys(builtin.layouts).map((id) => [id, "builtin"])), templates: Object.fromEntries(Object.keys(builtin.templates).map((id) => [id, "builtin"])) };
    for (const widget of equalOverride) origins.widgets[widget.widget] = typeof scope !== "string" && "device" in scope ? { device: scope.device } : { profile: "iosxe" };
    return {
      effective: {
        revision: "source",
        widgets: selected,
        layouts: layouts.filter((l) =>
          local ? l.layout === "local_pc" : l.layout === "device",
        ),
        templates: builtin.templates,
      },
      builtin,
      inherited: builtin,
      own: {
        scope,
        widgets_yaml: dump({ schema_version: 1, widgets: equalOverride }),
        layouts_yaml: "schema_version: 1\nlayouts: []",
        templates: {},
        expected_revision: "global",
      },
      origins,
    };
  }
  private rows(w: WidgetDefinition): MetricRow[] {
    const values: Record<string, unknown> = {
      hostname: "Switch 1",
      version: "Fixture IOS-XE",
      uptime: "3 days",
      hardware: "Observed fixture model",
      serial: "fixture",
      pid: "10",
      name: "Observed process",
      cpu_5s_percent: 4,
      cpu_1m_percent: 6,
      cpu_5m_percent: 5,
      process_5s_percent: 1,
      total_bytes: 1000000000,
      used_bytes: 250000000,
      free_bytes: 750000000,
      available_bytes: 750000000,
      swap_total_bytes: 0,
      swap_used_bytes: 0,
      neighbor: "10.0.0.2",
      neighbor_as: "65002",
      remote_as: "65002",
      local_as: "65001",
      router_id: "10.0.0.1",
      vrf: "CORP",
      address_family: "IPv4 Unicast",
      state: "2-Way",
      prefixes_received: 7,
      interface: "Gi1/0/1",
      local_interface: "Gi1/0/1",
      vlan: "10",
      mac: "0011.2233.4455",
      interfaces: '["Gi1/0/1"]',
      role: "Alternate",
      cost: 4,
      core: "total",
      label: "Overall",
      usage: 23,
      logical_cores: 8,
      mount: "/",
      filesystem: "fixturefs",
      received_bit_s: 12000,
      transmitted_bit_s: 8000,
      input_bit_s: 4000,
      output_bit_s: 2000,
      link_state: "up",
      protocol_state: "up",
      status: "connected",
      description: "Observed fixture interface",
    };
    const make = (index: number): MetricRow => ({
      key: `row-${index}`,
      fields: Object.fromEntries(
        [
          ...new Set([...Object.keys(w.fields), ...Object.keys(w.rates ?? {})]),
        ].map((field) => {
          const value =
            w.widget === "local_processes" && field === "name"
              ? `Observed process ${index + 1}`
              : w.widget === "local_processes" && field === "pid"
                ? String(index + 10)
                : field === "interface"
                  ? `Gi1/0/${index + 1}`
                  : w.widget === "stp_ports" && field === "state"
                    ? "Blocking"
                    : w.widget === "bgp_peers" && field === "state"
                      ? "Established"
                      : values[field];
          return [
            field,
            value === undefined
              ? { kind: "missing", reason: "fixture_unavailable" }
              : typeof value === "number"
                ? w.source.kind === "ssh" && ["cpu", "memory"].includes(w.widget)
                  ? { kind: "text", value: String(w.widget === "memory" && field === "used_bytes" ? 236752096 : w.widget === "memory" && field === "total_bytes" ? 919638648 : value) }
                  : { kind: "number", value }
                : { kind: "text", value: String(value) },
          ];
        }),
      ),
    });
    return Array.from(
      {
        length:
          w.widget === "interfaces"
            ? 24
            : w.widget === "local_processes"
              ? 1500
              : w.widget === "cpu"
                ? 2
                : 1,
      },
      (_, i) => make(i),
    );
  }
  private populate(request: StartRequest) {
    this.state.running = true;
    this.state.generation++;
    this.state.sequence++;
    this.state.targets = request.targets.map((t, i) => ({
      target_id: t.connection_id,
      display_name: this.names.find((n) => n.id === t.connection_id)!.name,
      platform: t.platform,
      monitoring_selected: true,
      state: i === 9 ? "failed" : i === 8 ? "stale" : "fresh",
      last_success_at_ms: 1700000000000,
      diagnostics:
        i === 9
          ? [
              {
                code: "fixture_transport",
                message:
                  "Fixture collection unavailable; device condition unknown",
                path: "transport",
                line: null,
                column: null,
              },
            ]
          : [],
    }));
    if (request.local_enabled)
      this.state.targets.push({
        target_id: "local",
        display_name: "Local PC",
        platform: null,
        monitoring_selected: true,
        state: "fresh",
        last_success_at_ms: 1700000000000,
        diagnostics: [],
      });
    this.pages.clear();
    this.state.widgets = [];
    this.state.series = [];
    for (const target of this.state.targets)
      for (const w of widgets.filter((w) =>
        target.target_id === "local"
          ? w.source.kind === "local"
          : w.source.kind === "ssh",
      )) {
        const rows = this.rows(w);
        const metadata: WidgetSummary = {
          workspace_id: this.state.workspace_id,
          target_id: target.target_id,
          widget_id: w.widget,
          revision: "source",
          generation: this.state.generation,
          observed_at_ms: 1700000000000,
          last_success_at_ms: target.last_success_at_ms,
          state: target.state,
          severity: "ok",
          row_count: rows.length,
          diagnostics: [],
          units: Object.fromEntries(
            (w.view.type === "chart"
              ? w.view.series
              : w.view.type === "table" || w.view.type === "kv"
                ? w.view.columns
                : []
            )
              .filter((c) => c.unit)
              .map((c) => [c.field, c.unit!]),
          ),
        };
        this.state.widgets.push(metadata);
        this.pages.set(`${target.target_id}:${w.widget}`, {
          metadata,
          rows,
          next_offset: null,
        });
        for (const field of w.history?.fields ?? [])
          this.state.series.push({
            target_id: target.target_id,
            widget_id: w.widget,
            row_key: rows[0].key,
            field,
            unit: metadata.units[field] ?? w.rates?.[field]?.unit ?? null,
            point_count: 3,
          });
      }
  }
  async invoke(command: string, input: unknown): Promise<unknown> {
    const a = (input ?? {}) as Record<string, any>;
    this.receipts.push(command);
    switch (command) {
      case "plugin:event|listen": {
        const h = this.handlers.get(a.event) ?? new Set<number>();
        h.add(a.handler);
        this.handlers.set(a.event, h);
        return null;
      }
      case "plugin:event|unlisten":
        return null;
      case "appearance_settings_get":
        return createDefaultAppearanceSettings();
      case "editor_mode_get":
        return "monaco";
      case "restore_last_session":
        return new Promise<null>((resolve) => {
          this.restoreResolve = resolve;
        });
      case "save_current_session":
        return "fixture";
      case "get_sidecar_status":
        return {
          running: false,
          last_seen: null,
          version: null,
          pid: null,
          now: 0,
        };
      case "ftp_status":
        return {
          running: false,
          bindAddress: null,
          startedAt: null,
          lastError: null,
        };
      case "tftp_status":
        return {
          running: false,
          bindAddress: null,
          startedAt: null,
          lastError: null,
          elevated: false,
        };
      case "ftp_events_tail":
      case "heartbeat_list":
      case "kanban_list":
      case "agents_list":
      case "ssh_list_folders":
        return [];
      case "ftp_events_stream":
      case "set_pane_focus":
      case "get_pane_foreground_agent":
        return null;
      case "ssh_list_connections":
        return clone(this.names);
      case "panes_get_layout":
      case "agent_session_get":
        return null;
      case "workflow_list":
      case "ai_messages_by_tab_agent":
        return [];
      case "global_command_bar_get":
        return { schema_version: 1, workflow_ids: [] };
      case "telemetry_establish":
        if (this.state.workspace_id !== a.workspaceId) this.state = { workspace_id: a.workspaceId, generation: 1, sequence: 1, running: false, targets: [], widgets: [], series: [], diagnostics: [] };
        this.state.workspace_id = a.workspaceId;
        return clone(this.state);
      case "telemetry_snapshot":
        return clone(this.state);
      case "telemetry_start":
        this.starts.push(clone(a.request));
        this.populate(a.request);
        return clone(this.state);
      case "telemetry_select": {
        const saved = this.names.find((target) => target.id === a.target.connection_id);
        if (!saved) throw new Error("Fixture unknown saved target");
        if (!this.state.targets.some((target) => target.target_id === saved.id)) this.state.targets.push({ target_id: saved.id, display_name: saved.name, platform: a.target.platform, monitoring_selected: false, state: "stopped", last_success_at_ms: null, diagnostics: [] });
        this.state.sequence++; return clone(this.state);
      }
      case "telemetry_stop":
        this.state.running = false;
        this.state.generation++;
        this.state.sequence++;
        this.state.targets.forEach((t) => (t.state = "stopped"));
        this.state.widgets.forEach((w) => (w.state = "stopped"));
        return null;
      case "telemetry_close":
        return null;
      case "telemetry_catalog":
        return this.read(this.catalog(a.scope === "local", a.scope), "global");
      case "list_playbooks":
        return [];
      case "app_shutdown_preflight_decide":
        this.nativeDecisions.push(clone(a) as { requestId: number; approved: boolean; failed: boolean });
        return true;
      case "plugin:dialog|open":
        return this.nextOpen;
      case "plugin:dialog|save":
        return this.nextSave;
      case "plugin:fs|read_text_file":
        if (this.fileFailure) throw new Error("Fixture disk read failed");
        if (!this.files.has(a.path)) throw new Error("Fixture file missing");
        return Array.from(new TextEncoder().encode(this.files.get(a.path)!));
      case "plugin:fs|write_text_file":
        if (this.fileFailure) throw new Error("Fixture disk write failed");
        this.files.set(decodeURIComponent(a.options.headers.path), new TextDecoder().decode(Uint8Array.from(a.bytes)));
        return null;
      case "telemetry_import":
        return this.read({ draft: null, diagnostics: [{ code: "import_unsupported", message: "Fixture unsupported import retained", path: "unsupported", line: 2, column: 1 }] }, "global");
      case "telemetry_validate": {
        this.currentDraft = clone(a.draft);
        let valid = false;
        try { const doc = load(a.draft.widgets_yaml) as { schema_version?: number; widgets?: unknown[] }; valid = doc.schema_version === 1 && Array.isArray(doc.widgets); } catch { /* invalid fixture draft */ }
        return this.read({ valid, draft_hash: this.draftHash(a.draft), diagnostics: valid ? [] : [{ code: "yaml", message: "Fixture invalid YAML", path: "widgets", line: 1, column: 1 }], affected_targets: ["switch-0"], masked_device_overrides: ["switch-1"] }, "global");
      }
      case "telemetry_preview": {
        const network = a.draft.scope !== "local", definition = widgets.find((widget) => widget.widget === (network ? "cpu" : "local_memory"))!;
        const rows = this.rows(definition).slice(0, 1);
        if (network) rows[0].fields.name = { kind: "text", value: "Rendered capture-two" };
        const frame = { workspace_id: this.state.workspace_id, target_id: network ? "switch-0" : "local", widget_id: definition.widget, revision: "source", generation: this.state.generation, observed_at_ms: 1700000000000, last_success_at_ms: 1700000000000, state: "fresh", severity: "info", units: {}, rows, diagnostics: [] };
        const parserId = "iosxe.show_processes_cpu";
        const captures = network ? ["capture-one", "capture-two"].map((id) => ({ capture_id: id, target_id: "switch-0", platform: "iosxe", command: "show processes cpu", parser_id: parserId, revision: "source", observed_at_ms: 1700000000000, monotonic_ms: 100, raw: `Fixture retained raw ${id}` })) : [];
        const interpretations = captures.map((capture) => ({ capture_id: capture.capture_id, parser_id: parserId, template_sha256: templates[parserId].sha256, rows: [{ key: capture.capture_id, fields: { PROCESS_NAME: { kind: "text", value: `Parsed ${capture.capture_id}` } } }] }));
        const preview = this.read({ token: { id: "fixture-native-token", draft_hash: this.draftHash(a.draft), base_revision: "global", sample_hashes: {}, expires_at_ms: Date.now() + 60000 }, frames: [frame], captures, local_samples: network ? [] : [{ observed_at_ms: 1700000000000, monotonic_ms: 100, sources: { "local.memory": rows }, diagnostics: [] }], interpretations, frame_sources: [{ frame_index: 0, source: network ? { capture: { capture_id: "capture-two", parser_id: parserId } } : { local: { sample_index: 0, collector: "local.memory" } } }], diagnostics: [] }, "global");
        if (this.delayPreview) { this.delayPreview = false; return new Promise((resolve) => { this.delayedPreview = { resolve, value: preview }; }); }
        return preview;
      }
      case "telemetry_capture_sample": {
        const request = a.request;
        if (request.kind !== "draft" || request.draft.expected_revision !== "global" || request.target.connection_id !== "switch-0" || request.parser_id !== "iosxe.show_processes_cpu") throw new Error("Fixture draft capture binding mismatch");
        return this.read({ capture_id: "explicit-capture", target_id: "switch-0", platform: "iosxe", command: "show processes cpu", parser_id: request.parser_id, revision: "source", observed_at_ms: 1700000001000, monotonic_ms: 1100, raw: "Fixture explicit admitted capture" }, "global");
      }
      case "telemetry_test_template":
        if (!["capture-one", "capture-two", "explicit-capture"].includes(a.captureId) || a.template.command !== "show processes cpu" || a.template.platform !== "iosxe") throw new Error("Fixture template binding mismatch");
        return this.read({ capture_id: a.captureId, parser_id: a.template.id, template_sha256: a.template.sha256, rows: [{ key: "tested", fields: { PROCESS_NAME: { kind: "text", value: "Fixture template test record" } } }] }, "global");
      case "telemetry_apply":
        if (!this.currentDraft || a.token.draft_hash !== this.draftHash(a.draft) || a.token.draft_hash !== this.draftHash(this.currentDraft)) throw new Error("Fixture stale token");
        if (this.applyFailure) throw new Error("Fixture apply disk write failed");
        this.appliedDrafts.push(clone(a.draft));
        this.state.generation++; this.state.sequence++;
        return this.read({ revision: "global", affected_targets: ["switch-0"], masked_device_overrides: ["switch-1"] }, "global");
      case "telemetry_widget": {
        if (this.widgetFailures.has(`${a.query.target_id}:${a.query.widget_id}`)) throw new Error("Fixture applied refresh failed");
        const p = this.pages.get(`${a.query.target_id}:${a.query.widget_id}`);
        if (!p) throw new Error("Fixture widget missing");
        const end = a.query.offset + a.query.limit;
        const reply = this.read({
          ...p,
          rows: p.rows.slice(a.query.offset, end),
          next_offset: end < p.rows.length ? end : null,
        });
        if (this.delayLocalReads && a.query.target_id === "local")
          return new Promise((resolve) => { this.delayedLocalReads.push({ resolve, value: reply }); });
        return reply;
      }
      case "telemetry_series": {
        const value = this.pages
          .get(`${a.query.target_id}:${a.query.widget_id}`)
          ?.rows.find((r) => r.key === a.query.row_key)?.fields[a.query.field];
        const base = value?.kind === "number" ? value.value : null;
        return this.read({
          points: [
            {
              at_ms: 1700000000000,
              value: base,
              reason: base === null ? "fixture_unavailable" : null,
            },
            { at_ms: 1700000005000, value: null, reason: "collection_gap" },
            {
              at_ms: 1700000010000,
              value: base === null ? null : base * 1.25,
              reason: base === null ? "fixture_unavailable" : null,
            },
          ],
          next_after_ms: null,
        });
      }
      default:
        this.denied.push(command);
        throw new Error(`Telemetry fixture denied IPC: ${command}`);
    }
  }
  async theme(page: Page, appTheme: "terminai-dark" | "slate-grey" | "matrix") {
    const handlers = [
      ...(this.handlers.get("appearance-settings-changed") ?? []),
    ];
    expect(handlers.length).toBeGreaterThan(0);
    await page.evaluate(
      ({ handlers, payload }) => {
        const i = (window as any).__TAURI_INTERNALS__;
        handlers.forEach((id) =>
          i.runCallback(id, {
            event: "appearance-settings-changed",
            id,
            payload,
          }),
        );
      },
      { handlers, payload: { ...createDefaultAppearanceSettings(), appTheme } },
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", appTheme);
  }
}

test("Telemetry dashboards use actual effective widgets, observed interfaces and retained gaps", async ({
  page,
  context,
}, info) => {
  const backend = new SyntheticTelemetryBackend(),
    external: string[] = [],
    errors: string[] = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin + "/")) return route.continue();
    external.push(url);
    return route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", (socket) => {
    external.push(socket.url());
    socket.close({ code: 1008, reason: "Telemetry fixture blocks WebSockets" });
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.exposeFunction(
    "__telemetryInvoke",
    (command: string, args: unknown) => backend.invoke(command, args),
  );
  await page.goto("/");
  await expect
    .poll(
      () => backend.receipts.filter((c) => c === "restore_last_session").length,
    )
    .toBe(1);
  await page.getByTestId("tab-new-chooser").click();
  await page.getByRole("menuitem", { name: "Telemetry" }).click();
  backend.releaseRestore();
  const workspace = page.getByRole("region", { name: "Telemetry workspace" });
  await expect(
    workspace.getByRole("heading", { name: "Telemetry", exact: true }),
  ).toBeVisible();
  const conversation = page.locator('.workspace-chat');
  const resizer = page.locator('.workspace > .resize-handle');
  const mountedPanel = await conversation.locator('.agent-panel').elementHandle();
  const mountedTelemetry = await workspace.elementHandle();
  await expect(conversation).toBeHidden();
  await expect(resizer).toBeHidden();
  await workspace.getByRole("button", { name: "Manage targets" }).click();
  const dialog = page.getByRole("dialog", { name: "Monitoring targets" });
  for (const n of backend.names)
    await dialog.getByLabel(n.name, { exact: true }).check();
  await dialog.getByRole("button", { name: "Use selection" }).click();
  await expect(
    workspace.getByRole("button", { name: "Manage targets" }),
  ).toBeFocused();
  await workspace.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    workspace
      .getByRole("table", { name: "Monitored devices" })
      .getByRole("row"),
  ).toHaveCount(11);
  await workspace.getByRole("button", { name: "Manage targets" }).click();
  await dialog.getByLabel("Switch 10", { exact: true }).uncheck();
  await dialog.getByLabel("Monitor this computer", { exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Use selection" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => backend.starts.length).toBe(2);
  expect(backend.starts[1].targets.map((target) => target.connection_id)).not.toContain("switch-9");
  expect(backend.starts[1].local_enabled).toBe(false);
  await workspace.getByRole("button", { name: "Manage targets" }).click();
  await dialog.getByLabel("Switch 10", { exact: true }).check();
  await dialog.getByLabel("Monitor this computer", { exact: true }).check();
  await dialog.getByRole("button", { name: "Use selection" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => backend.starts.length).toBe(3);
  try {
    await expect(workspace.getByText("4 %").first()).toBeVisible();
  } catch (error) {
    writeFileSync(
      info.outputPath("source-failure.json"),
      JSON.stringify(
        {
          sources: await workspace.locator("details").allTextContents(),
          denied: backend.denied,
          receipts: backend.receipts,
          errors,
        },
        null,
        2,
      ),
    );
    throw error;
  }
  const heartbeat = page.locator('.tab[data-tab-type="heartbeat"]');
  await expect(
    workspace.getByRole("cell", { name: "IOSXE", exact: true }),
  ).toHaveCount(10);
  await expect(workspace.getByText(/1 up \/ 1 observed/).first()).toBeVisible();
  const routingCoverage = workspace.getByRole("region", {
    name: "Fleet routing coverage",
  });
  await expect(
    routingCoverage.getByText(/BGP summary.*8 \/ 10 current targets/),
  ).toBeVisible();
  const localSummary = workspace.getByRole("region", {
    name: "Local PC summary",
  });
  await expect(localSummary.getByText("23 %", { exact: true })).toBeVisible();
  await expect(
    localSummary.getByText("250000000 B / 1000000000 B", { exact: true }),
  ).toBeVisible();
  await workspace
    .getByLabel("Interface detail target")
    .selectOption("switch-0");
  await expect(
    workspace
      .getByLabel("Traffic interface")
      .getByRole("option", { name: "Gi1/0/1", exact: true }),
  ).toHaveCount(1);
  await workspace.getByLabel("Traffic interface").selectOption("Gi1/0/1");
  const traffic = workspace.getByRole("region", {
    name: "Selected interface traffic",
  });
  await expect(traffic.locator(".telemetry-chart")).toHaveCount(2);
  await traffic.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("fleet-traffic-1440.png") });
  const beforeRefresh = backend.receipts.filter(
    (c) => c === "telemetry_snapshot",
  ).length;
  backend.advanceObservation();
  await expect(
    workspace
      .getByRole("table", { name: "Monitored devices" })
      .getByText("Telemetry reply is obsolete; retry"),
  ).toHaveCount(0);
  await expect
    .poll(
      () => backend.receipts.filter((c) => c === "telemetry_snapshot").length,
    )
    .toBeGreaterThan(beforeRefresh);
  await expect(traffic.locator(".telemetry-chart")).toHaveCount(2);
  await expect(workspace.getByText(/Telemetry reply is obsolete/)).toHaveCount(
    0,
  );
  const firstDevice = workspace.getByRole("row").filter({has: page.getByRole("button", {name:"Switch 1",exact:true})});
  await expect(firstDevice.getByRole("cell").filter({hasText:"4 %"}).getByText("Stale", {exact:true})).toBeVisible();
  await expect(firstDevice.getByText("Fixture memory collection failed", {exact:false})).toBeVisible();
  await firstDevice.getByText("4 %", {exact:false}).scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath("fleet-mixed-quality-1440.png")});
  await firstDevice.getByRole("cell").filter({hasText:/up \/.*observed/}).scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath("fleet-source-counts-1440.png")});
  await workspace.getByRole("table", {name:"Monitored devices"}).evaluate((table) => {table.parentElement!.scrollLeft = 0;});
  await localSummary.scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath("fleet-local-1440.png")});
  await workspace
    .getByRole("heading", { name: "Fleet", exact: true })
    .scrollIntoViewIfNeeded();
  const telemetrySelection = page.getByRole('button', { name: 'Select Telemetry workspace Telemetry' });
  for (const collapsed of [false, true]) {
    await heartbeat.click();
    await expect(conversation).toBeVisible();
    await expect(resizer).toBeVisible();
    if (collapsed) await conversation.getByTitle('Toggle AI Chat').click();
    await expect(conversation.locator('.agent-panel')).toHaveClass(collapsed ? /collapsed/ : /open/);
    const restoredWidth = await conversation.evaluate(el => el.getBoundingClientRect().width);
    const snapshots = backend.receipts.filter(c => c === 'telemetry_snapshot').length;
    await expect.poll(() => backend.receipts.filter(c => c === 'telemetry_snapshot').length).toBeGreaterThan(snapshots);
    expect(backend.receipts.filter(c => c === 'telemetry_stop' || c === 'telemetry_close')).toEqual([]);
    expect(await mountedTelemetry!.evaluate(el => el.isConnected)).toBe(true);
    await telemetrySelection.click();
    await expect(workspace).toBeVisible();
    await expect(conversation).toBeHidden();
    await expect(resizer).toBeHidden();
    expect(await mountedPanel!.evaluate(el => el.isConnected)).toBe(true);
    await expect(workspace.getByRole('navigation', { name: 'Telemetry views' }).getByRole('status')).toContainText('Monitoring');
    await heartbeat.click();
    await expect(conversation.locator('.agent-panel')).toHaveClass(collapsed ? /collapsed/ : /open/);
    expect(await conversation.evaluate(el => el.getBoundingClientRect().width)).toBe(restoredWidth);
    await telemetrySelection.click();
  }
  for (const width of [1440, 680])
    for (const theme of ["terminai-dark", "slate-grey", "matrix"] as const)
      for (const colorScheme of ["dark", "light"] as const) {
        await page.setViewportSize({
          width,
          height: width === 1440 ? 1000 : 950,
        });
        await page.emulateMedia({ colorScheme });
        await backend.theme(page, theme);
        await expect(workspace).toBeVisible();
        const geometry = await workspace.evaluate((el) => ({
          scroll: el.scrollWidth,
          client: el.clientWidth,
        }));
        expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
        const workspaceWidth = await page.locator('.workspace').evaluate(el => el.clientWidth);
        const contentWidth = await page.locator('.workspace > .term-col').evaluate(el => el.getBoundingClientRect().width);
        expect(contentWidth).toBeGreaterThanOrEqual(workspaceWidth - 1);
        await page.screenshot({
          path: info.outputPath(
            `fleet-${width}-${theme}-browser-${colorScheme}.png`,
          ),
        });
      }
  await traffic.scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath("fleet-traffic-680-matrix.png")});
  await workspace
    .getByRole("button", { name: "Switch 1", exact: true })
    .click();
  await expect(workspace.getByText(/24 observed interfaces/)).toBeVisible();
  await workspace.getByLabel("Traffic interface").selectOption("Gi1/0/1");
  await expect(
    workspace
      .getByRole("region", { name: "Selected interface traffic" })
      .locator(".telemetry-chart"),
  ).toHaveCount(2);
  await workspace
    .getByRole("region", { name: "Selected interface traffic" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("device-overview-680-matrix.png"),
  });
  await workspace.getByRole("button", { name: "Routing", exact: true }).click();
  await expect(workspace.getByText("2-Way").first()).toBeVisible();
  await expect(workspace.getByText("CORP").first()).toBeVisible();
  for (const title of ["BGP summary: AF, peer, state and prefixes", "BGP VRF detail identity", "OSPF neighbors and observed interfaces", "OSPF interface process/area observations", "EIGRP neighbors and observed AS"])
    await expect(workspace.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("device-routing-680.png") });
  await workspace.getByRole("button", { name: "Switching", exact: true }).click();
  for (const title of ["VLANs", "Switchport trunk mode/native/enabled VLAN observations", "STP roles and port states", "STP root observations", "EtherChannel bundle/member states", "CDP neighbors", "LLDP neighbors", "MAC address table"])
    await expect(workspace.getByRole("heading", { name: title, exact: true })).toBeVisible();
  const macs = workspace.getByRole("table", { name: "MAC address table", exact: true });
  await workspace.getByRole("searchbox", { name: "Filter MAC address table", exact: true }).fill("0011.2233");
  await expect(macs.getByText("0011.2233.4455", { exact: true })).toBeVisible();
  await workspace.getByRole("searchbox", { name: "Filter MAC address table", exact: true }).fill("no-such-mac");
  await expect(macs.getByRole("row")).toHaveCount(1);
  await workspace.getByRole("searchbox", { name: "Filter MAC address table", exact: true }).fill("");
  await macs.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("device-switching-mac-680.png") });
  await workspace
    .getByRole("button", { name: "Interfaces", exact: true })
    .click();
  await expect(
    workspace.getByRole("button", { name: /Select interface Gi/ }),
  ).toHaveCount(24);
  await workspace
    .getByRole("button", { name: "Select interface Gi1/0/24" })
    .click();
  await expect(
    workspace.getByText("Selected interface: Gi1/0/24"),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("device-680-matrix.png") });
  await workspace
    .getByRole("button", { name: "Local PC", exact: true })
    .click();
  await expect(
    workspace.getByText("This computer", { exact: true }),
  ).toBeVisible();
  await expect(
    workspace
      .getByText("Unknown", { exact: true })
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  const processes = workspace.getByRole("table", { name: "Local Processes" });
  await processes.scrollIntoViewIfNeeded();
  await expect(workspace.getByText("1500 of 1500 retained rows")).toBeVisible();
  await expect.poll(() => processes.getByRole("row").count()).toBeLessThan(100);
  await workspace
    .getByRole("searchbox", { name: "Filter Local Processes", exact: true })
    .fill("Observed process 1500");
  await expect(processes.getByRole("row")).toHaveCount(2);
  await expect(processes.getByText("Observed process 1500")).toBeVisible();
  const processNode = await processes.elementHandle();
  const localScroll = async () => ({
    scrollTop: await workspace.evaluate((el) => el.scrollTop),
    processY: (await processes.getByText("Observed process 1500").boundingBox())!.y,
  });
  const scrollBefore = await localScroll();
  expect(scrollBefore.scrollTop).toBeGreaterThan(500);
  const scrollReceipts = [];
  for (let refresh = 0; refresh < 3; refresh++) {
    backend.advanceLocalObservation();
    await expect.poll(() => backend.localReadsPending).toBeGreaterThan(0);
    const pending = await localScroll();
    expect(await processNode!.evaluate((el) => el.isConnected)).toBe(true);
    expect(pending.scrollTop).toBeGreaterThan(500);
    expect(Math.abs(pending.processY - scrollBefore.processY)).toBeLessThanOrEqual(2);
    backend.releaseLocalReads();
    await expect(workspace.getByText("Loading current observations…")).toHaveCount(0);
    const settled = await localScroll();
    expect(await processNode!.evaluate((el) => el.isConnected)).toBe(true);
    await expect(workspace.getByRole("searchbox", { name: "Filter Local Processes", exact: true })).toHaveValue("Observed process 1500");
    expect(settled.scrollTop).toBeGreaterThan(500);
    expect(Math.abs(settled.processY - scrollBefore.processY)).toBeLessThanOrEqual(2);
    scrollReceipts.push({ refresh, before: scrollBefore, pending, settled });
  }
  writeFileSync(info.outputPath("local-refresh-scroll.json"), JSON.stringify(scrollReceipts, null, 2));
  await workspace.getByRole("button", { name: "Widgets", exact: true }).click();
  const appliedStudio = workspace.getByRole("region", { name: "Widget studio", exact: true });
  await appliedStudio.locator(".telemetry-library-list").getByRole("button", { name: /^Local Memory/ }).click();
  const appliedPane = appliedStudio.getByRole("region", { name: "Last applied widget" });
  await expect(appliedPane.getByText("250000000", { exact: true })).toBeVisible();
  await expect(appliedPane.getByText(/Fresh/)).toBeVisible();
  backend.widgetFailures.add("local:local_memory");
  await workspace.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(appliedPane.getByText("Fixture applied refresh failed", { exact: true })).toBeVisible();
  await expect(appliedPane.getByText(/Stopped/)).toBeVisible();
  await expect(appliedPane.getByText("250000000", { exact: true })).toBeVisible();
  await expect(appliedPane.getByText(/Fresh/)).toHaveCount(0);
  await appliedPane.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("studio-stopped-retained-680-matrix.png") });
  backend.widgetFailures.delete("local:local_memory");
  await workspace.getByRole("button", { name: "Local PC", exact: true }).click();
  await expect(
    workspace
      .getByRole("navigation", { name: "Telemetry views" })
      .getByRole("status"),
  ).toContainText("Stopped");
  await expect(
    workspace.getByText("Loading current observations…"),
  ).toHaveCount(0);
  await workspace
    .locator(".telemetry-chart")
    .first()
    .getByText("Recorded display values", { exact: true })
    .click();
  await expect(
    workspace.locator(".telemetry-chart").first().getByText("collection_gap"),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("local-stopped-680-matrix.png"),
  });
  await processes.scrollIntoViewIfNeeded();
  await workspace.getByRole("searchbox", {name:"Filter Local Processes",exact:true}).fill("Observed process 1500");
  await expect(processes.getByText("Observed process 1500")).toBeVisible();
  const stoppedProcesses = await processes.elementHandle();
  backend.expireHistories();
  await expect(workspace.locator(".telemetry-chart")).toHaveCount(0);
  expect(await stoppedProcesses!.evaluate((el) => el.isConnected)).toBe(true);
  await expect(workspace.getByRole("searchbox", {name:"Filter Local Processes",exact:true})).toHaveValue("Observed process 1500");
  await expect(processes.getByText("Observed process 1500")).toBeVisible();
  await page.screenshot({
    path: info.outputPath("local-expired-680-matrix.png"),
  });
  await page
    .locator(".tab")
    .filter({ has: page.getByTitle("Telemetry workspace", { exact: true }) })
    .locator(".tab-close")
    .focus();
  await page.keyboard.press("Enter");
  await expect(workspace).toHaveCount(0);
  await expect(page.getByTitle('New terminal tab', { exact: true })).toBeFocused();
  expect(backend.receipts.filter((c) => c === "telemetry_close")).toHaveLength(
    1,
  );
  const closeFocus = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    label: document.activeElement?.getAttribute("aria-label"),
  }));
  await page.getByTestId("tab-new-chooser").click();
  await page.getByRole("menuitem", { name: "Telemetry" }).click();
  await expect(workspace.getByRole("navigation", { name: "Telemetry views" }).getByRole("status")).toContainText("Stopped");
  await expect(workspace.getByRole("table", { name: "Monitored devices" }).getByRole("row")).toHaveCount(1);
  await expect(workspace.locator(".telemetry-chart")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("reopened-empty-stopped.png") });
  expect(backend.receipts.filter((c) => c === "telemetry_start")).toHaveLength(3);
  expect(backend.denied).toEqual([]);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  writeFileSync(
    info.outputPath("evidence.json"),
    JSON.stringify(
      {
        fixtureOnly: true,
        receipts: backend.receipts,
        denied: backend.denied,
        external,
        errors,
        closeFocus,
        limitations: [
          "Native/device/OS gates open",
          "No true light app theme exists; browser light/dark preferences tested with all three actual app themes",
        ],
      },
      null,
      2,
    ),
  );
});

for (const widgetFirst of [true, false]) test(`Studio and Playbook Monaco schemas stay isolated (${widgetFirst ? "widget first" : "playbook first"})`, async ({ page, context }, info) => {
  const backend = new SyntheticTelemetryBackend(), external: string[] = [], errors: string[] = [];
  const errorDetails: { message: string; stack?: string; recentReceipts: string[] }[] = [];
  await context.route("**/*", (route) => { const url = route.request().url(); if (url.startsWith(origin + "/")) return route.continue(); external.push(url); return route.abort("blockedbyclient"); });
  await context.routeWebSocket("**/*", (socket) => { external.push(socket.url()); socket.close({ code: 1008, reason: "Telemetry fixture blocks WebSockets" }); });
  page.on("pageerror", (error) => { errors.push(error.message); errorDetails.push({ message: error.message, stack: error.stack, recentReceipts: backend.receipts.slice(-12) }); writeFileSync(info.outputPath("browser-errors.json"), JSON.stringify(errorDetails, null, 2)); });
  await page.exposeFunction("__telemetryInvoke", (command: string, args: unknown) => backend.invoke(command, args));
  await page.goto("/");
  await expect.poll(() => backend.receipts.filter((command) => command === "restore_last_session").length).toBe(1);
  const emit = async (event: string, payload: unknown) => {
    await expect.poll(() => backend.handlers.get(event)?.size ?? 0).toBeGreaterThan(0);
    await page.evaluate(({ event, payload, handlers }) => { for (const id of handlers) (window as any).__TAURI_INTERNALS__.runCallback(id, { event, id, payload }); }, { event, payload, handlers: [...backend.handlers.get(event)!] });
  };
  const openStudio = async () => {
    await page.getByTestId("tab-new-chooser").click(); await page.getByRole("menuitem", { name: "Telemetry" }).click();
    backend.releaseRestore();
    await page.getByRole("region", { name: "Telemetry workspace" }).getByRole("button", { name: "Widgets", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__telemetryMonaco.editor.getModels().some((model: any) => model.uri.toString().includes("telemetry-studio")))).toBe(true);
  };
  const openPlaybook = async () => { await emit("menu:troubleshoot_editor", null); await expect(page.getByTestId("tb-editor")).toBeVisible(); await expect.poll(() => page.evaluate(() => (window as any).__telemetryMonaco.editor.getModels().some((model: any) => model.uri.toString().includes("ccie-playbook")))).toBe(true); };
  if (widgetFirst) { await openStudio(); await openPlaybook(); } else { await openPlaybook(); await openStudio(); }
  const models = await page.evaluate(() => (window as any).__telemetryMonaco.editor.getModels().map((model: any) => model.uri.toString()));
  const widgetUri = models.find((uri: string) => uri.includes("telemetry-studio"))!, playbookUri = models.find((uri: string) => uri.includes("ccie-playbook"))!;
  const setSource = (uri: string, value: string) => page.evaluate(({ uri, value }) => { const monaco = (window as any).__telemetryMonaco; monaco.editor.getModel(monaco.Uri.parse(uri)).setValue(value); }, { uri, value });
  const source = (uri: string) => page.evaluate((uri) => { const monaco = (window as any).__telemetryMonaco; return monaco.editor.getModel(monaco.Uri.parse(uri))?.getValue(); }, uri);
  const markers = (uri: string) => page.evaluate((uri) => { const monaco = (window as any).__telemetryMonaco; return monaco.editor.getModelMarkers({ resource: monaco.Uri.parse(uri) }).map((marker: any) => marker.message); }, uri);
  const validWidget = "schema_version: 1\nwidgets: []\n";
  await setSource(playbookUri, BLANK_PLAYBOOK_YAML);
  await setSource(widgetUri, `${validWidget}widget_only_invalid: true\n`);
  await expect.poll(() => markers(widgetUri)).not.toEqual([]);
  await expect.poll(() => markers(playbookUri)).toEqual([]);
  const widgetMarkers = await markers(widgetUri);
  await setSource(widgetUri, validWidget); await setSource(playbookUri, `${BLANK_PLAYBOOK_YAML}\nplaybook_only_invalid: true\n`);
  await expect.poll(() => markers(widgetUri)).toEqual([]); await expect.poll(() => markers(playbookUri)).not.toEqual([]);
  const playbookMarkers = await markers(playbookUri);
  const completion = async (uri: string, value: string, expected: string) => {
    await setSource(uri, value);
    await page.evaluate((uri) => { const monaco = (window as any).__telemetryMonaco; const editor = monaco.editor.getEditors().find((editor: any) => editor.getModel()?.uri.toString() === uri); editor.focus(); editor.setPosition({ lineNumber: 2, column: 1 }); editor.trigger("telemetry-acceptance", "editor.action.triggerSuggest", {}); }, uri);
    await expect(page.locator(".suggest-widget.visible .label-name").filter({ hasText: expected }).first()).toBeVisible();
    const labels = await page.locator(".suggest-widget.visible .label-name").allTextContents();
    await page.keyboard.press("Escape"); return labels;
  };
  await page.locator(".tab").filter({ hasText: "Playbooks" }).click();
  const playbookCompletion = await completion(playbookUri, "id: fixture\n", "steps");
  expect(playbookCompletion).not.toContain("widgets"); await setSource(playbookUri, BLANK_PLAYBOOK_YAML);
  await page.locator(".tab").filter({ has: page.getByTitle("Telemetry workspace", { exact: true }) }).click();
  const widgetCompletion = await completion(widgetUri, "schema_version: 1\n", "widgets");
  expect(widgetCompletion).not.toContain("steps"); await setSource(widgetUri, validWidget);
  const studio = page.getByRole("region", { name: "Widget studio", exact: true });
  await expect(studio.locator(".telemetry-library-list").getByText("Bundled", { exact: true }).first()).toBeVisible();
  const workspace = page.getByRole("region", { name: "Telemetry workspace" });
  await workspace.getByRole("button", { name: "Device", exact: true }).click();
  await workspace.getByRole("combobox", { name: "Device target", exact: true }).selectOption("switch-0");
  await expect.poll(() => backend.receipts.filter((command) => command === "telemetry_select").length).toBe(1);
  await workspace.getByRole("button", { name: "Widgets", exact: true }).click();
  const changeScope = async (value: string) => {
    if (await studio.getByText("Unsaved draft", { exact: true }).count()) page.once("dialog", (dialog) => dialog.accept());
    await studio.getByRole("combobox", { name: "Editing scope", exact: true }).selectOption(value);
    await expect(studio.getByRole("combobox", { name: "Editing scope", exact: true })).toHaveValue(value);
  };
  for (const value of ["local", "profile:iosxe", "device:switch-0"]) {
    await changeScope(value);
    await studio.getByRole("button", { name: "Validate", exact: true }).click();
    await expect(studio.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();
    await studio.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(studio.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
    await studio.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(studio.getByText("Loaded the canonical owned layer.", { exact: true })).toBeVisible();
    await expect(studio.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  }
  expect(backend.appliedDrafts.map((draft) => draft.scope)).toEqual(["local", { profile: "iosxe" }, { device: "switch-0" }]);
  await changeScope("profile:iosxe");
  await expect(studio.getByText("IOSXE profile override", { exact: true })).toBeVisible();
  await studio.locator(".telemetry-library-list").getByRole("button", { name: /CPU and processes/ }).click();
  await studio.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(studio.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();
  await studio.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(studio.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
  await expect(studio.getByText("Fixture retained raw capture-two", { exact: true })).toBeVisible();
  await expect(studio.getByText(/Parsed capture-two/)).toBeVisible();
  await expect(studio.getByText("Rendered capture-two", { exact: true })).toBeVisible();
  backend.applyFailure = true;
  await studio.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(studio.getByRole("alert")).toContainText("Fixture apply disk write failed");
  await expect(studio.getByText("Rendered capture-two", { exact: true })).toBeVisible();
  backend.applyFailure = false;
  expect(await studio.getByText("Fixture retained raw capture-one", { exact: true }).count()).toBe(0);
  await workspace.evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath("studio-authoring-1440.png") });
  await page.setViewportSize({ width: 680, height: 1000 }); await workspace.evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath("studio-authoring-680.png") });
  await studio.getByRole("heading", { name: "Preview review" }).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("studio-preview-680.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await studio.getByRole("button", { name: "TextFSM", exact: true }).click();
  await studio.locator(".telemetry-library-list").getByRole("button", { name: /iosxe\.show_processes_cpu/ }).click();
  await studio.getByRole("button", { name: "Test template", exact: true }).click();
  await expect(studio.getByText(/Fixture template test record/)).toBeVisible();
  backend.nextSave = "/fixture/bundled.textfsm";
  await studio.getByRole("button", { name: "Export", exact: true }).click();
  await expect.poll(() => backend.files.get("/fixture/bundled.textfsm")).toBe(templates["iosxe.show_processes_cpu"].text);
  expect(backend.receipts.filter((command) => command === "telemetry_capture_sample")).toHaveLength(0);
  await studio.getByRole("combobox", { name: "Capture target", exact: true }).selectOption("switch-0");
  await studio.getByRole("button", { name: "Capture sample", exact: true }).click();
  await expect(studio.getByText("Sample captured. Validate and Preview to inspect its actual interpretation.", { exact: true })).toBeVisible();
  await expect(studio.getByRole("combobox", { name: "Retained capture", exact: true })).toHaveValue("explicit-capture");
  await studio.getByRole("button", { name: "Test template", exact: true }).click();
  await expect(studio.getByText(/Fixture template test record/)).toBeVisible();
  await workspace.evaluate((element) => { element.scrollTop = 0; }); await page.screenshot({ path: info.outputPath("studio-textfsm-1440.png") });
  await studio.getByRole("button", { name: "Widgets", exact: true }).click();
  await changeScope("device:switch-0");
  await expect(studio.getByText("Device override", { exact: true })).toBeVisible();
  await studio.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(studio.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();
  await studio.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(studio.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const browser = window as any, internals = browser.__TAURI_INTERNALS__, invoke = internals.invoke;
    browser.__task12PreviewDelivered = false;
    internals.invoke = async (command: string, args: unknown, options: unknown) => {
      try { return await invoke(command, args, options); }
      finally { if (command === "telemetry_preview") browser.__task12PreviewDelivered = true; }
    };
  });
  backend.delayPreview = true;
  await studio.getByRole("button", { name: "Preview", exact: true }).click();
  await expect.poll(() => backend.previewPending).toBe(true);
  await setSource(widgetUri, `${validWidget}# edited during delayed preview\n`);
  backend.releasePreview();
  await expect.poll(() => page.evaluate(() => (window as any).__task12PreviewDelivered)).toBe(true);
  await expect(studio.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await expect(studio.getByText("Rendered capture-two", { exact: true })).toHaveCount(0);
  await studio.getByRole("button", { name: "Layouts", exact: true }).click();
  const layoutUri = await page.evaluate(() => (window as any).__telemetryMonaco.editor.getModels().find((model: any) => model.uri.toString().includes("layouts.yaml"))?.uri.toString());
  expect(layoutUri).toBeTruthy();
  const layoutYaml = "schema_version: 1\nlayouts:\n  - layout: task12\n    platforms: [iosxe]\n    sections: [{id: overview, title: Task12 layout, rows: [[{widget: cpu, span: 12}]]}]\n";
  await setSource(layoutUri, layoutYaml);
  await studio.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(studio.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();
  await studio.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(studio.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
  await studio.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => backend.appliedDrafts.at(-1)?.layouts_yaml).toBe(layoutYaml);
  await expect(studio.getByText("Loaded the canonical owned layer.", { exact: true })).toBeVisible();
  await studio.getByRole("button", { name: "Widgets", exact: true }).click();
  await setSource(widgetUri, `${validWidget}# edited after preview\n`);
  await expect(studio.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  const exactImport = "# exact unsupported file\nwidget: upstream\nunsupported: true\n";
  backend.nextOpen = "/fixture/import.yaml"; backend.files.set(backend.nextOpen, exactImport);
  await studio.getByRole("button", { name: "Import", exact: true }).click(); await expect.poll(() => source(widgetUri)).toBe(exactImport);
  await expect(studio.getByText(/Fixture unsupported import retained/)).toBeVisible();
  backend.nextSave = "/fixture/export.yaml";
  await studio.getByRole("button", { name: "Export", exact: true }).click(); await expect.poll(() => backend.files.get(backend.nextSave!)).toBe(exactImport);
  backend.fileFailure = true; await studio.getByRole("button", { name: "Export", exact: true }).click();
  await expect(studio.getByRole("alert")).toContainText("Fixture disk write failed"); expect(await source(widgetUri)).toBe(exactImport); backend.fileFailure = false;
  await page.screenshot({ path: info.outputPath("studio-monaco-1440.png") });
  await page.setViewportSize({ width: 680, height: 1000 }); await page.screenshot({ path: info.outputPath("studio-monaco-680.png") });
  page.once("dialog", (dialog) => dialog.dismiss());
  await emit("app://shutdown-preflight", { requestId: 77, reason: "application-quit", timeoutMs: 30000 });
  await expect.poll(() => backend.nativeDecisions).toEqual([{ requestId: 77, approved: false, failed: false }]);
  expect(await source(widgetUri)).toBe(exactImport);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const telemetryTab = page.locator(".tab").filter({ has: page.getByTitle("Telemetry workspace", { exact: true }) });
  page.once("dialog", (dialog) => dialog.dismiss()); await telemetryTab.locator(".tab-close").click();
  await expect(studio).toBeVisible(); expect(await source(widgetUri)).toBe(exactImport);
  expect(backend.receipts.filter((command) => command === "telemetry_close")).toHaveLength(0);
  page.once("dialog", (dialog) => dialog.accept()); await telemetryTab.locator(".tab-close").click();
  await expect.poll(() => source(widgetUri)).toBeUndefined(); await expect.poll(() => markers(widgetUri)).toEqual([]);
  await page.locator(".tab").filter({ hasText: "Playbooks" }).locator(".tab-close").click();
  await expect.poll(() => source(playbookUri)).toBeUndefined(); await expect.poll(() => markers(playbookUri)).toEqual([]);
  expect(backend.receipts.filter((command) => command === "telemetry_capture_sample")).toHaveLength(1);
  expect(backend.denied).toEqual([]); expect(external).toEqual([]); expect(errors).toEqual([]);
  writeFileSync(info.outputPath("studio-evidence.json"), JSON.stringify({ fixtureOnly: true, widgetFirst, models, widgetMarkers, playbookMarkers, widgetCompletion, playbookCompletion, inheritedTemplateExport: backend.files.get("/fixture/bundled.textfsm"), virtualFileRoundTrip: backend.files.get(backend.nextSave!), appliedScopes: backend.appliedDrafts.map((draft) => draft.scope), receipts: backend.receipts, denied: backend.denied, external, errors, nativeDecisions: backend.nativeDecisions, limits: ["Native file dialogs and actual filesystem round-trip OPEN", "Actual app quit, updater, device and OS acceptance OPEN"] }, null, 2));
});
