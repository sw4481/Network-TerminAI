import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test, expect, type Page, type Locator, type BrowserContext } from "@playwright/test";
import type { Tab } from "../../src/lib/types";
import type { CanvasCard, CanvasEvent, CanvasRequest, CanvasRun, CardSpec, EvidenceSnapshot, JsonValue } from "../../src/lib/copilotCanvas";
import type { Agent, AiMessage, CanvasWorkspaceSnapshot, ReactEvent, SessionSnapshot } from "../../src/lib/tauri";
import { createDefaultAppearanceSettings } from "../../src/theme/defaults";
import type { Heartbeat } from "../../src/state/heartbeatStore";
import type { KanbanTask } from "../../src/state/kanbanStore";

const origin = "http://127.0.0.1:1437";
const fixtureBytes = readFileSync(new URL("../../tests/fixtures/copilot_canvas/v1.json", import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString()) as { snapshots: EvidenceSnapshot[]; cards: CardSpec[] };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
type Args = Record<string, unknown>;
type Dispatch = { canvas: CanvasRequest; onEvent: string; message: string; history: unknown[] };

/** DEVELOPMENT-MODE SYNTHETIC BUNDLE/PREVIEW only.
 * Maps emulate persistence across a browser reload; they do NOT verify native DB
 * durability, startup interruption, provider behavior or real execution authority.
 */
class SyntheticCanvasBackend {
  readonly receipts: { command: string; args: Args }[] = [];
  readonly denied: string[] = [];
  readonly workspaces = new Map<string, CanvasWorkspaceSnapshot>();
  readonly messages: AiMessage[] = [];
  readonly dispatches: Dispatch[] = [];
  readonly resumes: Args[] = [];
  readonly eventHandlers = new Map<string, Set<number>>();
  readonly channelIndices = new Map<string, number>();
  readonly measurements: unknown[] = [];
  private restoreResolve?: (value: SessionSnapshot | null) => void;
  private restored: SessionSnapshot | null = null;
  private holdRestore = true;
  private holdSave = false;
  private saveResolve?: () => void;
  private sequence = 0;

  count(command: string) { return this.receipts.filter(item => item.command === command).length; }
  private reject(command: string): never {
    this.denied.push(command);
    throw new Error(`Synthetic backend denied IPC: ${command}`);
  }
  private workspace(id: unknown) {
    const workspace = this.workspaces.get(String(id));
    if (!workspace) throw new Error(`Unknown synthetic workspace ${id}`);
    return workspace;
  }
  releaseRestore() { this.holdRestore = false; this.restoreResolve?.(null); }
  holdNextEventSave() { this.holdSave = true; }
  releaseEventSave() { this.saveResolve?.(); this.saveResolve = undefined; }

  async invoke(command: string, input: unknown): Promise<unknown> {
    const args = input as Args;
    this.receipts.push({ command, args: copy(args) });
    switch (command) {
      case "plugin:event|listen": {
        if (typeof args.event !== "string" || typeof args.handler !== "number") return this.reject(command);
        const handlers = this.eventHandlers.get(args.event) ?? new Set<number>();
        handlers.add(args.handler);
        this.eventHandlers.set(args.event, handlers);
        return null;
      }
      case "plugin:event|unlisten":
        this.eventHandlers.get(String(args.event))?.delete(Number(args.eventId ?? args.id));
        return null;
      case "appearance_settings_get": return createDefaultAppearanceSettings();
      case "editor_mode_get": return "monaco";
      case "get_sidecar_status": return { running: false, last_seen: null, version: null, pid: null, now: 0 };
      case "ftp_status": return { running: false, bindAddress: null, startedAt: null, lastError: null };
      case "tftp_status": return { running: false, bindAddress: null, startedAt: null, lastError: null, elevated: false };
      case "ftp_events_tail": return [];
      case "ftp_events_stream": return null;
      case "set_pane_focus": return null;
      case "get_pane_foreground_agent": return null;
      case "heartbeat_list": return [] as Heartbeat[];
      case "kanban_list": return [] as KanbanTask[];
      case "agents_list": return [{
        id: "network-architect", name: "Network Architect", description: "Synthetic browser acceptance only",
        systemPrompt: "", attachedSkills: [], attachedMcpServers: [], attachedTools: [], allowedCommands: [],
        body: "", path: "synthetic-only", executionMode: "react-code", engine: "deepagents",
      } satisfies Agent];
      case "restore_last_session":
        return this.holdRestore ? new Promise(resolve => { this.restoreResolve = resolve; }) : copy(this.restored);
      case "save_current_session": return "synthetic-session";
      case "canvas_create_workspace": {
        const id = `synthetic-workspace-${this.workspaces.size + 1}`;
        const tab: Tab = { id, title: String(args.title), tab_type: "canvas", shell_cmd: "", cwd: "", created_at: 0 };
        this.workspaces.set(id, { tab, runs: [], cards: [], evidence: [], warnings: [] });
        return copy(tab);
      }
      case "canvas_list_workspaces": return copy([...this.workspaces.values()].map(item => item.tab));
      case "canvas_open_workspace": return copy(this.workspace(args.workspaceId));
      case "canvas_rename_workspace": this.workspace(args.workspaceId).tab.title = String(args.title).trim(); return null;
      case "canvas_save_run": {
        const workspace = this.workspace(args.workspaceId);
        const run = copy(args.run as CanvasRun);
        const index = workspace.runs.findIndex(item => item.run_id === run.run_id);
        if (index < 0) workspace.runs.push(run); else workspace.runs[index] = run;
        return null;
      }
      case "canvas_save_event": {
        if (this.holdSave) {
          this.holdSave = false;
          await new Promise<void>(resolve => { this.saveResolve = resolve; });
        }
        const workspace = this.workspace(args.workspaceId);
        const event = copy(args.event as CanvasEvent);
        if (event.kind === "card") {
          const payload = event.payload as unknown as { card: CanvasCard; snapshots: EvidenceSnapshot[] };
          if (!workspace.cards.some(item => item.card_id === payload.card.card_id)) workspace.cards.push(payload.card);
          for (const snapshot of payload.snapshots) {
            if (!workspace.evidence.some(item => item.evidence_id === snapshot.evidence_id)) workspace.evidence.push(snapshot);
          }
        } else if (event.kind === "warning") workspace.warnings.push(event);
        else this.workspace(args.workspaceId).runs.find(run => run.run_id === event.run_id)!.coverage = event.payload;
        return null;
      }
      case "ai_messages_by_tab_agent": return copy(this.messages.filter(item => item.tab_id === args.tabId && item.agentId === args.agentId));
      case "save_ai_message": {
        const id = `synthetic-message-${this.messages.length + 1}`;
        this.messages.push({ id, tab_id: String(args.tabId), agentId: String(args.agentId), role: String(args.role), content: String(args.content), timestamp: Number(args.timestamp) });
        return id;
      }
      case "agent_react_code_run": {
        if (args.agentId !== "network-architect" || !args.canvas || typeof args.onEvent !== "string" || !/^__CHANNEL__:\d+$/.test(args.onEvent)) return this.reject(command);
        this.workspace((args.canvas as CanvasRequest).workspace_id);
        this.dispatches.push(copy(args as Dispatch));
        this.sequence = 0;
        return null;
      }
      case "agent_react_resume":
        if (args.threadId !== "synthetic-workflow-denial" || args.decision !== "deny" || args.editedAction !== null || typeof args.onEvent !== "string" || !/^__CHANNEL__:\d+$/.test(args.onEvent)) return this.reject(command);
        this.resumes.push(copy(args));
        return null;
      default: return this.reject(command);
    }
  }

  async channel(page: Page, channel: string, event: ReactEvent) {
    const index = this.channelIndices.get(channel) ?? 0;
    this.channelIndices.set(channel, index + 1);
    await page.evaluate(({ id, index, message }) => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { callbacks: Map<number, unknown>; runCallback: (id: number, value: unknown) => void } }).__TAURI_INTERNALS__;
      if (!internals.callbacks.has(id)) throw new Error(`Missing real Tauri Channel callback ${id}`);
      internals.runCallback(id, { index, message });
    }, { id: Number(channel.split(":")[1]), index, message: event });
  }
  async event(page: Page, kind: CanvasEvent["kind"], payload: JsonValue) {
    const dispatch = this.dispatches.at(-1)!;
    await this.channel(page, dispatch.onEvent, { type: "canvas", version: 1, workspace_id: dispatch.canvas.workspace_id, run_id: dispatch.canvas.run_id, seq: ++this.sequence, kind, payload });
  }
  materialize() {
    const { workspace_id, run_id } = this.dispatches.at(-1)!.canvas;
    const canvas = { workspace_id, run_id };
    const material = JSON.parse(JSON.stringify(fixture), (key, value) => {
      if (key === "workspace_id") return canvas.workspace_id;
      if (key === "run_id") return canvas.run_id;
      if (key === "evidence_id") return `${canvas.run_id}-${value}`;
      return value;
    }) as typeof fixture;
    return {
      snapshots: material.snapshots,
      cards: material.cards.map((card, index) => ({ ...card, ...canvas, card_id: `${canvas.run_id}-card-${index}`, created_at: "2026-10-25T12:00:02Z" }) as CanvasCard),
    };
  }
  async card(page: Page, card: CanvasCard, snapshots: EvidenceSnapshot[]) {
    await this.event(page, "card", { card, snapshots } as unknown as JsonValue);
  }
  async final(page: Page, response: string, channel = this.dispatches.at(-1)!.onEvent) {
    await this.channel(page, channel, { type: "final", response });
  }
  async theme(page: Page, appTheme: "terminai-dark" | "slate-grey" | "matrix") {
    const handlers = [...(this.eventHandlers.get("appearance-settings-changed") ?? [])];
    expect(handlers.length).toBeGreaterThan(0);
    const payload = { ...createDefaultAppearanceSettings(), appTheme };
    await page.evaluate(({ handlers, payload }) => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { runCallback: (id: number, value: unknown) => void } }).__TAURI_INTERNALS__;
      for (const id of handlers) internals.runCallback(id, { event: "appearance-settings-changed", id, payload });
    }, { handlers, payload });
    await expect(page.locator("html")).toHaveAttribute("data-theme", appTheme);
  }
  restartSurrogate(activeId: string) {
    for (const workspace of this.workspaces.values()) {
      for (const run of workspace.runs) if (["collecting", "awaiting_approval"].includes(run.status)) {
        run.status = "interrupted";
        run.ended_at = "2026-10-25T12:05:00Z";
      }
    }
    const tab = this.workspace(activeId).tab;
    this.restored = { id: "synthetic-session", name: "Synthetic reload surrogate", active_tab_id: tab.id,
      tabs: [{ ...tab, scrollback: [], ai_messages: [] }], created_at: 0 };
    this.eventHandlers.clear();
  }
}

