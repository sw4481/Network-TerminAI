// Run: node scripts/tests/topology_interchange.browser.mjs
// Real renderer/Image/canvas/PNG, synthetic save IPC only; no native DB or device access.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = await mkdtemp(join(tmpdir(), "ccie-topology-interchange-"));
const require = createRequire(import.meta.url);
const { createServer } = await import(require.resolve("vite"));
const { chromium, expect } = require("@playwright/test");
// Optional compatible-editor check: serve only the already installed app archive, never fetch an editor.
let editorArchive;
try { editorArchive = await open("/Applications/draw.io.app/Contents/Resources/app.asar", "r"); } catch (error) { if (error.code !== "ENOENT") throw error; }
let editorFiles, editorDataOffset;
if (editorArchive) {
  const header = Buffer.alloc(16); await editorArchive.read(header, 0, 16, 0);
  const json = Buffer.alloc(header.readUInt32LE(12)); await editorArchive.read(json, 0, json.length, 16);
  editorFiles = JSON.parse(json.toString()); editorDataOffset = 8 + header.readUInt32LE(4);
}
async function editorAsset(path) {
  let row = editorFiles;
  for (const part of ("drawio/src/main/webapp/" + path).split("/")) row = row?.files?.[part];
  if (!row || row.files || row.offset === undefined) return null;
  const bytes = Buffer.alloc(row.size); await editorArchive.read(bytes, 0, bytes.length, editorDataOffset + Number(row.offset));
  return bytes;
}
const edge = (protocol, a = "a", b = "b", a_port = "Gi1", b_port = "Eth1") => ({ graph_id: "synthetic", a_device_ref: a, a_port, b_device_ref: b, b_port, protocol, captured_at: 0 });
const snapshot = {
  graph: { id: "synthetic", name: "Offline map", created_at: 1, updated_at: 2 },
  nodes: ["a", "b", "offscreen"].map((ref, i) => ({ graph_id: "synthetic", device_ref: ref,
    label: ref === "a" ? '<core & "α">' : ref === "offscreen" ? "OFFSCREEN — complete long label " + "Ω".repeat(80) : "B — NETCONF",
    device_kind: ["ssh", "netconf", "discovered"][i] })),
  edges: [edge("cdp"), edge("lldp"), edge("cdp", "b", "a", "Eth1", "Gi1"),
    edge("cdp", "a", "a", "loop1", "loop2"), edge("lldp", "a", "a", "loop3", "loop4"),
    edge("bgp", "a", "offscreen", "peer:192.0.2.1", "peer:192.0.2.2")],
  positions: [{ device_ref: "a", x: 0, y: 0 }, { device_ref: "b", x: 700, y: 300 }, { device_ref: "offscreen", x: 4000, y: 700 }],
};
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';
import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';
import {ReactFlow} from '@xyflow/react';
import {NeighborEdge} from '/src/components/topology/NeighborEdge.tsx';
import {NeighborNode} from '/src/components/topology/NeighborNode.tsx';
import {TopologyMap} from '/src/lib/topologyMap.ts';
import {TopologyExport} from '/src/lib/topologyExport.ts';
import '@xyflow/react/dist/style.css';
import '/src/App.css';import '/src/components/topology/InlineTopologyPanel.css';import '/src/components/topology/TopologyTab.css';import '/src/components/topology/TopologyToolbar.css';
mockWindows('main');mockIPC((c,a)=>window.__ipc(c,a instanceof Uint8Array?{bytes:Array.from(a),text:new TextDecoder().decode(a)}:JSON.parse(JSON.stringify(a||{}))));
const original=TopologyExport.toSvg.bind(TopologyExport);
TopologyExport.toSvg=(snapshot,geometry,theme)=>{const result=original(snapshot,geometry,theme);window.__lastSvg={...result,geometry,theme};return result;};
const {TopologyInterchange}=await import('/src/components/topology/TopologyInterchange.tsx');
const snapshot=${JSON.stringify(snapshot)};
const nodes=snapshot.nodes.map(n=>({id:n.device_ref,type:'neighbor',position:snapshot.positions.find(p=>p.device_ref===n.device_ref),data:{label:n.label,vendor:'unknown',deviceKind:n.device_kind,deviceRef:n.device_ref,isSource:false}}));
createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,
React.createElement(TopologyInterchange,{snapshot,visibleNodes:snapshot.nodes.slice(0,2),visibleEdges:snapshot.edges.filter(e=>e.b_device_ref!=='offscreen')}),
React.createElement('div',{className:'topology-tab__canvas actual',style:{width:1000,height:800}},React.createElement(ReactFlow,{defaultNodes:nodes,defaultEdges:TopologyMap.links(snapshot.edges,null),nodeTypes:{neighbor:NeighborNode},edgeTypes:{default:NeighborEdge},onlyRenderVisibleElements:false,proOptions:{hideAttribution:true}}))));`;
const server = await createServer({
  configFile: join(root, "vite.config.ts"), root, mode: "test", clearScreen: false, cacheDir: join(out, "vite-cache"),
  server: { host: "127.0.0.1", port: 1438, strictPort: true, open: false },
  plugins: [{
    name: "topology-measurement-regression",
    resolveId(id) { if (id === "/__p3.js") return "\0measurement.js"; },
    load(id) { if (id === "\0measurement.js") return entry; },
    configureServer(vite) {
      if (editorArchive) vite.middlewares.use("/__drawio", async (request, response, next) => {
        try {
          const path = new URL(request.url, "http://127.0.0.1").pathname.slice(1);
          let bytes = await editorAsset(path);
          if (!bytes) { response.statusCode = 404; response.end(); return; }
          // Bootstrap the installed Graph/mxCodec engine explicitly, without desktop/cloud startup or user files.
          if (path === "index.html") bytes = Buffer.from(bytes.toString().replaceAll("App.main();", "window.__editorLoaded = true;"));
          const ext = path.split(".").at(-1);
          response.setHeader("Content-Security-Policy", "default-src 'self' data:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:");
          response.setHeader("Content-Type", ({ html: "text/html", js: "text/javascript", css: "text/css", xml: "application/xml", svg: "image/svg+xml", png: "image/png", gif: "image/gif", json: "application/json" })[ext] ?? "application/octet-stream");
          response.end(bytes);
        } catch (error) { next(error); }
      });
      vite.middlewares.use("/__measurement", async (_request, response, next) => {
        try {
          const html = await vite.transformIndexHtml("/__measurement", '<!doctype html><html data-theme="slate-grey"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="img-src &#39;self&#39; data:"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Measurement Check</title></head><body><div id="root"></div><script type="module" src="/__p3.js"></script></body></html>');
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
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } }), saved = [], binaries = [], errors = [], denied = [], external = [];
  let cancel = false, failWrite = false;
  await page.exposeFunction("__ipc", (command, args) => {
    if (command === "plugin:dialog|save") return cancel ? null : "/synthetic/topology";
    if (command === "plugin:fs|write_text_file") { saved.push(args.text); return null; }
    if (command === "plugin:fs|write_file") { if (failWrite) throw new Error("synthetic disk full"); binaries.push(args.bytes); return null; }
    denied.push(command); throw new Error(`Denied synthetic IPC ${command}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === "http://127.0.0.1:1438") return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  await page.goto("http://127.0.0.1:1438/__measurement");
  await page.getByText('Import & export', { exact: true }).click();
  await expect(page.locator(".actual path[data-protocol]")).toHaveCount(snapshot.edges.length);
  await page.getByRole("button", { name: "Export Draw.io", exact: true }).click();
  await expect.poll(() => saved.length, { timeout: 15000 }).toBe(1);
  const vertices = await page.evaluate((xml) => {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("Invalid export XML");
    return [...doc.querySelectorAll('mxCell[vertex="1"]')].map((cell) => {
      const geometry = cell.querySelector("mxGeometry");
      return { ref: cell.getAttribute("device_ref"), label: cell.getAttribute("value"), x: Number(geometry.getAttribute("x")), width: Number(geometry.getAttribute("width")), height: Number(geometry.getAttribute("height")) };
    });
  }, saved[0]);
  assert.equal(vertices.length, 2);
  assert.equal(vertices.find((v) => v.ref === "a").label.split("\n")[0], '<core & "α">');
  assert(vertices.every((v) => v.width > 0 && v.height > 0));
  await page.getByRole("button", { name: "Export PNG", exact: true }).click();
  await expect.poll(() => binaries.length, { timeout: 15000 }).toBe(1);
  const filtered = await page.evaluate(() => window.__lastSvg);
  assert.equal(filtered.geometry.length, 2); assert(!filtered.svg.includes("OFFSCREEN"));
  assert.deepEqual(binaries[0].slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(join(out, "filtered.png"), Buffer.from(binaries[0]));

  await page.getByLabel("Export scope").selectOption("all");
  await page.getByRole("button", { name: "Export PNG", exact: true }).click();
  await expect.poll(() => binaries.length, { timeout: 15000 }).toBe(2);
  const full = await page.evaluate(() => window.__lastSvg);
  assert.equal(full.geometry.length, 3); assert.equal(full.geometry.find((v) => v.device_ref === "offscreen").x, 4000);
  assert(full.svg.includes(snapshot.nodes[2].label)); assert(full.svg.includes("Routing adjacency (unverified)"));
  assert(full.width > filtered.width); assert(full.width < 16384);
  const paths = await page.evaluate((svg) => {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    return { exported: [...doc.querySelectorAll("path[data-protocol]")].map((p) => p.getAttribute("d")).sort(), actual: [...document.querySelectorAll(".actual path[data-protocol]")].map((p) => p.getAttribute("d")).sort() };
  }, full.svg);
  assert.equal(paths.exported.length, 6); assert.equal(new Set(paths.exported).size, 6);
  assert.deepEqual(paths.exported, paths.actual, "export cubic paths must exactly match actual NeighborEdge renderer handles/curves");

  const pixels = await page.evaluate(async ({ bytes, source }) => {
    const image = new Image(); image.src = "data:image/png;base64," + btoa(bytes.map((byte) => String.fromCharCode(byte)).join("")); await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
    const background = [...context.getImageData(0, 0, 1, 1).data];
    const dom = new DOMParser().parseFromString(source.svg, "image/svg+xml");
    const svg = document.importNode(dom.documentElement, true); svg.style.cssText = "position:fixed;visibility:hidden"; document.body.appendChild(svg);
    const [vx, vy] = svg.getAttribute("viewBox").split(" ").map(Number);
    const swatch = document.createElement("canvas"); swatch.width = 1; swatch.height = 1;
    const swatchContext = swatch.getContext("2d");
    const region = (x, y, width, height, inkColor) => {
      const sx = Math.max(0, Math.floor(x - vx)), sy = Math.max(0, Math.floor(y - vy));
      const w = Math.min(canvas.width - sx, Math.max(1, Math.ceil(width))), h = Math.min(canvas.height - sy, Math.max(1, Math.ceil(height)));
      const data = context.getImageData(sx, sy, w, h).data;
      let changed = 0, opaque = 0, ink = 0;
      swatchContext.fillStyle = inkColor ?? source.theme.muted; swatchContext.fillRect(0, 0, 1, 1);
      const target = swatchContext.getImageData(0, 0, 1, 1).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3]) opaque++;
        if (data[i + 3] && (data[i] !== background[0] || data[i + 1] !== background[1] || data[i + 2] !== background[2])) changed++;
        if (data[i + 3] && [0, 1, 2].every((channel) => Math.abs(data[i + channel] - target[channel]) < 20)) ink++;
      }
      return { changed, opaque, ink, total: w * h };
    };
    const labels = [...svg.querySelectorAll("text")].map((text) => {
      const b = text.getBBox();
      if (b.x < vx || b.y < vy || b.x + b.width > vx + canvas.width || b.y + b.height > vy + canvas.height) throw new Error("Clipped SVG label bounds");
      return { text: text.textContent, ...region(b.x, b.y, b.width, b.height, text.getAttribute("fill")) };
    });
    const edges = [...svg.querySelectorAll("path[data-protocol]")].map((path) => {
      const p = path.getPointAtLength(path.getTotalLength() * 0.25);
      return { protocol: path.getAttribute("data-protocol"), ...region(p.x - 3, p.y - 3, 6, 6) };
    });
    const offscreen = source.geometry.find((node) => node.device_ref === "offscreen");
    const offscreenPixels = region(offscreen.x, offscreen.y, offscreen.width, offscreen.height);
    svg.remove(); return { width: image.width, height: image.height, background, labels, edges, offscreenPixels };
  }, { bytes: binaries[1], source: full });
  assert.equal(pixels.width, full.width); assert.equal(pixels.height, full.height); assert.equal(pixels.background[3], 255);
  assert(pixels.edges.every((edge) => edge.changed > 0), "every full-scope curve must have visible actual PNG pixels");
  assert(pixels.labels.every((label) => label.ink > 0), "every node and edge label must have foreground-colour PNG ink, not merely its background");
  assert(pixels.labels.find((label) => label.text === snapshot.nodes[2].label).changed > 100);
  assert(pixels.offscreenPixels.changed > 100); assert.equal(pixels.offscreenPixels.opaque, pixels.offscreenPixels.total);
  await writeFile(join(out, "full.png"), Buffer.from(binaries[1]));
  await writeFile(join(out, "full.svg"), full.svg);
  await writeFile(join(out, "topology.drawio"), saved[0]);
  await writeFile(join(out, "pixel-evidence.json"), JSON.stringify({ filtered: { width: filtered.width, height: filtered.height }, full: { width: full.width, height: full.height }, pixels, paths }, null, 2));
  await page.screenshot({ path: join(out, "workspace.png") });
  await expect(page.locator(".topology-interchange__measurement")).toHaveCount(0);
  cancel = true;
  await page.getByRole("button", { name: "Export PNG", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("cancelled; no file saved");
  assert.equal(binaries.length, 2);
  cancel = false; failWrite = true;
  await page.getByRole("button", { name: "Export PNG", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("synthetic disk full");
  assert.equal(binaries.length, 2); assert.deepEqual(errors, []); assert.deepEqual(denied, []); assert.deepEqual(external, []);
  if (editorArchive) {
    await page.getByRole("button", { name: "Export Draw.io", exact: true }).click();
    await expect.poll(() => saved.length).toBe(2);
    await writeFile(join(out, "full.drawio"), saved[1]);
    const editor = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const editorExternal = [], editorErrors = [];
    editor.on("pageerror", (error) => editorErrors.push(error.message));
    editor.on("request", (request) => { if (!request.url().startsWith("http://127.0.0.1:1438") && !request.url().startsWith("data:")) editorExternal.push(request.url()); });
    const deadline = setTimeout(() => { void editor.close(); }, 20000);
    await editor.goto("http://127.0.0.1:1438/__drawio/index.html?offline=1&stealth=1&local=1");
    await editor.waitForFunction(() => window.__editorLoaded && typeof Graph === "function" && typeof mxCodec === "function");
    const acceptance = await editor.evaluate((xml) => {
      document.getElementById("geInfo")?.remove();
      const container = document.createElement("div"); container.style.cssText = "position:absolute;inset:0"; document.body.appendChild(container);
      const graph = new Graph(container);
      const doc = mxUtils.parseXml(xml), model = graph.getModel();
      new mxCodec(doc).decode(doc.getElementsByTagName("mxGraphModel")[0], model);
      const cells = Object.values(model.cells), vertices = cells.filter((cell) => cell.vertex), edges = cells.filter((cell) => cell.edge);
      const before = vertices.map((cell) => ({ id: cell.id, label: graph.convertValueToString(cell), x: cell.geometry.x, y: cell.geometry.y,
        width: cell.geometry.width, height: cell.geometry.height, editable: graph.isCellEditable(cell), movable: graph.isCellMovable(cell) }));
      const routes = edges.map((cell) => ({ id: cell.id, source: cell.source?.id, target: cell.target?.id, editable: graph.isCellEditable(cell), points: cell.geometry.points?.map((p) => ({ x: p.x, y: p.y })) }));
      const moved = vertices[0], oldX = moved.geometry.x, changed = moved.geometry.clone(); changed.x += 37;
      model.setGeometry(moved, changed); model.setValue(moved, "Independent edit accepted");
      const independent = moved.geometry.x === oldX + 37 && vertices.slice(1).every((cell) => cell.geometry.x === before.find((row) => row.id === cell.id).x) && edges.every((cell, index) => cell.source.id === routes[index].source && cell.target.id === routes[index].target);
      graph.fit(30);
      return { vertices: before, edges: routes, independent };
    }, saved[1]);
    assert.equal(acceptance.vertices.length, 3); assert.equal(acceptance.edges.length, 6); assert(acceptance.independent);
    assert(acceptance.vertices.every((row) => row.editable && row.movable)); assert(acceptance.edges.every((row) => row.editable));
    assert(acceptance.vertices.some((row) => row.x === 4000 && row.y === 700));
    assert.deepEqual(editorErrors, []); assert.deepEqual(editorExternal, []);
    await editor.screenshot({ path: join(out, "installed-drawio-editor.png") });
    await writeFile(join(out, "installed-drawio-evidence.json"), JSON.stringify(acceptance, null, 2));
    clearTimeout(deadline);
    await editor.close();
  }
  console.log(`PASS: real Image/canvas PNG, exact renderer cubic paths, parallel/reversed/self/logical edges, full/filtered offscreen labels and opaque text ink, native binary IPC/cancel/errors, native-compatible image CSP, no external requests; installed offline Draw.io Graph/mxCodec ${editorArchive ? "editable-cell check passed (not native desktop UI)" : "unavailable (not fetched)"}. Evidence: ${out}`);
} finally {
  await browser?.close();
  await server.close();
  await editorArchive?.close();
}
