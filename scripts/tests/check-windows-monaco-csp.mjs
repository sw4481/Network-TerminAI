import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const nonce = 'synthetic-fixture-nonce';
const base = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const windows = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.windows.conf.json', import.meta.url), 'utf8'));
const baseSecurity = base.app.security;
const baseCsp = baseSecurity.csp;
assert.deepEqual(Object.keys(windows), ['app']);
assert.deepEqual(Object.keys(windows.app), ['security']);
assert.deepEqual(Object.keys(windows.app.security), ['csp']);
const override = windows.app.security.csp;
assert.deepEqual(Object.keys(override).sort(), ['connect-src', 'style-src-attr', 'style-src-elem']);
assert.equal(baseSecurity.dangerousDisableAssetCspModification, false);
assert.equal(baseCsp['style-src-attr'], undefined, 'base/mac policy must remain unchanged');
assert.equal(baseCsp['style-src-elem'], undefined, 'base/mac policy must remain unchanged');
assert.deepEqual(override['connect-src'].split(/\s+/), [
  ...baseCsp['connect-src'].split(/\s+/), 'http://ipc.localhost',
]);
const policies = {
  baseline: baseCsp,
  attrOnly: { ...baseCsp, 'style-src-attr': override['style-src-attr'] },
  corrected: { ...baseCsp, ...override },
};
for (const policy of Object.values(policies)) {
  assert.equal(policy['script-src'], baseCsp['script-src'], 'Windows must not relax scripts');
}

class FixtureServer {
  constructor(assets) {
    this.assets = assets;
    this.server = createServer((request, response) => {
      const asset = this.assets.get(request.url);
      if (!asset) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': asset.type, 'Content-Security-Policy': asset.csp ?? "default-src 'self'; script-src 'self'" });
      response.end(asset.content);
    });
  }

  async start() {
    await new Promise((done, fail) => {
      this.server.once('error', fail);
      this.server.listen(0, '127.0.0.1', done);
    });
    return `http://127.0.0.1:${this.server.address().port}`;
  }

  async close() {
    if (this.server.listening) await new Promise((done, fail) => this.server.close(error => error ? fail(error) : done()));
  }
}

const entry = `
  import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
  import { applyMonacoTheme, ZED_ONE_DARK_THEME_ID } from './src/theme/monacoThemes.ts';
  applyMonacoTheme(monaco, ZED_ONE_DARK_THEME_ID);
  window.fixtureEditor = monaco.editor.create(document.getElementById('editor'), {
    value: 'scratch', language: 'plaintext', theme: ZED_ONE_DARK_THEME_ID,
    cursorBlinking: 'solid', minimap: { enabled: false }, automaticLayout: false,
  });
  window.fixtureEditor.focus();
  window.fixtureReady = true;
`;

const bundle = await build({
  stdin: { contents: entry, resolveDir: root, sourcefile: 'synthetic-caret-fixture.js', loader: 'js' },
  bundle: true, write: false, outdir: '/fixture-output', entryNames: 'fixture',
  format: 'esm', platform: 'browser', target: 'chrome120',
  logLevel: 'silent',
});
const javascript = bundle.outputFiles.find(file => basename(file.path.replaceAll('\\', '/')) === 'fixture.js');
const stylesheet = bundle.outputFiles.find(file => basename(file.path.replaceAll('\\', '/')) === 'fixture.css');
assert.ok(javascript && stylesheet, 'Monaco JS and CSS must both be bundled');