async function createCanvas(page: Page) {
  await page.getByTestId("tab-new-chooser").click();
  await page.getByRole("menuitem", { name: /Canvas investigation/ }).click();
  await expect(page.getByRole("region", { name: "Investigation evidence board" }).getByRole("heading", { level: 1 })).toBeVisible();
}
async function send(page: Page, backend: SyntheticCanvasBackend, message: string) {
  const before = backend.dispatches.length;
  await page.getByPlaceholder("Ask about your terminal...").fill(message);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => backend.dispatches.length).toBe(before + 1);
}
async function stableScroll(locator: Locator, resetTop = false) {
  return locator.evaluate((element, reset) => {
    // Native instant scrolling cancels an outstanding smooth scroll; no CSS override.
    if (reset) element.scrollTo({ top: 0, left: element.scrollLeft, behavior: "instant" });
    return new Promise<number>((resolve, reject) => {
      const deadline = performance.now() + 1500;
      let previous = element.scrollTop, stableFrames = 0;
      const frame = () => {
        const current = element.scrollTop;
        stableFrames = current === previous ? stableFrames + 1 : 0;
        previous = current;
        if (stableFrames >= 3) resolve(current);
        else if (performance.now() >= deadline) reject(new Error("Scroll position did not stabilize within 1500ms"));
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }, resetTop);
}

async function independentScroll(page: Page, backend: SyntheticCanvasBackend, label: string) {
  const board = page.locator(".canvas-board"), chat = page.locator(".agent-messages");
  await stableScroll(board, true); await stableScroll(chat, true);
  for (const [name, target, other] of [["board", board, chat], ["chat", chat, board]] as const) {
    const before = { target: await stableScroll(target), other: await stableScroll(other) };
    await target.hover(); await page.mouse.wheel(0, 300);
    await expect.poll(() => target.evaluate(element => element.scrollTop)).toBeGreaterThan(before.target);
    const after = { target: await stableScroll(target), other: await stableScroll(other) };
    backend.measurements.push({ label: `${label}-wheel-${name}`, before, after });
    expect(after.target, `${name} wheel must move target`).toBeGreaterThan(before.target);
    expect(after.other, `${name} wheel must not move the other pane`).toBe(before.other);
  }
}

async function containment(page: Page, backend: SyntheticCanvasBackend, label: string, soft = false) {
  const board = page.locator(".canvas-board");
  await board.evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: "instant" }));
  await stableScroll(board);
  const result = await board.evaluate(element => {
    const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height }; };
    const workspace = rect(document.querySelector(".workspace-canvas")!);
    const containingColumn = rect(element.closest(".term-col")!);
    const parent = element.parentElement!;
    if (!parent.classList.contains("term-col__content")) throw new Error("Canvas immediate content parent changed; review containment selectors");
    const contentParent = rect(parent);
    const footer = rect(document.querySelector(".status-footer")!);
    const style = getComputedStyle(element);
    const last = element.lastElementChild!;
    return { viewport: { width: innerWidth, height: innerHeight }, board: rect(element), workspace, containingColumn, contentParent, footer,
      visibleTop: Math.max(0, workspace.top, containingColumn.top, contentParent.top), visibleBottom: Math.min(innerHeight, workspace.bottom, containingColumn.bottom, contentParent.bottom, footer.top),
      computed: { boxSizing: style.boxSizing, height: style.height, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, borderTop: style.borderTopWidth, borderBottom: style.borderBottomWidth },
      scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
      lastContent: { text: last.textContent, ...rect(last) } };
  });
  backend.measurements.push({ label: `${label}-containment-scroll-end`, ...result });
  const check = soft ? expect.soft : expect;
  check(result.board.top, `${label}: board above containing viewport`).toBeGreaterThanOrEqual(result.visibleTop);
  check(result.board.bottom, `${label}: board extends below workspace/column/footer visible boundary`).toBeLessThanOrEqual(result.visibleBottom);
  check(Math.abs(result.scrollHeight - result.clientHeight - result.scrollTop), `${label}: did not reach native scroll end`).toBeLessThanOrEqual(1);
  check(result.lastContent.text).toContain("Reopening does not refresh evidence");
  check(result.lastContent.top, `${label}: last content top clipped at scroll end`).toBeGreaterThanOrEqual(Math.max(result.visibleTop, result.board.top));
  check(result.lastContent.bottom, `${label}: complete last content is unreachable at scroll end`).toBeLessThanOrEqual(Math.min(result.visibleBottom, result.board.bottom));
  return result;
}

