import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { load } from "js-yaml";
import { test, expect, type Page } from "@playwright/test";
import { createDefaultAppearanceSettings } from "../../src/theme/defaults";
import type {
  AuthoringCatalog,
  Catalog,
  MetricRow,
  StartRequest,
  TelemetrySnapshot,
  WidgetDefinition,
  WidgetPage,
  WidgetSummary,
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
  private read<T>(value: T, revision = "source") {
    return {
      workspace_id: this.state.workspace_id,
      generation: this.state.generation,
      sequence: this.state.sequence,
      revision,
      value: clone(value),
    };
  }
  private catalog(local: boolean): AuthoringCatalog {
    const selected = widgets.filter((w) =>
      local ? w.source.kind === "local" : w.source.kind === "ssh",
    );
    const builtin: Catalog = {
      widgets: Object.fromEntries(widgets.map((w) => [w.widget, w])),
      layouts: Object.fromEntries(layouts.map((l) => [l.layout, l])),
      templates,
    };
    return {
      effective: {
        revision: "source",
        widgets: selected,
        layouts: layouts.filter((l) =>
          local ? l.layout === "local_pc" : l.layout === "device",
        ),
        templates,
      },
      builtin,
      inherited: builtin,
      own: {
        scope: local ? "local" : { device: "switch-0" },
        widgets_yaml: "schema_version: 1\nwidgets: []",
        layouts_yaml: "schema_version: 1\nlayouts: []",
        templates: {},
        expected_revision: "global",
      },
      origins: { widgets: {}, templates: {}, layouts: {} },
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
      description: "Observed fixture interface",
    };
    const make = (index: number): MetricRow => ({
      key: `row-${index}`,
      fields: Object.fromEntries(
        Object.keys(w.fields).map((field) => {
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
                ? { kind: "number", value }
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
        this.state.workspace_id = a.workspaceId;
        return clone(this.state);
      case "telemetry_snapshot":
        return clone(this.state);
      case "telemetry_start":
        this.populate(a.request);
        return clone(this.state);
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
        return this.read(this.catalog(a.scope === "local"), "global");
      case "telemetry_widget": {
        const p = this.pages.get(`${a.query.target_id}:${a.query.widget_id}`);
        if (!p) throw new Error("Fixture widget missing");
        const end = a.query.offset + a.query.limit;
        return this.read({
          ...p,
          rows: p.rows.slice(a.query.offset, end),
          next_offset: end < p.rows.length ? end : null,
        });
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
  await workspace
    .getByRole("button", { name: "Switch 1", exact: true })
    .click();
  await workspace.getByRole("button", { name: "Routing", exact: true }).click();
  await expect(workspace.getByText("2-Way").first()).toBeVisible();
  await expect(workspace.getByText("CORP").first()).toBeVisible();
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
  await workspace.getByRole("button", { name: "Stop", exact: true }).click();
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
    .getByText("Exact retained values", { exact: true })
    .click();
  await expect(
    workspace.locator(".telemetry-chart").first().getByText("collection_gap"),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("local-stopped-680-matrix.png"),
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
