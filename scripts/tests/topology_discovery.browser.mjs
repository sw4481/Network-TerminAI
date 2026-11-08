// Run: node scripts/tests/topology_discovery.browser.mjs
// Real workspace/renderer; synthetic IPC only. No device access or native DB.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const out = await mkdtemp(join(tmpdir(), "ccie-topology-discovery-"));
const require = createRequire(import.meta.url);
const { createServer } = await import(require.resolve("vite"));
const { chromium, expect } = require("@playwright/test");
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';
import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';
import '/src/App.css';import '/src/components/topology/InlineTopologyPanel.css';
mockWindows('main');mockIPC((c,a)=>window.__ipc(c,JSON.parse(JSON.stringify(a||{}))));
const {useTopologyStore}=await import('/src/state/topologyStore.ts');
const {TopologyTab}=await import('/src/components/topology/TopologyTab.tsx');
const nodes=['a','b'].map((id)=>({graph_id:'view',device_ref:id,label:id,device_kind:'ssh',vendor:'cisco',platform:'iosxe'}));
useTopologyStore.setState({currentGraphId:'view',nodes,edges:[],autoRefreshIntervalMs:null,graphs:[{id:'view',name:'Viewed graph'},{id:'destination',name:'Discovery destination'}],loadGraphs:async()=>{},refresh:async()=>{}});
window.__store=useTopologyStore;const root=createRoot(document.getElementById('root'));
window.__mount=(show)=>root.render(show?React.createElement(TopologyTab,{tabId:'synthetic'}):null);window.__mount(true);`;
const server = await createServer({
  configFile: join(root, "vite.config.ts"), root, mode: "test", clearScreen: false, cacheDir: join(out, "vite-cache"),
  server: { host: "127.0.0.1", port: 1439, strictPort: true, open: false },
  plugins: [{
    name: "topology-discovery-regression",
    resolveId(id) { if (id === "/__p4.js") return "\0discovery.js"; },
    load(id) { if (id === "\0discovery.js") return entry; },
    configureServer(vite) {
      vite.middlewares.use("/__discovery", async (_request, response, next) => {
        try {
          const html = await vite.transformIndexHtml("/__discovery", '<!doctype html><html data-theme="slate-grey"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Discovery Check</title><style>html,body,#root{margin:0;width:100%;height:100%;}</style></head><body><div id="root"></div><script type="module" src="/__p4.js"></script></body></html>');
          response.setHeader("Content-Type", "text/html"); response.end(html);
        } catch (error) { next(error); }
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch(process.platform === "darwin" ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true } : { headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [], consoleErrors = [], denied = [], deniedRequests = [], starts = [];
  const measure = (locator) => locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      box: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop,
      overflowY: style.overflowY, maxHeight: style.maxHeight,
      viewport: { width: innerWidth, height: innerHeight },
      page: { scrollTop: document.scrollingElement.scrollTop, scrollHeight: document.scrollingElement.scrollHeight, scrollWidth: document.scrollingElement.scrollWidth },
    };
  });
  let run = null;
  await page.exposeFunction("__ipc", (command, args) => {
    if (command === "ssh_list_connections") return ["seed", "peer"].map((id, i) => ({ id, name: id, host: `192.0.2.${i + 1}`, port: 22, vendor: "cisco", platform: "iosxe", password_encrypted: null }));
    if (command === "vault_unlocked_ids") return ["synthetic-envelope"];
    if (command === "vault_list_secrets") return [{ id: "synthetic-v3", kind: "snmp_community", label: "Synthetic read-only v3", metadata: { format: "topology-snmp-v1", version: "3" } }, { id: "legacy", kind: "snmp_community", label: "Legacy community", metadata: {} }];
    if (command === "topology_discovery_status") return run;
    if (command === "topology_discovery_start") {
      starts.push(args.request);
      run = { run_id: "owned-run", graph_id: args.request.graph_id, state: "running", max_depth: args.request.max_depth, devices: [], not_dialed: Array.from({ length: 100 }, (_, i) => ({ reference: `not-dialed-${i}`, reason: "No exact saved host match" })), additional_not_dialed: 0, nodes_processed: 1, edges_processed: 1, parser_admission_ms: 25, parser_reply_ms: 40 };
      return run;
    }
    if (command === "topology_discovery_cancel") { assert.equal(args.runId, "owned-run"); run = { ...run, state: "cancelled" }; return run; }
    denied.push(command); throw new Error(`Denied synthetic IPC ${command}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === "http://127.0.0.1:1439") return route.continue();
    deniedRequests.push(route.request().url()); return route.abort();
  });
  await page.goto("http://127.0.0.1:1439/__discovery");
  for (const width of [620, 390, 320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const label of ['Graph tools', 'Import & export']) {
      const summary = page.getByText(label, { exact: true });
      await summary.click();
      const panel = summary.locator('..').locator('.topology-toolbar__panel');
      const bounds = await panel.boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `${label} must fit width ${width}`);
      await page.keyboard.press('Escape');
      await expect(summary).toBeFocused();
    }
  }
  const showFilters = page.getByRole('button', { name: 'Show filters', exact: true });
  if (await showFilters.isVisible()) await showFilters.click();
  await page.getByRole('button', { name: 'Close filters', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show filters', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Show filters', exact: true }).click();
  await page.getByText('Import & export', { exact: true }).click();
  const importOpener = page.getByRole('button', { name: 'Import JSON', exact: true });
  await importOpener.click();
  await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
  await expect(importOpener).toBeFocused();
  await page.getByText('Import & export', { exact: true }).click();
  await page.getByRole("button", { name: "Discover devices", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Discover topology" });
  await expect(dialog.getByRole("combobox", { name: "Discovery scope" })).toHaveValue("0");
  const routing = dialog.getByRole("checkbox", { name: "Include routing observations (BGP/OSPF/IS-IS/EIGRP)", exact: true });
  await expect(routing).not.toBeChecked();
  await routing.check();
  await dialog.getByRole("combobox", { name: "Destination graph" }).selectOption("destination");
  await dialog.getByTestId("discovery-device-seed").getByRole("checkbox").check();
  await dialog.getByRole("combobox", { name: "Discovery scope" }).selectOption("1");
  await dialog.getByRole("checkbox", { name: "Allow follow-up to peer" }).check();
  await dialog.getByRole("button", { name: "Discover (1)", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Enter temporary passwords");
  await dialog.getByLabel("Password for seed").fill("synthetic-only");
  await dialog.getByLabel("Password for peer").fill("synthetic-only");
  await page.setViewportSize({ width: 390, height: 844 });
  const modalBox = await dialog.boundingBox();
  assert(modalBox.x >= 0 && modalBox.x + modalBox.width <= 391 && modalBox.height <= 844);
  await page.screenshot({ path: join(out, "modal-narrow.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Discover (1)", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh topology', exact: true })).toBeFocused();
  const report = page.getByRole("region", { name: "Discovery run", exact: true });
  await expect(report).toContainText("Discovery destination");
  assert.equal(starts[0].include_routing, true);
  assert.equal(starts.length, 1); assert.deepEqual(starts[0].seed_ids, ["seed"]); assert.deepEqual(starts[0].eligible_ids, ["seed", "peer"]); assert.equal(starts[0].max_depth, 1);
  assert.equal(await page.evaluate(() => window.__store.getState().currentGraphId), "view");
  assert(!await page.evaluate(() => JSON.stringify(window.__store.getState()).includes("synthetic-only")));
  await report.getByText("Device outcomes and neighbors not dialed", { exact: true }).click();
  const skipped = report.getByText('Neighbors not dialed (100)', { exact: true });
  await expect(skipped.locator('..')).not.toHaveAttribute('open', '');
  await skipped.click();
  const reportMetrics = await measure(report.locator('.topology-discovery-report__content'));
  assert(reportMetrics.box.height <= 221);
  assert(reportMetrics.scrollHeight > reportMetrics.clientHeight, 'bounded report details retain overflow scrolling');
  await report.getByText('Device outcomes and neighbors not dialed', { exact: true }).click();
  await page.screenshot({ path: join(out, "report-narrow.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole("region", { name: "Topology canvas", exact: true })).toBeVisible();
  await page.screenshot({ path: join(out, "report-desktop.png"), fullPage: true });
  await page.evaluate(() => { window.__mount(false); });
  await expect(report).toHaveCount(0);
  await page.evaluate(() => { window.__store.setState({ discoveryRun: null }); window.__mount(true); });
  await expect(report).toContainText("Discovery running");
  await page.getByRole("button", { name: "Stop discovery", exact: true }).click();
  await expect(report).toContainText("Discovery cancelled");
  await expect(page.getByRole("button", { name: "Stop discovery", exact: true })).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.__store.getState().currentGraphId), "view");
  await page.getByRole("button", { name: "Discover devices", exact: true }).click();
  await expect(routing).not.toBeChecked();
  await expect(dialog.getByRole("combobox", { name: "Discovery scope" })).toHaveValue("0");
  await dialog.getByTestId("discovery-device-seed").getByRole("checkbox").check();
  await expect(dialog.getByLabel("Password for seed")).toHaveValue("");
  await dialog.getByRole("combobox", { name: "Collection method" }).selectOption("snmp_v3");
  await expect(dialog.getByLabel("Password for seed")).toHaveCount(0);
  await expect(routing).toBeDisabled();
  const profile = dialog.getByRole("combobox", { name: "Unlocked SNMP profile" });
  await expect(profile.getByRole("option", { name: "Synthetic read-only v3" })).toHaveCount(1);
  await expect(profile.getByRole("option", { name: "Legacy community" })).toHaveCount(0);
  await profile.selectOption("synthetic-v3");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(out, "snmp-modal-narrow.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Discover (1)", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal(starts[1].collection_mode, "snmp_v3");
  assert.equal(starts[1].snmp_secret_id, "synthetic-v3");
  assert.equal(starts[1].include_routing, false);
  assert.deepEqual(starts[1].passwords, {});
  await page.getByRole("button", { name: "Stop discovery", exact: true }).click();
  await expect(report).toContainText("Discovery cancelled");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => window.__store.setState({ captureEvidence: [{
    source_ref: 'a', protocol: 'bgp', source_command: 'show ip bgp summary', attempted_at: 1793966400, status: 'failed',
    observations: [{ captured_at: 1793880000, in_latest_capture: true, record: {
      protocol: 'bgp', local_port: '', neighbor_port: '', neighbor_name: '192.0.2.2', neighbor_mgmt_ip: null,
      neighbor_platform: null, neighbor_vendor: null, capabilities: [], routing: {
        state: 'Idle', established: false, peer_address: '192.0.2.2', vrf: 'blue', address_family: 'ipv4 unicast',
        instance: null, level: null, scope_supported: false,
      },
    } }],
  }] }));
  await page.locator('.react-flow__node[data-id="a"]').click();
  const inspector = page.getByTestId('topology-inspector');
  await expect(inspector.getByRole('region', { name: 'Collected evidence' })).toContainText('Historical/unconfirmed');
  await inspector.locator('.topology-inspector__protocol-group').first().locator(':scope > summary').click();
  await inspector.getByText('192.0.2.2', { exact: true }).click();
  await expect(inspector.getByText('Routing state: Idle', { exact: false })).toBeVisible();
  await expect(inspector).toContainText('VRF: blue');
  await expect(inspector).toContainText('Peer address (not management): 192.0.2.2');
  await expect(inspector).toContainText('Address family: ipv4 unicast');
  await expect(inspector).toContainText('Scope supported: no — scope unconfirmed');
  await expect(inspector.getByText('Observed in latest capture — reachability unverified', { exact: true })).toHaveCount(0);
  await page.getByText('Import & export', { exact: true }).click();
  await expect(page.getByText('Collection source/freshness stays local;', { exact: false })).toBeVisible();
  await page.getByText('Import & export', { exact: true }).click();
  const desktopInspector = await measure(inspector);
  assert(desktopInspector.scrollWidth <= desktopInspector.clientWidth + 1, 'desktop inspector must not overflow horizontally');
  await page.screenshot({ path: join(out, 'evidence-desktop.png'), fullPage: true });
  await inspector.getByRole('button', { name: 'Open SSH', exact: true }).scrollIntoViewIfNeeded();
  await expect(inspector.getByRole('button', { name: 'Open SSH', exact: true })).toBeInViewport();
  const desktopInspectorBottom = await measure(inspector);
  assert.equal(desktopInspectorBottom.scrollTop, 0, 'inspector action stays outside the evidence scroller');
  await expect(inspector.getByRole('button', { name: 'Close inspector', exact: true })).toBeInViewport();
  await page.screenshot({ path: join(out, 'evidence-desktop-bottom.png') });
  await inspector.evaluate((element) => { element.scrollTop = 0; });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(inspector).toBeVisible();
  const narrowInspector = await measure(inspector);
  assert(narrowInspector.box.x >= 0 && narrowInspector.box.x + narrowInspector.box.width <= 391, 'inspector must fit narrow viewport horizontally');
  assert(narrowInspector.scrollWidth <= narrowInspector.clientWidth + 1, 'narrow inspector must not overflow horizontally');
  assert(narrowInspector.page.scrollWidth <= 391, 'narrow page must not overflow horizontally');
  await page.screenshot({ path: join(out, 'evidence-narrow.png'), fullPage: true });
  await inspector.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await expect(inspector.getByRole('button', { name: 'Close inspector', exact: true })).toBeInViewport();
  await page.screenshot({ path: join(out, 'evidence-narrow-top.png') });
  await inspector.getByRole('button', { name: 'Open SSH', exact: true }).scrollIntoViewIfNeeded();
  await expect(inspector.getByRole('button', { name: 'Open SSH', exact: true })).toBeInViewport();
  const narrowInspectorBottom = await measure(inspector);
  await page.screenshot({ path: join(out, 'evidence-narrow-bottom.png') });
  await page.evaluate(() => {
    const capture = window.__store.getState().captureEvidence[0];
    window.__store.setState({ captureEvidence: [{ ...capture, observations: Array.from({ length: 12 }, (_, index) => ({ ...capture.observations[0], record: { ...capture.observations[0].record, neighbor_name: `synthetic-peer-${index}` } })) }] });
  });
  await expect(inspector.getByText('synthetic-peer-11', { exact: true })).toHaveCount(1);
  const narrowManyObservations = await measure(inspector);
  assert(narrowManyObservations.scrollWidth <= narrowManyObservations.clientWidth + 1);
  await inspector.getByText('synthetic-peer-11', { exact: true }).scrollIntoViewIfNeeded();
  await expect(inspector.getByText('synthetic-peer-11', { exact: true })).toBeInViewport();
  await inspector.getByRole('button', { name: 'Open SSH', exact: true }).scrollIntoViewIfNeeded();
  await expect(inspector.getByRole('button', { name: 'Open SSH', exact: true })).toBeInViewport();
  const narrowManyObservationsBottom = await measure(inspector);
  await page.screenshot({ path: join(out, 'evidence-narrow-many-bottom.png') });
  const narrowInspectorViewportBounded = narrowManyObservations.box.height <= narrowManyObservations.viewport.height;
  await page.setViewportSize({ width: 620, height: 430 });
  const shortEvidence = await measure(inspector.locator('.topology-inspector__scroll'));
  assert(shortEvidence.clientHeight >= 100, 'short window retains usable evidence scrolling');
  await inspector.getByRole('button', { name: 'Open SSH', exact: true }).scrollIntoViewIfNeeded();
  await expect(inspector.getByRole('button', { name: 'Open SSH', exact: true })).toBeInViewport();
  await page.screenshot({ path: join(out, 'evidence-short.png'), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(denied, []); assert.deepEqual(deniedRequests, []);
  await writeFile(join(out, "verification.json"), JSON.stringify({
    syntheticOnly: true, port: 1439, modalBox, starts: starts.length, reportMetrics,
    boundedReport: true, recoveredRun: true, cancelled: true,
    phase5: { routingOptInForwarded: starts[0].include_routing === true, routingDefaultAndReopenReset: true, temporaryPasswordReset: true,
      failedCaptureNotLatest: true, routingStateAndScopeVisible: true, peerAddressNotManagement: true, localExportNoteVisible: true,
      desktopInspector, desktopInspectorBottom, narrowInspector, narrowInspectorBottom, narrowManyObservations, narrowManyObservationsBottom,
      narrowInspectorViewportBounded, narrowFinalObservationAndActionsReachable: true,
      limitations: narrowInspectorViewportBounded ? [] : ['Narrow inspector has max-height:none; evidence expands page height instead of using a viewport-bounded internal scroller. Final observation and actions remain reachable by page scrolling.'],
    }, errors, consoleErrors, denied, deniedRequests,
  }, null, 2));
  console.log(`PASS (synthetic IPC only): routing opt-in/reset, evidence state/scope and historical freshness, local-export note, discovery scope/destination, bounded report, remount recovery and Stop. Desktop inspector ${desktopInspector.box.width}×${desktopInspector.box.height}, scroll ${desktopInspector.scrollHeight}/${desktopInspector.clientHeight}; narrow inspector ${narrowInspector.box.width}×${narrowInspector.box.height}; 12-observation narrow inspector height ${narrowManyObservations.box.height}, viewport-bounded=${narrowInspectorViewportBounded}, final observation/actions reachable. Evidence: ${out}`);
} finally {
  await browser?.close(); await server.close();
}