async function overflowDiagnostics(page: Page, backend: SyntheticCanvasBackend, label: string) {
  const result = await page.evaluate(() => {
    const describe = (element: Element) => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}.${[...element.classList].join(".")}`,
        text: element.textContent?.trim().slice(0, 80), left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height,
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        computed: { display: style.display, visibility: style.visibility, minWidth: style.minWidth, flexShrink: style.flexShrink, flexBasis: style.flexBasis, flexWrap: style.flexWrap, overflowX: style.overflowX, overflowY: style.overflowY, whiteSpace: style.whiteSpace, boxSizing: style.boxSizing } };
    };
    const tabbar = document.querySelector(".tabbar")!;
    const boxes = ["html", "body", "#root", ".shell", ".tabbar", ".workspace-canvas", ".workspace-canvas > .term-col", ".workspace-canvas .term-col__content", ".canvas-board", ".status-footer"].map(selector => ({ selector, ...describe(document.querySelector(selector)!) }));
    const candidates = [...document.querySelectorAll("body *")].filter(element => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return element.getClientRects().length > 0 && box.width > 0 && box.height > 0 && style.visibility === "visible" && (box.right > innerWidth || box.left < 0);
    }).slice(0, 40).map(element => {
      let visibleRight = element.getBoundingClientRect().right, visibleLeft = element.getBoundingClientRect().left;
      const clippingAncestors = [];
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowX !== "visible") {
          const box = parent.getBoundingClientRect();
          visibleRight = Math.min(visibleRight, box.right); visibleLeft = Math.max(visibleLeft, box.left);
          clippingAncestors.push(describe(parent));
        }
      }
      return { ...describe(element), visibleRight, visibleLeft, contributesViewportOverflow: visibleRight > innerWidth || visibleLeft < 0, clippingAncestors };
    });
    return { viewport: { width: innerWidth, height: innerHeight }, pageWidth: document.documentElement.scrollWidth, boxes, tabbarChildren: [...tabbar.children].map(describe), candidates };
  });
  backend.measurements.push({ label: `${label}-overflow-diagnostics`, ...result });
  return result;
}

async function narrowTabbar(page: Page, backend: SyntheticCanvasBackend) {
  const controls = page.locator(".tabbar button:visible");
  const bounds = async (control: Locator) => {
    await expect(control).toBeVisible();
    const result = await control.evaluate(element => {
      const box = element.getBoundingClientRect();
      return { name: element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.textContent,
        left: box.left, right: box.right, top: box.top, bottom: box.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight,
        hit: element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) };
    });
    backend.measurements.push({ label: "narrow-tabbar-control", ...result });
    expect(result.left).toBeGreaterThanOrEqual(0); expect(result.right).toBeLessThanOrEqual(result.viewportWidth);
    expect(result.top).toBeGreaterThanOrEqual(0); expect(result.bottom).toBeLessThanOrEqual(result.viewportHeight);
    expect(result.hit, `${result.name}: center must not be clipped or covered`).toBe(true);
  };
  for (const control of await controls.all()) {
    await bounds(control);
    if (await control.isEnabled()) { await control.focus(); await expect(control).toBeFocused(); }
  }
  const chooser = page.getByTestId("tab-new-chooser"), menu = page.getByRole("menu");
  for (const opening of ["mouse", "keyboard"] as const) {
    if (opening === "mouse") await chooser.click();
    else { await chooser.focus(); await chooser.press("Enter"); }
    await expect(menu).toBeVisible(); await expect(chooser).toHaveAttribute("aria-expanded", "true");
    const outer = await menu.evaluate(element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        tabbarBottom: document.querySelector(".tabbar")!.getBoundingClientRect().bottom,
        viewportWidth: innerWidth, viewportHeight: innerHeight, pageWidth: document.documentElement.scrollWidth };
    });
    backend.measurements.push({ label: "narrow-open-menu", opening, ...outer });
    expect(outer.left).toBeGreaterThanOrEqual(0); expect(outer.right).toBeLessThanOrEqual(outer.viewportWidth);
    expect(outer.top).toBeGreaterThanOrEqual(outer.tabbarBottom); expect(outer.bottom).toBeLessThanOrEqual(outer.viewportHeight);
    expect(outer.pageWidth, "open menu must not overflow the document").toBeLessThanOrEqual(outer.viewportWidth);
    const items = menu.getByRole("menuitem");
    expect(await items.count()).toBeGreaterThan(0);
    for (const item of await items.all()) {
      await page.keyboard.press("Tab"); await expect(item).toBeFocused(); await bounds(item);
    }
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden(); await expect(chooser).toHaveAttribute("aria-expanded", "false");
  }
  // Explicit refocus, not an assertion that Escape restores focus automatically.
  await chooser.focus(); await expect(chooser).toBeFocused();
  await chooser.click(); await expect(menu).toBeVisible();
  await chooser.click(); await expect(menu).toBeHidden(); await expect(chooser).toHaveAttribute("aria-expanded", "false");
}

async function installSyntheticTransport(page: Page, context: BrowserContext, backend: SyntheticCanvasBackend) {
  const networkDenied: string[] = [], socketsDenied: string[] = [], consoleErrors: string[] = [], pageErrors: string[] = [];
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && ["GET", "HEAD"].includes(request.method())) await route.continue();
    else { networkDenied.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort("blockedbyclient"); }
  });
  await context.routeWebSocket("**/*", socket => { socketsDenied.push(socket.url()); socket.close(); });
  await context.exposeBinding("__canvasInvoke", (_, command: string, args: unknown) => backend.invoke(command, args));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 800)); });
  page.on("pageerror", error => pageErrors.push(error.message.slice(0, 800)));
  return { networkDenied, socketsDenied, consoleErrors, pageErrors };
}

async function measure(page: Page, backend: SyntheticCanvasBackend, label: string) {
  const result = await page.evaluate(() => {
    const board = document.querySelector<HTMLElement>(".canvas-board")!;
    const chat = document.querySelector<HTMLElement>(".agent-messages")!;
    const rect = (element: Element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const rgba = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const blend = (fg: number[], bg: number[]) => fg.slice(0, 3).map((v, i) => v * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
    const background = (element: Element): number[] => {
      const layers: number[][] = [];
      for (let node: Element | null = element; node; node = node.parentElement) layers.unshift(rgba(getComputedStyle(node).backgroundColor));
      return layers.reduce((color, layer) => blend(layer, color), [255, 255, 255]);
    };
    const luminance = (color: number[]) => color.map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const contrast = [...board.querySelectorAll<HTMLElement>("h1, .canvas-muted, .canvas-severity, [aria-label='Investigation status'] p, .canvas-card button")].filter(element => element.getClientRects().length > 0).map(element => {
      const style = getComputedStyle(element);
      const bg = background(element);
      const fg = blend(rgba(style.color), bg);
      const a = luminance(fg), b = luminance(bg);
      const font = parseFloat(style.fontSize);
      const large = font >= 24 || (font >= 18.66 && Number(style.fontWeight) >= 700);
      return { text: element.textContent?.slice(0, 100), ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), minimum: large ? 3 : 4.5, color: style.color, background: bg };
    });
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      mediaDark: matchMedia("(prefers-color-scheme: dark)").matches,
      pageWidth: document.documentElement.scrollWidth, board: { ...rect(board), client: board.clientHeight, scroll: board.scrollHeight },
      chat: { ...rect(chat), client: chat.clientHeight, scroll: chat.scrollHeight }, contrast };
  });
  backend.measurements.push({ label, ...result });
  expect(result.pageWidth, `${label}: horizontal page overflow`).toBeLessThanOrEqual(result.viewport.width);
  for (const item of result.contrast) expect(item.ratio, `${label}: ${item.text} contrast ${item.ratio}`).toBeGreaterThanOrEqual(item.minimum);
  return result;
}

test("real App Canvas — development-mode synthetic transport, persistence and restart surrogates", async ({ page, context, browser }, testInfo) => {
  const backend = new SyntheticCanvasBackend();
  const { networkDenied, socketsDenied, consoleErrors, pageErrors } = await installSyntheticTransport(page, context, backend);
  const output = process.env.CANVAS_E2E_OUTPUT!;
  const board = page.getByRole("region", { name: "Investigation evidence board" });
  const chat = page.locator(".agent-messages");
  try {
    await test.step("real user creation before deferred restore; one pinned Architect; no PTY", async () => {
      await page.goto("/");
      await expect.poll(() => backend.count("restore_last_session")).toBe(1);
      await createCanvas(page);
      backend.releaseRestore();
      await expect(page.locator(".agent-panel")).toHaveCount(1);
      await expect(page.getByTitle("Active agent for this tab")).toBeDisabled();
      await expect(page.getByTitle("Active agent for this tab")).toHaveValue("network-architect");
      await page.getByLabel("Investigation title", { exact: true }).fill("Synthetic investigation A");
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      await expect(board.getByRole("heading", { name: "Synthetic investigation A", exact: true })).toBeVisible();
      expect(backend.dispatches).toHaveLength(0);
    });
    const firstId = [...backend.workspaces.keys()][0];
    let originalEvidence = "";
    let originalCards = "";
    let material: ReturnType<SyntheticCanvasBackend["materialize"]>;
    await test.step("progressive real Channel cards; collecting independent of save acknowledgement; frozen values", async () => {
      await send(page, backend, "Synthetic investigation: inspect the frozen source values.");
      material = backend.materialize();
      backend.holdNextEventSave();
      await backend.card(page, material.cards[0], material.snapshots);
      await expect(board.getByRole("heading", { name: "Findings so far", exact: true })).toBeVisible();
      await expect(board.getByText("Saving…", { exact: true })).toBeVisible();
      await expect(board.getByText(/Unsaved local evidence:/)).toBeVisible();
      await expect(board.getByRole("region", { name: "Investigation status" })).toContainText("still collecting");
      await expect.poll(() => backend.count("canvas_save_event")).toBe(1);
      backend.releaseEventSave();
      await expect(board.getByText("Saved evidence", { exact: true })).toBeVisible();
      for (const card of material.cards.slice(1)) await backend.card(page, card, material.snapshots);
      await expect(board.getByRole("heading", { name: "Interfaces", exact: true })).toBeVisible();
      const interfaces = board.locator(".canvas-card").filter({ has: page.getByRole("heading", { name: "Interfaces", exact: true }) });
      await expect(interfaces.getByRole("cell", { name: "0", exact: true })).toBeVisible();
      await expect(interfaces.getByRole("cell", { name: "__proto__", exact: true })).toBeVisible();
      const interfaceSource = interfaces.locator("details");
      await interfaceSource.getByText("Redacted source", { exact: true }).click();
      await expect(interfaceSource.locator("pre")).toHaveText(JSON.stringify((material.snapshots[0].data as { devices: JsonValue[] }).devices, null, 2));
      await expect(interfaceSource).toContainText('"interface": "constructor"');
      await expect(interfaceSource).toContainText("Observed · inventory");
      await expect(interfaceSource).toContainText("call-1");
      await expect(interfaceSource).toContainText(material.snapshots[0].collected_at);
      const port = board.locator(".canvas-card").filter({ has: page.getByRole("heading", { name: "Port status", exact: true }) });
      await expect(port.getByText("false", { exact: true })).toBeVisible();
      await expect(port.getByText("null", { exact: true })).toBeVisible();
      const chart = board.locator(".canvas-card").filter({ has: page.getByRole("heading", { name: "Errors per port", exact: true }) });
      await expect(chart.locator("svg")).toBeVisible();
      await expect(chart.getByRole("region", { name: "Errors per port source values", exact: true }).locator("tbody td")).toHaveText(["0", "3"]);
      await expect(board.getByRole("region", { name: "Assessment coverage" })).toContainText("not unique devices");
      await expect(board.getByRole("region", { name: "Assessment coverage" })).toContainText("Coverage unknown");
      const assessment = board.locator(".canvas-card").filter({ has: page.getByRole("heading", { name: "Next checks", exact: true }) });
      await assessment.getByText("Contradictory evidence", { exact: true }).click();
      await expect(assessment.locator("details").filter({ has: page.getByText("Contradictory evidence", { exact: true }) }).locator("pre")).toHaveText("7");
      await expect(assessment).toContainText("call-2");
      await backend.final(page, "Synthetic completed summary.\n\n" + Array.from({ length: 45 }, (_, i) => `Synthetic retained conversation paragraph ${i + 1}: test prose, not a network assertion.`).join("\n\n"));
      await expect(board.getByRole("region", { name: "Investigation status" })).toContainText("completed");
      await expect.poll(() => backend.workspaces.get(firstId)!.runs.at(-1)!.status).toBe("completed");
      await expect(board.getByText("Saved evidence", { exact: true })).toBeVisible();
      originalEvidence = JSON.stringify(backend.workspaces.get(firstId)!.evidence);
      originalCards = JSON.stringify(backend.workspaces.get(firstId)!.cards);
    });
    await test.step("inspect/Back focus; exact source; selection does not send; removable explicit context; follow-up fails honestly", async () => {
      await stableScroll(board, true);
      const inspect = board.getByRole("button", { name: /^Inspect Check link health/ });
      await inspect.focus();
      await inspect.press("Enter");
      const back = board.getByRole("button", { name: /Back to findings/ });
      await expect(back).toBeFocused();
      await expect(board.getByText("Recommendation — not executed", { exact: true })).toBeVisible();
      const detailSource = board.locator("details").filter({ has: page.getByText("Redacted source", { exact: true }) });
      await detailSource.getByText("Redacted source", { exact: true }).click();
      await expect(detailSource.locator("pre").last()).toHaveText(JSON.stringify((material.snapshots[0].data as { devices: JsonValue[] }).devices[0], null, 2));
      await expect(detailSource.locator("pre").last()).toContainText('"enabled": false');
      await expect(detailSource.locator("pre").last()).toContainText('"note": null');
      const before = backend.dispatches.length;
      await back.click();
      await expect(inspect).toBeFocused();
      const checkbox = board.getByRole("checkbox", { name: /^Select Interface finding/ });
      await checkbox.check();
      expect(backend.dispatches).toHaveLength(before);
      await page.getByRole("button", { name: "Add selected cards to chat" }).click();
      const remove = page.getByRole("button", { name: "Remove attached evidence Interface finding" });
      await expect(remove).toBeVisible();
      expect(backend.dispatches).toHaveLength(before);
      await remove.click();
      await expect(remove).toHaveCount(0);
      await checkbox.check();
      await page.getByRole("button", { name: "Add selected cards to chat" }).click();
      await send(page, backend, "Synthetic explicit recheck with attached exact source.");
      const request = backend.dispatches.at(-1)!;
      expect(request.canvas.selection!.card_ids).toEqual([material.cards[0].card_id]);
      expect(request.canvas.selection!.values).toContainEqual({ ref: { evidence_id: material.snapshots[0].evidence_id, path: "/devices/0" }, value: (material.snapshots[0].data as { devices: JsonValue[] }).devices[0] });
      expect(JSON.stringify(request.history)).toContain("Synthetic completed summary.");
      await backend.channel(page, request.onEvent, { type: "error", message: "Synthetic recheck failed: authentication unavailable; reachability not established." });
      await expect(board.getByRole("region", { name: "Investigation status" })).toContainText("failed");
      await expect(board.getByText(/Previous evidence retained unchanged/)).toBeVisible();
      await expect.poll(() => backend.workspaces.get(firstId)!.runs.at(-1)!.status).toBe("failed");
      expect(JSON.stringify(backend.workspaces.get(firstId)!.evidence)).toBe(originalEvidence);
      expect(JSON.stringify(backend.workspaces.get(firstId)!.cards)).toBe(originalCards);
      await createCanvas(page);
      await page.getByLabel("Investigation title", { exact: true }).fill("Synthetic investigation B");
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      await expect(board.getByRole("heading", { name: "Synthetic investigation B", exact: true })).toBeVisible();
      await page.getByRole("combobox", { name: "Saved investigations", exact: true }).selectOption(firstId);
      await expect(board.getByRole("heading", { name: "Synthetic investigation A", exact: true })).toBeVisible();
      await expect(board.getByRole("region", { name: "Investigation status" })).toContainText("failed");
      await expect(board.getByText(/Previous evidence retained unchanged/)).toBeVisible();
      expect(backend.dispatches).toHaveLength(before + 1);
      expect(JSON.stringify(backend.workspaces.get(firstId)!.evidence)).toBe(originalEvidence);
    });
    await test.step("separately labeled long/derived/execution-output/unavailable synthetic records", async () => {
      await send(page, backend, "Synthetic extra records for origin and overflow measurements.");
      const { workspace_id, run_id } = backend.dispatches.at(-1)!.canvas;
      const canvas = { workspace_id, run_id };
      const extra: EvidenceSnapshot[] = [
        { evidence_id: `${canvas.run_id}-long`, ...canvas, call_id: "synthetic-long-call", collected_at: "2026-10-25T12:01:00Z", source: { helper: "synthetic-layout-only" }, origin: "execution_output", complete: true, limitation: null,
          data: { identifier: "synthetic-" + "long-segment-".repeat(80), output: Array.from({ length: 35 }, (_, i) => `synthetic line ${i}: ${"W".repeat(220)}`).join("\n") }, parent_refs: [], calculation: null },
        { evidence_id: `${canvas.run_id}-derived`, ...canvas, call_id: "synthetic-derived-call", collected_at: "2026-10-25T12:01:01Z", source: { helper: "synthetic-calculation-only" }, origin: "derived", complete: true, limitation: null,
          data: { count: 35 }, parent_refs: [{ evidence_id: `${canvas.run_id}-long`, path: "/output" }], calculation: "Synthetic line count of the separately labeled layout output" },
      ];
      const specs: CardSpec[] = [
        { type: "text", title: "Synthetic long execution output", source_refs: [{ evidence_id: extra[0].evidence_id, path: "" }], metadata: { body: { evidence_id: extra[0].evidence_id, path: "/output" } } },
        { type: "key_value", title: "Synthetic long identifier", source_refs: [{ evidence_id: extra[0].evidence_id, path: "/identifier" }], metadata: { fields: [{ label: "Identifier", ref: { evidence_id: extra[0].evidence_id, path: "/identifier" } }] } },
        { type: "key_value", title: "Synthetic derived count", source_refs: [{ evidence_id: extra[1].evidence_id, path: "/count" }], metadata: { fields: [{ label: "Synthetic count", ref: { evidence_id: extra[1].evidence_id, path: "/count" } }] } },
      ];
      for (const [index, spec] of specs.entries()) await backend.card(page, { ...spec, ...canvas, card_id: `${canvas.run_id}-extra-${index}`, created_at: "2026-10-25T12:01:02Z" }, extra);
      await backend.event(page, "warning", { limitation: "Synthetic unavailable source: authentication failure. No reachability inference; coverage and omitted checks remain unknown." });
      await backend.final(page, "Synthetic extra-record collection completed; not an all-clear.");
      await expect(board.getByText(/Synthetic unavailable source:/)).toBeVisible();
      const derived = board.locator(".canvas-card").filter({ has: page.getByRole("heading", { name: "Synthetic derived count", exact: true }) });
      await derived.getByText("Redacted source", { exact: true }).click();
      await expect(derived).toContainText("Derived · synthetic-calculation-only");
      await expect(derived).toContainText("Calculation: Synthetic line count");
      const execution = board.locator(".canvas-card").filter({ has: page.getByRole("heading", { name: "Synthetic long execution output", exact: true }) });
      await execution.getByText("Redacted source", { exact: true }).click();
      await expect(execution).toContainText("Execution output · synthetic-layout-only");
    });
    await test.step("actual wide/intermediate geometry, independent scrolling, reversible pointer/keyboard divider", async () => {
      for (const size of [{ width: 1440, height: 1000 }, { width: 1280, height: 800 }]) {
        await page.setViewportSize(size);
        const measurement = await measure(page, backend, `geometry-${size.width}`);
        expect(measurement.board.scroll).toBeGreaterThan(measurement.board.client);
        expect(measurement.chat.scroll).toBeGreaterThan(measurement.chat.client);
        expect(measurement.board.width).toBeGreaterThan(0);
        expect(measurement.chat.width).toBeGreaterThan(0);
        await independentScroll(page, backend, `geometry-${size.width}`);
        await containment(page, backend, `geometry-${size.width}`);
        await page.screenshot({ path: testInfo.outputPath(`wide-${size.width}.png`) });
      }
      const separator = page.getByRole("separator", { name: "Resize Architect conversation" });
      await separator.focus(); await separator.press("Home");
      expect(Number(await separator.getAttribute("aria-valuenow"))).toBe(Number(await separator.getAttribute("aria-valuemin")));
      const start = await separator.boundingBox();
      await page.mouse.move(start!.x + start!.width / 2, start!.y + 40); await page.mouse.down();
      await page.mouse.move(start!.x + 180, start!.y + 40, { steps: 8 }); await page.mouse.up();
      expect(Number(await separator.getAttribute("aria-valuenow"))).toBeGreaterThan(220);
      await separator.focus(); await separator.press("End");
      const max = Number(await separator.getAttribute("aria-valuemax"));
      expect(Number(await separator.getAttribute("aria-valuenow"))).toBe(max);
      const workspaceWidth = await page.locator(".workspace-canvas").evaluate(element => element.getBoundingClientRect().width);
      expect(max).toBeLessThanOrEqual(workspaceWidth * .45);
      await separator.press("ArrowLeft");
      expect(Number(await separator.getAttribute("aria-valuenow"))).toBeLessThan(max);
      await separator.press("Home");
      expect(Number(await separator.getAttribute("aria-valuenow"))).toBe(220);
    });
    await test.step("all actual dark themes/both browser preferences; narrow panes; local source/table overflow", async () => {
      await page.setViewportSize({ width: 400, height: 800 });
      await narrowTabbar(page, backend);
      const panes = page.getByRole("group", { name: "Canvas view" });
      await panes.getByRole("button", { name: "Evidence", exact: true }).click();
      await expect(board).toBeVisible(); await expect(chat).toBeHidden();
      await expect(page.getByRole("separator", { name: "Resize Architect conversation" })).toBeHidden();
      await containment(page, backend, "geometry-400-visible-evidence");
      for (const theme of ["terminai-dark", "slate-grey", "matrix"] as const) for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await backend.theme(page, theme);
        await stableScroll(board, true);
        await measure(page, backend, `narrow-${theme}-browser-${colorScheme}`);
      }
      const findingsOverflow = board.getByRole("region", { name: "Grouped findings; scroll horizontally for all columns" });
      expect(await findingsOverflow.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      const sourcePre = board.locator(".canvas-card").filter({ has: page.getByRole("heading", { name: "Synthetic long execution output", exact: true }) }).locator("pre");
      expect(await sourcePre.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      await sourcePre.evaluate(element => { element.scrollLeft = 200; });
      expect(await sourcePre.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
      await page.screenshot({ path: testInfo.outputPath("narrow-evidence.png") });
      await panes.getByRole("button", { name: "Chat", exact: true }).click();
      await expect(chat).toBeVisible(); await expect(board).toBeHidden();
      await page.screenshot({ path: testInfo.outputPath("narrow-chat.png") });
    });
    await test.step("existing Workflows gate, Deny-first focus, denial-only IPC, late final and return focus", async () => {
      await send(page, backend, "Synthetic approval-denial exercise; never execute.");
      await backend.channel(page, backend.dispatches.at(-1)!.onEvent, {
        type: "iac_approval_request", thread_id: "synthetic-workflow-denial", tool: "cisco_workflows_apply", command: "POST /v1/workflows/create", working_dir: "Cisco Workflows",
        classification: { tier: "high", params: { method: "POST", path: "/v1/workflows/create", body: { name: "Synthetic only" }, organization_id: "synthetic-org", rationale: "Synthetic only" }, rationale: "Synthetic only", target_org_id: "synthetic-org" },
      });
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Deny", exact: true })).toBeFocused();
      await expect(dialog).toContainText("POST"); await expect(dialog).toContainText("/v1/workflows/create");
      await dialog.getByRole("button", { name: "Deny", exact: true }).press("Enter");
      await expect.poll(() => backend.resumes.length).toBe(1);
      await expect(dialog).toHaveCount(0);
      await backend.final(page, "Synthetic denial acknowledged; no mutation performed.", String(backend.resumes[0].onEvent));
      await expect(page.getByRole("heading", { name: "Network Architect conversation", exact: true })).toBeFocused();
      expect(backend.resumes.map(item => item.decision)).toEqual(["deny"]);
    });
    await test.step("keyboard close inactive Canvas, surviving focus, reopen without automatic execution", async () => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole("button", { name: "Select Canvas investigation Synthetic investigation B", exact: true }).click();
      await expect(board.getByRole("heading", { name: "Synthetic investigation B", exact: true })).toBeVisible();
      const count = backend.dispatches.length;
      const close = page.getByRole("button", { name: "Close Canvas investigation Synthetic investigation A", exact: true });
      await close.focus(); await close.press("Enter");
      await expect(page.getByRole("button", { name: "Select Canvas investigation Synthetic investigation B", exact: true })).toBeFocused();
      await page.getByRole("combobox", { name: "Saved investigations", exact: true }).selectOption(firstId);
      await expect(board.getByRole("heading", { name: "Synthetic investigation A", exact: true })).toBeVisible();
      await expect(chat).toContainText("Synthetic completed summary.");
      await expect(board.getByRole("heading", { name: "Interfaces", exact: true })).toBeVisible();
      expect(backend.dispatches).toHaveLength(count);
      expect(backend.resumes).toHaveLength(1);
    });
    await test.step("browser reload plus explicitly synthetic orphan-run normalization; independent saved chat hydration", async () => {
      await send(page, backend, "Synthetic interrupted collection; browser reload surrogate.");
      await expect(board.getByRole("region", { name: "Investigation status" })).toContainText("still collecting");
      const before = copy(backend.workspaces.get(firstId)!.evidence);
      const dispatchCount = backend.dispatches.length;
      const hydrationCount = backend.count("ai_messages_by_tab_agent");
      backend.restartSurrogate(firstId);
      await page.reload();
      await expect(board.getByRole("heading", { name: "Synthetic investigation A", exact: true })).toBeVisible();
      await expect(board.getByRole("region", { name: "Investigation status" })).toContainText("interrupted");
      await expect(board.getByText(/Previous evidence retained unchanged/)).toBeVisible();
      await expect(chat).toContainText("Synthetic completed summary.");
      await expect.poll(() => backend.count("ai_messages_by_tab_agent")).toBeGreaterThan(hydrationCount);
      expect(backend.dispatches).toHaveLength(dispatchCount);
      expect(backend.resumes).toHaveLength(1);
      expect(backend.workspaces.get(firstId)!.evidence).toEqual(before);
      await page.screenshot({ path: testInfo.outputPath("synthetic-reload-interrupted.png") });
    });
    expect(networkDenied).toEqual([]); expect(socketsDenied).toEqual([]); expect(backend.denied).toEqual([]);
    expect(pageErrors).toEqual([]); expect(consoleErrors).toEqual([]);
    expect(createHash("sha256").update(readFileSync(new URL("../../tests/fixtures/copilot_canvas/v1.json", import.meta.url))).digest("hex")).toBe(createHash("sha256").update(fixtureBytes).digest("hex"));
  } finally {
    const receipt = {
      label: "DEVELOPMENT-MODE SYNTHETIC BUNDLE/PREVIEW — not production/native/live acceptance",
      browser: browser.version(), fixtureSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
      commands: Object.fromEntries([...new Set(backend.receipts.map(item => item.command))].map(command => [command, backend.count(command)])),
      dispatches: backend.dispatches.map(item => ({ message: item.message, canvas: item.canvas })), resumes: backend.resumes.map(item => ({ threadId: item.threadId, decision: item.decision })),
      deniedIpc: backend.denied, networkDenied, socketsDenied, consoleErrors, pageErrors, measurements: backend.measurements,
      limitations: ["Synthetic backend persistence/restart surrogates only", "No native DB, startup, PTY, model, vendor or device execution", "Updater skipped by existing DEV guard; untested", "True light app theme unavailable", "Quantitative charts use synthetic data only; no native/model chart publication acceptance"],
    };
    writeFileSync(join(output, "browser-receipts.json"), JSON.stringify(receipt, null, 2));
    // Do not hide an isolation failure behind an earlier UI assertion failure.
    expect.soft(backend.denied, "default-deny IPC").toEqual([]);
    expect.soft(networkDenied, "default-deny non-loopback network").toEqual([]);
    expect.soft(socketsDenied, "default-deny WebSockets").toEqual([]);
    expect.soft(pageErrors, "uncaught browser errors").toEqual([]);
  }
});

test("Canvas final answer — exact completed summary, safe full disclosure, reload and run isolation", async ({ page, context, browser }, testInfo) => {
  const backend = new SyntheticCanvasBackend();
  const isolation = await installSyntheticTransport(page, context, backend);
  const board = page.getByRole("region", { name: "Investigation evidence board" });
  const summary = board.getByRole("region", { name: "Architect’s final answer", exact: true });
  const paragraphs = Array.from({ length: 8 }, (_, index) => `Synthetic retained detail ${index + 1}: inspect the exact evidence, unknown observation window, prerequisites, verification and rollback before considering changes.`);
  const code = '<img src=x onerror="throw 1">\n' + "synthetic-unbroken-source-".repeat(32);
  const response = ["## Synthetic completed conclusion", "**Agent interpretation, not an independently verified diagnosis.** [Synthetic reference](#synthetic-reference)", ...paragraphs,
    "```text\n" + code + "\n```", `![Synthetic retained diagram description](${origin}/)`, '<img src="https://invalid.example/synthetic-only" onerror="throw 1">'].join("\n\n");
  const previewText = ["Synthetic completed conclusion", "Agent interpretation, not an independently verified diagnosis. Synthetic reference", ...paragraphs.slice(0, 2)].join("\n");
  const measurements: unknown[] = [];
  try {
    await page.goto("/");
    await expect.poll(() => backend.count("restore_last_session")).toBe(1);
    await createCanvas(page);
    backend.releaseRestore();
    const firstId = [...backend.workspaces.keys()][0];
    await send(page, backend, "Synthetic completed-answer disclosure and ownership check only.");
    const firstChannel = backend.dispatches.at(-1)!.onEvent;
    await backend.channel(page, firstChannel, { type: "thought_start", step: 1, thought: "Synthetic private intermediate thought — never a final answer." });
    await backend.channel(page, firstChannel, { type: "token", text: "Synthetic streaming draft — never a final answer." });
    await expect(page.locator(".agent-messages")).toContainText("Synthetic streaming draft — never a final answer.");
    await expect(summary).toHaveCount(0);
    const material = backend.materialize();
    const findings = material.cards.find(card => card.type === "findings")!;
    const secondRef = (path: string) => ({ evidence_id: material.snapshots[1].evidence_id, path });
    findings.source_refs.push(secondRef("/devices/0"));
    findings.metadata.findings.push({ ...findings.metadata.findings[0], device: secondRef("/devices/0/id"), interface: secondRef("/devices/0/interface"),
      symptom: "Synthetic second source group finding", supporting_refs: [secondRef("/devices/0/errors")] });
    await backend.card(page, findings, material.snapshots);
    await backend.event(page, "warning", { limitation: "Synthetic source unavailable: authentication failure; coverage remains unknown." });
    await expect(summary).toHaveCount(0);
    await backend.final(page, response);
    await expect(summary).toBeVisible();
    await expect(summary.locator(".canvas-answer-excerpt")).toHaveText(previewText);
    await expect(summary).toContainText("not independently verified");
    await expect(summary.getByText("Opening excerpt — complete opening paragraphs", { exact: true })).toBeVisible();
    await expect(summary.locator(".canvas-answer-excerpt").getByRole("heading", { level: 4, name: "Synthetic completed conclusion", exact: true })).toBeVisible();
    await expect.poll(() => backend.messages.filter(message => message.tab_id === firstId && message.role === "assistant").map(message => message.content)).toEqual([response]);
    const full = summary.getByRole("region", { name: "Full final answer; scroll horizontally for wide content", exact: true });
    const disclosure = summary.locator("details");
    await expect(disclosure).not.toHaveAttribute("open");
    await expect(full).toBeHidden();
    await summary.getByText("Read full answer", { exact: true }).focus();
    await summary.getByText("Read full answer", { exact: true }).press("Enter");
    await expect(disclosure).toHaveAttribute("open", "");
    await expect(full.getByRole("heading", { level: 4, name: "Synthetic completed conclusion", exact: true })).toBeVisible();
    await expect(summary.locator(".canvas-answer-excerpt h1, .canvas-answer-excerpt h2, .canvas-answer-body h1, .canvas-answer-body h2")).toHaveCount(0);
    await expect(full.getByText("Synthetic retained diagram description", { exact: true })).toBeVisible();
    await expect(full.locator("strong")).toHaveText("Agent interpretation, not an independently verified diagnosis.");
    for (const paragraph of paragraphs) await expect(full.getByText(paragraph, { exact: true })).toBeVisible();
    expect(await full.locator("pre code").textContent()).toBe(code + "\n");
    await expect(summary).not.toContainText("Synthetic private intermediate thought");
    await expect(summary).not.toContainText("Synthetic streaming draft");
    await expect(summary.locator("img, script, iframe")).toHaveCount(0);
    await summary.getByText("Read full answer", { exact: true }).press("Enter");
    for (const width of [1440, 1280, 400]) {
      await page.setViewportSize({ width, height: 1000 });
      if (width === 400) await page.getByRole("group", { name: "Canvas view" }).getByRole("button", { name: "Evidence", exact: true }).click();
      for (const theme of ["terminai-dark", "slate-grey", "matrix"] as const) {
        await backend.theme(page, theme);
        await stableScroll(board, true);
        const geometry = await summary.evaluate(element => {
          const box = element.getBoundingClientRect();
          const status = element.parentElement!.querySelector('[aria-label="Investigation status"]')!.getBoundingClientRect();
          const linkColors = Array.from(element.querySelectorAll('a[href="#synthetic-reference"]'), link => getComputedStyle(link).color);
          const accentColor = getComputedStyle(element.querySelector("details > summary")!).color;
          return { width: innerWidth, pageWidth: document.documentElement.scrollWidth, left: box.left, right: box.right, bottom: box.bottom, statusTop: status.top, linkColors, accentColor };
        });
        measurements.push({ theme, ...geometry });
        expect(geometry.linkColors).toEqual([geometry.accentColor, geometry.accentColor]);
        expect(geometry.pageWidth).toBeLessThanOrEqual(width);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(width);
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.statusTop);
        await page.screenshot({ path: testInfo.outputPath(`answer-${width}-${theme}.png`) });
      }
    }
    await summary.getByText("Read full answer", { exact: true }).click();
    await full.scrollIntoViewIfNeeded();
    const codeRegion = full.locator("pre");
    expect(await codeRegion.evaluate(element => element.scrollWidth)).toBeGreaterThan(await codeRegion.evaluate(element => element.clientWidth));
    await codeRegion.evaluate(element => { element.scrollLeft = element.scrollWidth; });
    expect(await codeRegion.evaluate(element => Math.abs(element.scrollWidth - element.clientWidth - element.scrollLeft))).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400);
    await page.screenshot({ path: testInfo.outputPath("answer-full-400.png") });
    await summary.getByText("Read full answer", { exact: true }).click();
    const warning = board.getByText("Synthetic source unavailable: authentication failure; coverage remains unknown.", { exact: true });
    await warning.scrollIntoViewIfNeeded(); await expect(warning).toBeVisible();
    const filter = board.getByRole("textbox", { name: "Find findings", exact: true });
    await filter.fill("switch-b");
    const filteredGroup = board.locator(".canvas-group");
    await expect(filteredGroup.locator("span")).toHaveText("switch-b · Source group 2");
    await expect(filteredGroup.locator("summary")).toHaveAccessibleName("Full source reference — Source group 2");
    await filteredGroup.getByText("Full source reference — Source group 2", { exact: true }).focus();
    await filteredGroup.getByText("Full source reference — Source group 2", { exact: true }).press("Enter");
    await expect(filteredGroup.locator("code")).toHaveText(JSON.stringify([material.snapshots[1].evidence_id, "/devices/0/id"]));
    await page.screenshot({ path: testInfo.outputPath("answer-filtered-source-group2.png") });
    await filter.fill("");
    await expect(board.locator(".canvas-group span")).toHaveText(["switch-a · Source group 1", "switch-b · Source group 2"]);
    const group = board.locator(".canvas-group").first();
    await expect(group.locator("details")).not.toHaveAttribute("open");
    await group.getByText("Full source reference — Source group 1", { exact: true }).focus();
    await group.getByText("Full source reference — Source group 1", { exact: true }).press("Enter");
    await expect(group.locator("details")).toHaveAttribute("open", "");
    await expect(group.locator("code")).toHaveText(JSON.stringify([material.snapshots[0].evidence_id, "/devices/0/id"]));
    const runStatus = board.getByRole("region", { name: "Investigation status" });
    await runStatus.getByText("Run details", { exact: true }).click();
    await expect(runStatus).toContainText(backend.workspaces.get(firstId)!.runs.at(-1)!.started_at);
    await board.getByRole("button", { name: /^Inspect Check link health/ }).click();
    await expect(board.getByRole("heading", { name: "Unknowns", exact: true })).toBeVisible();
    await expect(board.getByText("Recommendation — not executed", { exact: true })).toBeVisible();
    await board.getByRole("button", { name: /Back to findings/ }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await createCanvas(page);
    await page.getByLabel("Investigation title", { exact: true }).fill("Synthetic summary B");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(board.getByRole("heading", { name: "Synthetic summary B", exact: true })).toBeVisible();
    await expect(summary).toHaveCount(0);
    await send(page, backend, "Synthetic other-workspace completion must stay in its own bucket.");
    const foreignChannel = backend.dispatches.at(-1)!.onEvent;
    await backend.final(page, "Synthetic stale final must not replace the completed answer.", firstChannel);
    await expect(summary).toHaveCount(0);
    await backend.channel(page, foreignChannel, { type: "token", text: "Synthetic foreign workspace draft." });
    await page.getByRole("combobox", { name: "Saved investigations", exact: true }).selectOption(firstId);
    const foreignResponse = "Synthetic completed foreign workspace answer — isolated from investigation A. " + "Synthetic long first-paragraph detail remains available in full. ".repeat(12);
    await backend.final(page, foreignResponse, foreignChannel);
    await expect(summary.locator(".canvas-answer-excerpt")).toHaveText(previewText);
    await expect(summary).not.toContainText(foreignResponse);
    await page.getByRole("button", { name: "Select Canvas investigation Synthetic summary B", exact: true }).click();
    await expect(summary.getByText("Bounded preview — read full answer for complete context and instructions", { exact: true })).toBeVisible();
    const boundedPreview = await summary.locator(".canvas-answer-excerpt").textContent();
    expect(boundedPreview!.length).toBeGreaterThan(0);
    expect(boundedPreview!.length).toBeLessThanOrEqual(480);
    expect(foreignResponse.startsWith(boundedPreview!)).toBe(true);
    await stableScroll(board, true);
    await page.screenshot({ path: testInfo.outputPath("answer-bounded-preview.png") });
    await summary.getByText("Read full answer", { exact: true }).click();
    await expect(full).toHaveText(foreignResponse);
    await send(page, backend, "Synthetic failed foreign follow-up must hide its completed answer.");
    const failedChannel = backend.dispatches.at(-1)!.onEvent;
    await backend.channel(page, failedChannel, { type: "error", message: "Synthetic failure; no completed answer." });
    await backend.final(page, "Synthetic late failed final must not appear.", failedChannel);
    await expect(runStatus).toContainText("failed");
    await expect(summary).toHaveCount(0);
    await page.getByRole("combobox", { name: "Saved investigations", exact: true }).selectOption(firstId);
    await expect(summary.locator(".canvas-answer-excerpt")).toHaveText(previewText);
    await expect.poll(() => backend.messages.filter(message => message.role === "assistant").map(message => message.content)).toEqual([response, foreignResponse]);
    const frozenEvidence = JSON.stringify(backend.workspaces.get(firstId));
    const frozenDispatchCount = backend.dispatches.length;
    backend.messages.push({ id: "synthetic-old-answer", tab_id: firstId, agentId: "network-architect", role: "assistant", content: "Synthetic old saved answer outside this run.", timestamp: 0 });
    backend.messages.push({ id: "synthetic-foreign-answer", tab_id: "synthetic-foreign-workspace", agentId: "network-architect", role: "assistant", content: "Synthetic foreign saved answer must stay isolated.", timestamp: Date.now() + 1 });
    const hydrationCount = backend.count("ai_messages_by_tab_agent");
    backend.restartSurrogate(firstId);
    // The new browser realm creates new Channel queues starting at index zero.
    backend.channelIndices.clear();
    await page.reload();
    await expect.poll(() => backend.count("ai_messages_by_tab_agent")).toBeGreaterThan(hydrationCount);
    await expect(summary.locator(".canvas-answer-excerpt")).toHaveText(previewText);
    await expect(summary.locator("details")).not.toHaveAttribute("open");
    await summary.getByText("Read full answer", { exact: true }).click();
    for (const paragraph of paragraphs) await expect(full.getByText(paragraph, { exact: true })).toBeVisible();
    expect(await full.locator("pre code").textContent()).toBe(code + "\n");
    await expect(summary).not.toContainText("Synthetic old saved answer");
    await expect(summary).not.toContainText("Synthetic foreign saved answer");
    expect(JSON.stringify(backend.workspaces.get(firstId))).toBe(frozenEvidence);
    expect(backend.dispatches).toHaveLength(frozenDispatchCount);
    await stableScroll(board, true);
    await page.screenshot({ path: testInfo.outputPath("answer-completed-reload.png") });
    await send(page, backend, "Synthetic same-workspace failed follow-up hides the previous completed summary.");
    await expect(summary).toHaveCount(0);
    await backend.channel(page, backend.dispatches.at(-1)!.onEvent, { type: "error", message: "Synthetic latest run failed; prior evidence is not refreshed." });
    await expect(runStatus).toContainText("failed");
    await expect(summary).toHaveCount(0);
    expect(backend.dispatches).toHaveLength(4);
    expect(backend.resumes).toHaveLength(0);
  } finally {
    writeFileSync(join(process.env.CANVAS_E2E_OUTPUT!, "answer-receipts.json"), JSON.stringify({
      label: "SYNTHETIC real-App completed final answer and saved-history reload — not native/model acceptance",
      browser: browser.version(), responseSha256: createHash("sha256").update(response).digest("hex"), measurements,
      commands: Object.fromEntries([...new Set(backend.receipts.map(item => item.command))].map(command => [command, backend.count(command)])),
      ...isolation, deniedIpc: backend.denied,
    }, null, 2));
    expect.soft(backend.denied).toEqual([]); expect.soft(isolation.networkDenied).toEqual([]);
    expect.soft(isolation.socketsDenied).toEqual([]); expect.soft(isolation.pageErrors).toEqual([]); expect.soft(isolation.consoleErrors).toEqual([]);
  }
});

test("Canvas quantitative charts — exact source order, plotted values, accessible tooltips and reload", async ({ page, context, browser }, testInfo) => {
  const backend = new SyntheticCanvasBackend();
  const isolation = await installSyntheticTransport(page, context, backend);
  const board = page.getByRole("region", { name: "Investigation evidence board" });
  const measurements: unknown[] = [];
  const hoverMeasurements: unknown[] = [];
  const sourceMeasurements: unknown[] = [];
  const points = [
    { label: "Duplicate", value: 0 }, { label: "Duplicate", value: -2.5 },
    { label: "1", value: 1.5 }, { label: 1, value: -1.25 },
    { label: "Synthetic-long-label-" + "x".repeat(180), value: 3 },
    { label: '<img src=x onerror="throw 1">', value: 2.25 },
  ];
  const extremePoints = [{ label: "Finite minimum", value: -1e308 }, { label: "Finite maximum", value: 1e308 }];
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect.poll(() => backend.count("restore_last_session")).toBe(1);
    await createCanvas(page);
    backend.releaseRestore();
    await send(page, backend, "Synthetic chart values and interactions only; no device execution.");
    const firstId = [...backend.workspaces.keys()][0];
    const material = backend.materialize();
    const template = material.cards.find(card => card.type === "chart")!;
    const snapshot: EvidenceSnapshot = { ...material.snapshots[0], evidence_id: `${template.run_id}-chart-values`,
      origin: "agent_authored", source: { helper: "synthetic-chart-only" }, data: { points, extremePoints } };
    const ref = (path: string) => ({ evidence_id: snapshot.evidence_id, path });
    const cards = (["bar", "line"] as const).map(form => ({ ...template,
      card_id: `${template.run_id}-chart-${form}`, title: `Synthetic ${form} source order`, source_refs: [ref("/points")],
      metadata: { form, x_label: "Synthetic label", y_label: "Synthetic delta",
        points: points.map((_, index) => ({ label: ref(`/points/${index}/label`), value: ref(`/points/${index}/value`) })) },
    }));
    const rangeCard = { ...template, card_id: `${template.run_id}-chart-extreme-span`, title: "Synthetic finite range limitation",
      source_refs: [ref("/extremePoints")], metadata: { form: "bar" as const, x_label: "Synthetic label", y_label: "Synthetic delta",
        points: extremePoints.map((_, index) => ({ label: ref(`/extremePoints/${index}/label`), value: ref(`/extremePoints/${index}/value`) })) } };
    const allCards = [...cards, rangeCard];
    for (const card of allCards) await backend.card(page, card, [snapshot]);
    await backend.final(page, "Synthetic charts completed; source order and exact values retained.");
    await expect.poll(() => backend.workspaces.get(firstId)!.runs.at(-1)!.status).toBe("completed");
    for (const card of cards) {
      const source = board.getByRole("region", { name: `${card.title} source values`, exact: true });
      await expect(source.locator("thead th")).toHaveText(["Synthetic label", "Synthetic delta"]);
      await expect(source.locator("tbody th")).toHaveText(points.map(point => String(point.label)));
      await expect(source.locator("tbody td")).toHaveText(points.map(point => String(point.value)));
    }
    const rangeSource = board.getByRole("region", { name: `${rangeCard.title} source values`, exact: true });
    const rangeSurface = board.locator(".canvas-card").filter({ has: page.getByRole("heading", { name: rangeCard.title, exact: true }) });
    await expect(rangeSource.locator("tbody th")).toHaveText(extremePoints.map(point => point.label));
    await expect(rangeSource.locator("tbody td")).toHaveText(extremePoints.map(point => String(point.value)));
    await expect(rangeSurface.getByRole("note")).toHaveText("Chart range cannot be plotted safely; exact source values are shown below.");
    await expect(rangeSurface.locator("svg")).toHaveCount(0);
    await expect(board.locator("img, script, iframe")).toHaveCount(0);
    for (const card of cards) {
      const chart = board.getByRole("region", { name: `${card.title} chart`, exact: true });
      const svg = chart.getByRole("application", { name: `${card.title}: Synthetic delta by Synthetic label`, exact: true });
      const source = board.getByRole("region", { name: `${card.title} source values`, exact: true });
      await expect(chart).toHaveAccessibleDescription(/Tab to the chart; use Left and Right arrows to inspect values/);
      await expect(chart.getByRole("img")).toHaveCount(0);
      await page.mouse.move(0, 0);
      await source.focus();
      await source.press("Shift+Tab");
      await expect(svg).toBeFocused();
      const tooltip = chart.locator('.recharts-default-tooltip[role="status"]');
      for (const [index, point] of points.entries()) {
        if (index > 0) await svg.press("ArrowRight");
        await expect(tooltip).toBeVisible();
        await expect(tooltip.locator(".recharts-tooltip-label")).toHaveText(String(point.label));
        await expect(tooltip.locator(".recharts-tooltip-item-value")).toHaveText(String(point.value));
      }
      await svg.press("ArrowLeft");
      await expect(tooltip.locator(".recharts-tooltip-label")).toHaveText(String(points[4].label));
      await expect(tooltip.locator(".recharts-tooltip-item-value")).toHaveText(String(points[4].value));
      await page.mouse.move(0, 0);
      const marks = chart.locator(card.metadata.form === "bar" ? ".recharts-bar-rectangle" : ".recharts-line-dot");
      await expect(marks).toHaveCount(points.length);
      for (const [index, point] of points.entries()) {
        if (card.metadata.form === "bar" && point.value === 0) {
          await expect(marks.nth(index).locator("path")).toHaveCount(0);
          continue;
        }
        await chart.scrollIntoViewIfNeeded();
        const box = await marks.nth(index).boundingBox();
        expect(box).not.toBeNull();
        // Native pointer pixels are integral; aim within each dot, toward the plot interior at its edges.
        const pointer = { x: Math.round(box!.x + box!.width / 2) + (card.metadata.form === "line" ? index === 0 ? 1 : index === points.length - 1 ? -1 : 0 : 0),
          y: Math.round(box!.y + box!.height / 2) + (card.metadata.form === "line" ? Math.sign(point.value) : 0) };
        const [mouseEvent] = await Promise.all([
          page.evaluate(() => new Promise<{ x: number; y: number }>(resolve => document.addEventListener("mousemove", event => resolve({ x: event.clientX, y: event.clientY }), { once: true }))),
          page.mouse.move(pointer.x, pointer.y),
        ]);
        hoverMeasurements.push({ form: card.metadata.form, index, point, box, pointer, mouseEvent,
          hit: await chart.evaluate((element, pointer) => {
            const hit = document.elementFromPoint(pointer.x, pointer.y);
            const svg = element.querySelector("svg")!.getBoundingClientRect();
            const wrapper = element.querySelector<HTMLElement>(".recharts-wrapper")!;
            const bounds = wrapper.getBoundingClientRect();
            return { target: hit?.outerHTML.slice(0, 500), insideChart: !!hit && element.contains(hit),
              svg: { x: svg.x, y: svg.y, width: svg.width, height: svg.height },
              wrapper: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
              roundedChartPointer: { x: Math.round((pointer.x - bounds.left) / (bounds.width / wrapper.offsetWidth)), y: Math.round((pointer.y - bounds.top) / (bounds.height / wrapper.offsetHeight)) },
              viewport: { width: innerWidth, height: innerHeight } };
          }, mouseEvent) });
        await expect(tooltip, `${card.metadata.form} mouse point ${index}: ${point.label} = ${point.value}`).toBeVisible();
        await expect(tooltip.locator(".recharts-tooltip-label")).toHaveText(String(point.label));
        await expect(tooltip.locator(".recharts-tooltip-item-value")).toHaveText(String(point.value));
      }
    }
    for (const width of [1440, 1280, 400]) {
      await page.setViewportSize({ width, height: 1000 });
      if (width === 400) await page.getByRole("group", { name: "Canvas view" }).getByRole("button", { name: "Evidence", exact: true }).click();
      for (const theme of ["terminai-dark", "slate-grey", "matrix"] as const) {
        await backend.theme(page, theme);
        for (const card of cards) {
          const chart = board.getByRole("region", { name: `${card.title} chart`, exact: true });
          await chart.scrollIntoViewIfNeeded();
          await expect.poll(() => chart.evaluate(element => Math.abs(element.querySelector("svg")!.getBoundingClientRect().width - element.clientWidth))).toBeLessThanOrEqual(1);
          const hoverMark = chart.locator(card.metadata.form === "bar" ? ".recharts-bar-rectangle" : ".recharts-line-dot").nth(1);
          const hoverBox = await hoverMark.boundingBox();
          await page.mouse.move(Math.round(hoverBox!.x + hoverBox!.width / 2), Math.round(hoverBox!.y + hoverBox!.height / 2) - (card.metadata.form === "line" ? 1 : 0));
          const tooltip = chart.locator('.recharts-default-tooltip[role="status"]');
          await expect(tooltip.locator(".recharts-tooltip-label")).toHaveText("Duplicate");
          await expect(tooltip.locator(".recharts-tooltip-item-value")).toHaveText("-2.5");
          const geometry = await chart.evaluate(async (element, form) => {
            const svg = element.querySelector<SVGSVGElement>("svg")!;
            const shapeSignature = () => [...svg.querySelectorAll(".recharts-bar-rectangle path, .recharts-line-curve, .recharts-line-dot")].map(node => ["d", "cx", "cy", "r"].map(name => node.getAttribute(name)));
            const initialShapes = JSON.stringify(shapeSignature());
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            const stableShapes = JSON.stringify(shapeSignature()) === initialShapes;
            const box = svg.getBoundingClientRect();
            const baseline = Number(svg.querySelector(".recharts-reference-line-line")!.getAttribute("y1"));
            const nodes = [...svg.querySelectorAll<SVGGraphicsElement>(form === "bar" ? ".recharts-bar-rectangle" : ".recharts-line-dot")];
            const marks = nodes.map(node => { const r = node.getBBox(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
            const line = svg.querySelector(".recharts-line-curve")?.getAttribute("d") ?? null;
            const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
            const context = canvas.getContext("2d")!;
            const color = (value: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3); };
            const style = getComputedStyle(element);
            const token = (name: string) => color(style.getPropertyValue(name).trim());
            const luminance = (rgb: number[]) => rgb.map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
            const contrast = (a: number[], b: number[]) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
            const surface = token("--surface-1"), accent = token("--accent"), secondary = token("--text-secondary");
            const ink = svg.querySelector(form === "bar" ? ".recharts-bar-rectangle path" : ".recharts-line-curve")!;
            const markColor = color(getComputedStyle(ink).getPropertyValue(form === "bar" ? "fill" : "stroke"));
            const axis = [...svg.querySelectorAll<SVGGraphicsElement>("text")].map(node => {
              const r = node.getBoundingClientRect(), fill = color(getComputedStyle(node).fill);
              return { text: node.textContent, left: r.left - box.left, right: r.right - box.left, top: r.top - box.top, bottom: r.bottom - box.top, fill, contrast: contrast(fill, surface) };
            });
            const tooltip = element.querySelector<HTMLElement>(".recharts-default-tooltip")!;
            const tooltipBox = tooltip.getBoundingClientRect(), tooltipBackground = color(getComputedStyle(tooltip).backgroundColor);
            const tooltipValueColor = color(getComputedStyle(tooltip.querySelector(".recharts-tooltip-item-value")!).color);
            const tooltipLabelColor = color(getComputedStyle(tooltip.querySelector(".recharts-tooltip-label")!).color);
            return { width: innerWidth, pageWidth: document.documentElement.scrollWidth, svg: { left: box.left, right: box.right, width: box.width, height: box.height }, baseline, marks, line,
              accent, secondary, markColor, markContrast: contrast(markColor, surface), axis,
              tooltip: { left: tooltipBox.left, right: tooltipBox.right, background: tooltipBackground, expectedBackground: token("--surface-2"), valueColor: tooltipValueColor, expectedValue: token("--text-primary"), labelColor: tooltipLabelColor,
                valueContrast: contrast(tooltipValueColor, tooltipBackground), labelContrast: contrast(tooltipLabelColor, tooltipBackground) },
              reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, stableShapes,
              activeAnimations: element.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length };
          }, card.metadata.form);
          measurements.push({ theme, form: card.metadata.form, ...geometry });
          expect(geometry.pageWidth).toBeLessThanOrEqual(width);
          expect(geometry.svg.left).toBeGreaterThanOrEqual(0); expect(geometry.svg.right).toBeLessThanOrEqual(width);
          expect(geometry.svg.height).toBe(260); expect(geometry.marks).toHaveLength(points.length);
          expect(geometry.reducedMotion).toBe(true); expect(geometry.activeAnimations).toBe(0); expect(geometry.stableShapes).toBe(true);
          expect(geometry.markColor).toEqual(geometry.accent); expect(geometry.markContrast).toBeGreaterThanOrEqual(3);
          expect(geometry.tooltip.background).toEqual(geometry.tooltip.expectedBackground);
          expect(geometry.tooltip.valueColor).toEqual(geometry.tooltip.expectedValue); expect(geometry.tooltip.labelColor).toEqual(geometry.secondary);
          expect(geometry.tooltip.valueContrast).toBeGreaterThanOrEqual(4.5); expect(geometry.tooltip.labelContrast).toBeGreaterThanOrEqual(4.5);
          expect(geometry.tooltip.left).toBeGreaterThanOrEqual(0); expect(geometry.tooltip.right).toBeLessThanOrEqual(width);
          expect(geometry.axis.length).toBeGreaterThan(0);
          for (const tick of geometry.axis) {
            expect(tick.fill).toEqual(geometry.secondary); expect(tick.contrast).toBeGreaterThanOrEqual(4.5);
            expect(tick.left).toBeGreaterThanOrEqual(-1); expect(tick.right).toBeLessThanOrEqual(geometry.svg.width + 1);
            expect(tick.top).toBeGreaterThanOrEqual(-1); expect(tick.bottom).toBeLessThanOrEqual(geometry.svg.height + 1);
          }
          const nonzero = geometry.marks.map((mark, index) => ({ ...mark, index })).filter(mark => points[mark.index].value !== 0);
          const scale = nonzero[0].height / Math.abs(points[nonzero[0].index].value);
          for (const [index, mark] of geometry.marks.entries()) {
            if (card.metadata.form === "bar" && points[index].value === 0) { expect(mark.height).toBe(0); continue; }
            const cx = mark.x + mark.width / 2, cy = mark.y + mark.height / 2;
            expect(mark.x).toBeGreaterThanOrEqual(0); expect(mark.x + mark.width).toBeLessThanOrEqual(geometry.svg.width);
            expect(mark.y).toBeGreaterThanOrEqual(0); expect(mark.y + mark.height).toBeLessThanOrEqual(geometry.svg.height);
            if (index > 0 && !(card.metadata.form === "bar" && points[index - 1].value === 0)) expect(cx).toBeGreaterThan(geometry.marks[index - 1].x + geometry.marks[index - 1].width / 2);
            if (card.metadata.form === "bar") {
              // SVG getBBox uses float32 coordinates (e.g. 24.0000076 for a nominal 24px bar).
              expect(mark.width).toBeLessThanOrEqual(24 + .001);
              expect(mark.height / Math.abs(points[index].value)).toBeCloseTo(scale, 3);
              expect(points[index].value > 0 ? mark.y + mark.height : mark.y).toBeCloseTo(geometry.baseline, 3);
              expect(points[index].value > 0 ? cy < geometry.baseline : cy > geometry.baseline).toBe(true);
            } else {
              expect(mark.width).toBe(8); expect(mark.height).toBe(8);
              expect(points[index].value === 0 ? Math.abs(cy - geometry.baseline) < .001 : points[index].value > 0 ? cy < geometry.baseline : cy > geometry.baseline).toBe(true);
            }
          }
          if (card.metadata.form === "line") {
            const pathPoints = [...geometry.line!.matchAll(/([ML])\s*([-+\d.eE]+)[, ]+([-+\d.eE]+)/g)].map(match => ({ command: match[1], x: Number(match[2]), y: Number(match[3]) }));
            expect(pathPoints.map(point => point.command)).toEqual(["M", "L", "L", "L", "L", "L"]);
            expect(geometry.line!.match(/[A-Za-z]/g)).toEqual(["M", "L", "L", "L", "L", "L"]);
            const firstNonzero = nonzero[0].index;
            const lineScale = (geometry.baseline - pathPoints[firstNonzero].y) / points[firstNonzero].value;
            for (const [index, point] of pathPoints.entries()) {
              expect(point.x).toBeCloseTo(geometry.marks[index].x + 4, 2); expect(point.y).toBeCloseTo(geometry.marks[index].y + 4, 2);
              expect(point.y).toBeCloseTo(geometry.baseline - points[index].value * lineScale, 2);
            }
          }
          const source = board.getByRole("region", { name: `${card.title} source values`, exact: true });
          const readability = await source.evaluate(element => {
            const header = element.querySelector<HTMLTableCellElement>("thead th:last-child")!;
            const style = getComputedStyle(header);
            const canvas = document.createElement("canvas"), context = canvas.getContext("2d")!;
            context.font = style.font;
            const headerText = header.firstChild!;
            const words = ["Synthetic", "delta"].map(word => {
              const start = headerText.textContent!.indexOf(word), range = document.createRange();
              range.setStart(headerText, start); range.setEnd(headerText, start + word.length);
              return { word, fragments: range.getClientRects().length, minimumWidth: context.measureText(word).width };
            });
            const numbers = [...element.querySelectorAll<HTMLTableCellElement>("tbody td")].map(cell => {
              const range = document.createRange(); range.selectNodeContents(cell);
              return { text: cell.textContent, fragments: range.getClientRects().length, height: range.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(cell).lineHeight) };
            });
            return { headerContentWidth: header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), words, numbers };
          });
          sourceMeasurements.push({ width, theme, form: card.metadata.form, ...readability });
          for (const word of readability.words) {
            expect(word.fragments, `${width}px ${card.metadata.form} header word ${word.word} must not split`).toBe(1);
            expect(readability.headerContentWidth + 1).toBeGreaterThanOrEqual(word.minimumWidth);
          }
          expect(readability.numbers.map(number => number.text)).toEqual(points.map(point => String(point.value)));
          for (const number of readability.numbers) {
            expect(number.fragments, `${width}px ${card.metadata.form} numeric ${number.text} must stay on one line`).toBe(1);
            expect(number.height).toBeLessThanOrEqual(number.lineHeight + 1);
          }
          await source.evaluate(element => { element.scrollLeft = element.scrollWidth; });
          expect(await source.evaluate(element => Math.abs(element.scrollWidth - element.clientWidth - element.scrollLeft))).toBeLessThanOrEqual(1);
          await source.evaluate(element => { element.scrollLeft = 0; });
          await page.screenshot({ path: testInfo.outputPath(`chart-${card.metadata.form}-${width}-${theme}.png`) });
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const frozenWorkspace = JSON.stringify(backend.workspaces.get(firstId));
    const frozenDispatchCount = backend.dispatches.length;
    const frozenSaveCount = backend.count("canvas_save_event");
    expect(backend.workspaces.get(firstId)!.evidence).toEqual([snapshot]);
    expect(backend.workspaces.get(firstId)!.cards).toEqual(allCards);
    backend.restartSurrogate(firstId);
    backend.channelIndices.clear();
    await page.reload();
    for (const card of cards) {
      const source = board.getByRole("region", { name: `${card.title} source values`, exact: true });
      await expect(source.locator("tbody th")).toHaveText(points.map(point => String(point.label)));
      await expect(source.locator("tbody td")).toHaveText(points.map(point => String(point.value)));
    }
    await expect(rangeSource.locator("tbody th")).toHaveText(extremePoints.map(point => point.label));
    await expect(rangeSource.locator("tbody td")).toHaveText(extremePoints.map(point => String(point.value)));
    await expect(rangeSurface.getByRole("note")).toHaveText("Chart range cannot be plotted safely; exact source values are shown below.");
    await expect(rangeSurface.locator("svg")).toHaveCount(0);
    expect(JSON.stringify(backend.workspaces.get(firstId))).toBe(frozenWorkspace);
    expect(backend.count("canvas_save_event")).toBe(frozenSaveCount);
    expect(backend.dispatches).toHaveLength(frozenDispatchCount);
    expect(backend.dispatches).toHaveLength(1);
    expect(backend.resumes).toHaveLength(0);
  } finally {
    writeFileSync(join(process.env.CANVAS_E2E_OUTPUT!, "chart-receipts.json"), JSON.stringify({
      label: "SYNTHETIC real-App quantitative charts — not native/model/vendor publication acceptance",
      browser: browser.version(), points, extremePoints, measurements, hoverMeasurements, sourceMeasurements, ...isolation, deniedIpc: backend.denied,
    }, null, 2));
    expect.soft(backend.denied).toEqual([]); expect.soft(isolation.networkDenied).toEqual([]);
    expect.soft(isolation.socketsDenied).toEqual([]); expect.soft(isolation.consoleErrors).toEqual([]); expect.soft(isolation.pageErrors).toEqual([]);
  }
});

test("Canvas authored relationship graph — real edges, zoom, themes and narrow layout", async ({ page, context, browser }, testInfo) => {
  const backend = new SyntheticCanvasBackend();
  const isolation = await installSyntheticTransport(page, context, backend);
  const board = page.getByRole("region", { name: "Investigation evidence board" });
  const measurements: unknown[] = [];
  try {
    await page.goto("/");
    await expect.poll(() => backend.count("restore_last_session")).toBe(1);
    await createCanvas(page);
    backend.releaseRestore();
    await send(page, backend, "Synthetic authored relationship graph; frozen fixture only.");
    const material = backend.materialize();
    material.snapshots.forEach(snapshot => { snapshot.origin = "agent_authored"; });
    const card = material.cards.find(card => card.type === "topology")!;
    const isolated = { ...material.snapshots[0], evidence_id: `${card.run_id}-isolated-nodes`, data: Array.from({ length: 14 }, (_, index) => `synthetic-node-${index}`) };
    material.snapshots.push(isolated);
    card.metadata.nodes.push(...isolated.data.map((_, index) => ({ id: { evidence_id: isolated.evidence_id, path: `/${index}` } })));
    await backend.card(page, card, material.snapshots);
    await backend.final(page, "Synthetic graph presentation only; no discovery executed.");
    const section = board.locator(".canvas-card").filter({ has: page.getByRole("heading", { name: card.title, exact: true }) });
    const graph = section.getByRole("region", { name: `${card.title} relationship graph` });
    await expect(section.getByText("Agent-authored summary — not independently verified", { exact: true })).toBeVisible();
    await expect(graph.locator(".react-flow__node")).toHaveCount(16);
    await expect(graph.locator(".react-flow__edge-path")).toHaveCount(1);
    await expect(section.getByRole("region", { name: "Agent-authored relationships", exact: true })).toBeVisible();
    await section.getByText("Relationship sources", { exact: true }).click();
    const sources = section.locator("details").filter({ has: page.getByText("Relationship sources", { exact: true }) });
    await expect(sources).toContainText("Agent-authored — not observed");
    await expect(sources).toContainText('"from": "switch-a"');
    const viewport = graph.locator(".react-flow__viewport");
    const before = await viewport.getAttribute("style");
    const zoom = graph.getByRole("button", { name: "Zoom Out", exact: true });
    await zoom.focus();
    await zoom.press("Enter");
    await expect.poll(() => viewport.getAttribute("style")).not.toBe(before);
    for (const width of [1440, 400]) {
      await page.setViewportSize({ width, height: 1000 });
      if (width === 400) await page.getByRole("group", { name: "Canvas view" }).getByRole("button", { name: "Evidence", exact: true }).click();
      for (const theme of ["terminai-dark", "slate-grey", "matrix"] as const) {
        await backend.theme(page, theme);
        await graph.scrollIntoViewIfNeeded();
        await expect.poll(() => graph.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          return [...element.querySelectorAll(".react-flow__node")].every(node => {
            const rect = node.getBoundingClientRect();
            return rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
          });
        }), { message: "All supplied nodes remain inside the resized graph" }).toBe(true);
        const geometry = await graph.evaluate(element => {
          const rect = element.getBoundingClientRect();
          const path = element.querySelector<SVGPathElement>(".react-flow__edge-path")!;
          return { width: rect.width, height: rect.height, contentHeight: parseFloat(getComputedStyle(element).height), left: rect.left, right: rect.right,
            path: path.getAttribute("d"), edgeLength: path.getTotalLength(),
            pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
        });
        expect(geometry.contentHeight).toBe(360);
        expect(geometry.height).toBe(362); // Content height plus the two 1px borders.
        expect(geometry.width).toBeGreaterThan(0);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(width);
        expect(geometry.pageWidth).toBeLessThanOrEqual(width);
        expect(geometry.edgeLength).toBeGreaterThan(0);
        expect(geometry.path).toMatch(/^M/);
        measurements.push({ width, theme, ...geometry });
        await graph.screenshot({ path: testInfo.outputPath(`graph-${width}-${theme}.png`) });
      }
    }
    expect(backend.dispatches).toHaveLength(1);
    expect(backend.resumes).toHaveLength(0);
  } finally {
    writeFileSync(join(process.env.CANVAS_E2E_OUTPUT!, "graph-receipts.json"), JSON.stringify({
      label: "SYNTHETIC real-App graph rendering — not native/model/vendor acceptance",
      browser: browser.version(), measurements, ...isolation, deniedIpc: backend.denied,
    }, null, 2));
    expect.soft(backend.denied).toEqual([]);
    expect.soft(isolation.networkDenied).toEqual([]);
    expect.soft(isolation.socketsDenied).toEqual([]);
    expect.soft(isolation.pageErrors).toEqual([]);
    expect.soft(isolation.consoleErrors).toEqual([]);
  }
});

test("Canvas long findings and 18 by 6 inventory retain readable table columns", async ({ page, context, browser }, testInfo) => {
  const backend = new SyntheticCanvasBackend();
  const isolation = await installSyntheticTransport(page, context, backend);
  const board = page.getByRole("region", { name: "Investigation evidence board" });
  const measurements: unknown[] = [];
  try {
    await page.goto("/");
    await expect.poll(() => backend.count("restore_last_session")).toBe(1);
    await createCanvas(page);
    backend.releaseRestore();
    await send(page, backend, "Synthetic table readability only; no device data or execution.");
    const material = backend.materialize();
    const inventoryData: Record<string, JsonValue>[] = Array.from({ length: 18 }, (_, index) => ({
      switch: `Synthetic-Switch-${index + 1}`, model: "LAB-SWITCH-48P", serial: `TEST-SERIAL-${index + 1}`,
      status: "available", firmware: "Synthetic firmware 1.2.3",
      notes: index === 0 ? null : index === 1 ? false : index === 2 ? 0 : index === 17 ? '<img src=x onerror="throw 1">' + "x".repeat(320) : "Synthetic inventory note",
    }));
    const snapshot: EvidenceSnapshot = { ...material.snapshots[0], evidence_id: `${material.cards[0].run_id}-readability`, origin: "agent_authored",
      data: { findings: Array.from({ length: 11 }, (_, index) => ({ device: `Synthetic-Switch-${index + 1}`, interface: `Gi1/0/${index + 1}` })), inventory: inventoryData } };
    const ref = (path: string) => ({ evidence_id: snapshot.evidence_id, path });
    const findings = material.cards.find(card => card.type === "findings")!;
    const template = findings.metadata.findings[0];
    findings.source_refs = [ref("/findings")];
    findings.metadata.findings = Array.from({ length: 11 }, (_, index) => ({ ...template,
      device: ref(`/findings/${index}/device`), interface: ref(`/findings/${index}/interface`),
      symptom: `Synthetic finding ${index + 1}: a long explanatory recommendation describes the observed mismatch and asks the operator to inspect configuration before considering any change; this prose must wrap between ordinary words.`,
      supporting_refs: [], contradictory_refs: [],
    }));
    const inventory = material.cards.find(card => card.type === "table")!;
    inventory.title = "Synthetic switch inventory (18 switches)";
    inventory.source_refs = [ref("/inventory")];
    inventory.metadata.columns = [
      { key: "switch", label: "Switch" }, { key: "model", label: "Model" }, { key: "serial", label: "Serial" },
      { key: "status", label: "Cloud status" }, { key: "firmware", label: "Firmware" }, { key: "notes", label: "Notes" },
    ];
    inventory.metadata.rows = inventoryData.map((_, index) => ({ cells: Object.fromEntries(inventory.metadata.columns.map(column => [column.key, ref(`/inventory/${index}/${column.key}`)])) }));
    await backend.card(page, findings, [snapshot]);
    await backend.card(page, inventory, [snapshot]);
    await backend.final(page, "Synthetic readability fixture completed; no network configuration changed.");
    const findingRegion = board.getByRole("region", { name: "Grouped findings; scroll horizontally for all columns" });
    const inventoryRegion = board.getByRole("region", { name: `${inventory.title} source table` });
    await expect(findingRegion.getByRole("button", { name: /^Inspect / })).toHaveCount(11);
    await expect(inventoryRegion.locator("tbody th")).toHaveText(inventoryData.map((_, index) => `Row ${index + 1}`));
    await expect(inventoryRegion.locator("tbody td pre")).toHaveText(inventoryData.flatMap(row => inventory.metadata.columns.map(column => typeof row[column.key] === "string" ? row[column.key] as string : JSON.stringify(row[column.key], null, 2))));
    await expect(board.locator("img")).toHaveCount(0);
    for (const width of [1440, 1280, 400]) {
      await page.setViewportSize({ width, height: 1000 });
      if (width === 400) await page.getByRole("group", { name: "Canvas view" }).getByRole("button", { name: "Evidence", exact: true }).click();
      for (const [name, region] of [["findings", findingRegion], ["inventory", inventoryRegion]] as const) {
        await region.scrollIntoViewIfNeeded();
        const geometry = await region.evaluate(element => {
          const table = element.querySelector("table")!;
          const firstRow = table.querySelector<HTMLTableRowElement>("tbody tr:not(.canvas-group)")!;
          const targets = [...table.tHead!.rows[0].cells, ...firstRow.cells];
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d")!;
          const cells = targets.map(cell => {
            const style = getComputedStyle(cell), box = cell.getBoundingClientRect();
            const words: { word: string; lines: number; naturalWidth: number }[] = [];
            const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const node = walker.currentNode;
              context.font = getComputedStyle(node.parentElement!).font;
              for (const match of node.textContent!.matchAll(/[A-Za-z]{3,}/g)) {
                const range = document.createRange();
                range.setStart(node, match.index!); range.setEnd(node, match.index! + match[0].length);
                words.push({ word: match[0], lines: new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => rect.top)).size, naturalWidth: context.measureText(match[0]).width });
              }
            }
            return { text: cell.textContent, width: box.width, contentWidth: box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
              overflowWrap: style.overflowWrap, wordBreak: style.wordBreak, whiteSpace: style.whiteSpace, words };
          });
          const prose = firstRow.cells[1].firstChild!;
          const proseRange = document.createRange(); proseRange.selectNodeContents(prose);
          return { viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth, containerWidth: element.clientWidth, containerScrollWidth: element.scrollWidth,
            tableWidth: table.getBoundingClientRect().width, tableLayout: getComputedStyle(table).tableLayout, cells,
            proseLines: new Set([...proseRange.getClientRects()].filter(rect => rect.width > 0).map(rect => rect.top)).size };
        });
        measurements.push({ width, name, ...geometry });
        await region.evaluate(element => {
          const board = element.closest(".canvas-board")!;
          board.scrollTop += element.getBoundingClientRect().top - board.getBoundingClientRect().top;
        });
        await page.screenshot({ path: testInfo.outputPath(`readable-${name}-${width}.png`) });
        const compressed = geometry.cells.filter(cell => cell.words.some(word => word.lines !== 1 || word.naturalWidth > cell.contentWidth + 1)).map(({ words, ...cell }) => ({ ...cell, brokenWords: words.filter(word => word.lines !== 1 || word.naturalWidth > cell.contentWidth + 1) }));
        expect.soft(compressed, `${width}px ${name}: ordinary header/control words need their measured natural width, not character wrapping`).toEqual([]);
        if (name === "findings") expect.soft(geometry.proseLines, "Long finding prose must still wrap").toBeGreaterThan(1);
        expect.soft(geometry.pageWidth, "Table overflow must stay inside its scroll region").toBeLessThanOrEqual(width);
        if (width === 400) expect.soft(geometry.containerScrollWidth).toBeGreaterThan(geometry.containerWidth);
        await region.evaluate(element => { element.scrollLeft = element.scrollWidth; });
        expect.soft(await region.evaluate(element => Math.abs(element.scrollWidth - element.clientWidth - element.scrollLeft))).toBeLessThanOrEqual(1);
        await region.evaluate(element => { element.scrollLeft = 0; });
      }
    }
  } finally {
    writeFileSync(join(process.env.CANVAS_E2E_OUTPUT!, "readability-receipts.json"), JSON.stringify({
      label: "SYNTHETIC real-App 11 findings and 18x6 inventory — not native/model/vendor acceptance",
      browser: browser.version(), measurements, ...isolation, deniedIpc: backend.denied,
    }, null, 2));
    expect.soft(backend.denied).toEqual([]);
    expect.soft(isolation.networkDenied).toEqual([]);
    expect.soft(isolation.socketsDenied).toEqual([]);
    expect.soft(isolation.pageErrors).toEqual([]);
    expect.soft(isolation.consoleErrors).toEqual([]);
  }
});

test("focused Canvas containment and independent-scroll regression", async ({ page, context, browser }, testInfo) => {
  const backend = new SyntheticCanvasBackend();
  const isolation = await installSyntheticTransport(page, context, backend);
  const board = page.getByRole("region", { name: "Investigation evidence board" });
  const results: unknown[] = [];
  try {
    await page.goto("/");
    await expect.poll(() => backend.count("restore_last_session")).toBe(1);
    await createCanvas(page);
    backend.releaseRestore();
    await send(page, backend, "Synthetic focused containment diagnostic; frozen fixture only.");
    const material = backend.materialize();
    for (const card of material.cards) await backend.card(page, card, material.snapshots);
    await backend.final(page, "Synthetic focused diagnostic conversation.\n\n" + Array.from({ length: 45 }, (_, i) => `Synthetic paragraph ${i + 1}: scroll measurement text, not a network assertion.`).join("\n\n"));
    await expect(board.getByRole("region", { name: "Investigation status" })).toContainText("completed");
    await expect(board.getByText("Saved evidence", { exact: true })).toBeVisible();
    const interfaces = board.locator(".canvas-card").filter({ has: page.getByRole("heading", { name: "Interfaces", exact: true }) });
    await interfaces.locator("details").getByText("Redacted source", { exact: true }).click();
    await expect(interfaces.locator("details pre")).toHaveText(JSON.stringify((material.snapshots[0].data as { devices: JsonValue[] }).devices, null, 2));
    for (const size of [{ width: 1440, height: 1000 }, { width: 1280, height: 800 }, { width: 400, height: 800 }]) {
      await test.step(`actual containment and scroll-end ${size.width}x${size.height}`, async () => {
        await page.setViewportSize(size);
        if (size.width === 400) {
          await page.getByRole("group", { name: "Canvas view" }).getByRole("button", { name: "Evidence", exact: true }).click();
          await expect(board).toBeVisible();
          await expect(page.locator(".agent-messages")).toBeHidden();
        }
        if (size.width > 400) await independentScroll(page, backend, `focused-${size.width}`);
        // Record all visible containment/scroll-end evidence before the unchanged hard width check.
        const result = await containment(page, backend, `focused-${size.width}`, true);
        results.push(result);
        if (size.width === 400) {
          await overflowDiagnostics(page, backend, `focused-${size.width}`);
          await narrowTabbar(page, backend);
        }
        console.log(JSON.stringify({ viewport: result.viewport, board: result.board, workspace: result.workspace, containingColumn: result.containingColumn, contentParent: result.contentParent, footer: result.footer, visibleBottom: result.visibleBottom, computed: result.computed, lastContent: result.lastContent, scrollTop: result.scrollTop, scrollHeight: result.scrollHeight, clientHeight: result.clientHeight }));
        await page.screenshot({ path: testInfo.outputPath(`containment-${size.width}.png`) });
        await measure(page, backend, `focused-${size.width}`);
      });
    }
    expect(backend.dispatches).toHaveLength(1);
    expect(backend.resumes).toHaveLength(0);
  } finally {
    writeFileSync(join(process.env.CANVAS_E2E_OUTPUT!, "containment-receipts.json"), JSON.stringify({
      label: "DEVELOPMENT-MODE SYNTHETIC BUNDLE/PREVIEW — focused actual geometry; not native/live acceptance",
      browser: browser.version(), fixtureSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
      ...isolation, deniedIpc: backend.denied, commands: Object.fromEntries([...new Set(backend.receipts.map(item => item.command))].map(command => [command, backend.count(command)])),
      measurements: backend.measurements, containment: results,
    }, null, 2));
    expect.soft(backend.denied, "default-deny IPC").toEqual([]);
    expect.soft(isolation.networkDenied, "default-deny non-loopback network").toEqual([]);
    expect.soft(isolation.socketsDenied, "default-deny WebSockets").toEqual([]);
    expect.soft(isolation.pageErrors, "uncaught browser errors").toEqual([]);
    expect.soft(isolation.consoleErrors, "browser console errors").toEqual([]);
  }
});