const assets = new Map([
  ['/fixture.js', { type: 'text/javascript', content: javascript.contents }],
  ['/fixture.css', { type: 'text/css', content: Buffer.concat([
    stylesheet.contents, Buffer.from('\n#editor { width: 800px; height: 400px; }\n'),
  ]) }],
]);
const server = new FixtureServer(assets);
let browser;
try {
  const origin = await server.start();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const [name, policy] of Object.entries(policies)) {
    const csp = Object.entries(policy).map(([directive, sources]) =>
      `${directive} ${sources}${directive === 'style-src' || directive === 'script-src' ? ` 'nonce-${nonce}'` : ''}`,
    ).join('; ');
    assets.set(`/${name}`, {
      type: 'text/html', csp,
      content: `<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body>
        <div id="editor"></div><button id="outside">Outside</button>
        <script type="module" nonce="${nonce}" src="/fixture.js"></script></body></html>`,
    });
    const context = await browser.newContext();
    try {
      await context.route('**/*', route =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      const page = await context.newPage();
      await page.goto(`${origin}/${name}`);
      await page.waitForFunction(() => window.fixtureReady === true);
      const cursor = page.locator('.monaco-editor .cursors-layer > .cursor').first();
      await cursor.waitFor({ state: 'attached' });
      const focused = await page.evaluate(() => {
        const editor = document.querySelector('.monaco-editor');
        const element = editor.querySelector('.cursors-layer > .cursor');
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return {
          inputFocused: document.activeElement === editor.querySelector('textarea.inputarea'),
          editorFocused: editor.classList.contains('focused'),
          background: style.backgroundColor,
          themeCursor: getComputedStyle(editor).getPropertyValue('--vscode-editorCursor-foreground').trim(),
          width: box.width, height: box.height, visibility: style.visibility,
        };
      });
      assert.equal(focused.inputFocused, true, `${name}: Monaco input must have focus`);
      assert.equal(focused.editorFocused, true, `${name}: Monaco must report focus`);
      if (name === 'corrected') {
        assert.equal(focused.background, 'rgb(82, 139, 255)', 'Zed cursor paint must apply');
        assert.equal(focused.themeCursor.toLowerCase(), '#528bff', 'Zed theme variable must apply');
        assert.ok(focused.width > 0 && focused.height > 0, 'cursor must have visible geometry');
        assert.equal(focused.visibility, 'visible');
        await page.keyboard.press('End');
        const before = await page.evaluate(() => ({
          column: window.fixtureEditor.getPosition().column,
          left: document.querySelector('.monaco-editor .cursors-layer > .cursor').getBoundingClientRect().left,
        }));
        assert.equal(before.column, 8, 'synthetic scratch caret must start at the end');
        await page.keyboard.type('XYZ');
        await page.waitForFunction(left => window.fixtureEditor.getModel().getValue() === 'scratchXYZ'
          && window.fixtureEditor.getPosition().column === 11
          && document.querySelector('.monaco-editor .cursors-layer > .cursor').getBoundingClientRect().left > left,
        before.left);
        const typed = await page.evaluate(() => {
          const editor = document.querySelector('.monaco-editor');
          const cursor = editor.querySelector('.cursors-layer > .cursor');
          const style = getComputedStyle(cursor);
          const box = cursor.getBoundingClientRect();
          return {
            inputFocused: document.activeElement === editor.querySelector('textarea.inputarea'),
            editorFocused: editor.classList.contains('focused'),
            column: window.fixtureEditor.getPosition().column,
            left: box.left, width: box.width, height: box.height,
            background: style.backgroundColor, visibility: style.visibility,
            themeCursor: getComputedStyle(editor).getPropertyValue('--vscode-editorCursor-foreground').trim(),
          };
        });
        assert.equal(typed.inputFocused, true, 'Monaco input must stay focused while typing');
        assert.equal(typed.editorFocused, true, 'Monaco editor must stay focused while typing');
        assert.equal(typed.column, before.column + 3, 'typing must advance the caret');
        assert.ok(typed.left > before.left, 'painted caret must move right while typing');
        assert.equal(typed.background, 'rgb(82, 139, 255)', 'Zed cursor paint must persist while typing');
        assert.equal(typed.themeCursor.toLowerCase(), '#528bff', 'Zed theme variable must persist while typing');
        assert.ok(typed.width > 0 && typed.height > 0, 'typing caret must keep visible geometry');
        assert.equal(typed.visibility, 'visible', 'typing caret must stay visible');
      } else {
        assert.equal(focused.background, 'rgba(0, 0, 0, 0)', `${name}: theme paint must remain blocked`);
        assert.equal(focused.themeCursor, '', `${name}: theme CSS must remain blocked`);
      }
      await page.locator('#outside').click();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.monaco-editor .cursors-layer > .cursor')).visibility === 'hidden');
      const blockedScript = await page.evaluate(async () => {
        window.syntheticUnnoncedScriptRan = false;
        const script = document.createElement('script');
        script.textContent = 'window.syntheticUnnoncedScriptRan = true';
        document.head.appendChild(script);
        await new Promise(resolve => setTimeout(resolve, 50));
        return window.syntheticUnnoncedScriptRan;
      });
      assert.equal(blockedScript, false, `${name}: unnonced inline scripts must remain blocked`);
      const outcome = {
        baseline: 'EXPECTED missing paint under nonce-bearing base policy',
        attrOnly: 'EXPECTED theme paint blocked with attribute-only override',
        corrected: 'RESTORED Zed cursor paint and synthetic typing/caret advance with checked-in Windows override',
      }[name];
      console.log(`PASS ${name}: ${outcome}; focus/blur preserved; inline script denied`);
    } finally {
      await context.close();
    }
  }
} finally {
  try {
    await browser?.close();
  } finally {
    await server.close();
  }
}
