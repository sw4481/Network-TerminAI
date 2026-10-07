import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const collector = readFileSync(new URL('../diagnose-windows-monaco-caret.js', import.meta.url), 'utf8');
const dom = new JSDOM(`
  <div class="editor-tab" data-editor-mode="monaco">
    <section class="editor-pane editor-pane--focused">
      <div class="monaco-editor-wrapper">
        <div class="monaco-editor focused" data-model="PRIVATE_MODEL_MARKER" data-path="PRIVATE_PATH_MARKER" data-url="PRIVATE_URL_MARKER">
          <textarea class="inputarea">PRIVATE_EDITOR_TEXT</textarea>
          <div class="cursors-layer"><div class="cursor" style="visibility: hidden"></div></div>
        </div>
      </div>
    </section>
  </div>
`, { runScripts: 'outside-only', pretendToBeVisual: true });
const logs = [];
dom.window.console.log = (label, data) => logs.push({ label, data: JSON.parse(data) });
dom.window.eval(collector);
const input = dom.window.document.querySelector('textarea.inputarea');
input.dispatchEvent(new dom.window.Event('compositionstart', { bubbles: true }));
input.dispatchEvent(new dom.window.Event('focusin', { bubbles: true }));
await new Promise(resolve => dom.window.requestAnimationFrame(resolve));
const csp = new dom.window.Event('securitypolicyviolation');
Object.defineProperty(csp, 'effectiveDirective', { value: 'style-src' });
dom.window.dispatchEvent(csp);

const samples = logs.filter(log => log.label === 'caret-probe').map(log => log.data);
assert.deepEqual(samples.map(sample => sample.phase), ['installed', 'compositionstart', 'focusin']);
assert.equal(samples[0].inlineVisibility, 'hidden');
assert.equal(samples[0].cursorCount, 1);
const fields = ['phase', 'mode', 'documentFocused', 'editorFocused', 'inputActive', 'inputPresent',
  'imeInput', 'cursorCount', 'inlineVisibility', 'visibility', 'display', 'opacity', 'width',
  'height', 'backgroundColor', 'borderColor', 'themeCursor', 'layerVisibility',
  'layerOpacity', 'styleSheetCount'];
for (const sample of samples) assert.deepEqual(Object.keys(sample), fields);
assert.deepEqual(logs.filter(log => log.label === 'caret-csp').map(log => log.data), [{ directive: 'style-src' }]);
const oldEditor = dom.window.document.querySelector('.monaco-editor');
const nextEditor = oldEditor.cloneNode(true);
oldEditor.replaceWith(nextEditor);
dom.window.document.querySelector('.editor-tab').dataset.editorMode = 'zed';
const beforeReinstall = logs.length;
dom.window.eval(collector);
oldEditor.dispatchEvent(new dom.window.Event('pointerup', { bubbles: true }));
nextEditor.dispatchEvent(new dom.window.Event('pointerup', { bubbles: true }));
await new Promise(resolve => dom.window.requestAnimationFrame(resolve));
dom.window.dispatchEvent(csp);
assert.deepEqual(logs.slice(beforeReinstall).map(log => [log.label, log.data.phase ?? log.data.directive]), [
  ['caret-probe', 'installed'], ['caret-probe', 'pointerup'], ['caret-csp', 'style-src'],
]);
assert.deepEqual(logs.slice(beforeReinstall, beforeReinstall + 2).map(log => log.data.mode), ['zed', 'zed']);

nextEditor.remove();
const inactive = dom.window.document.createElement('section');
inactive.className = 'editor-pane';
inactive.innerHTML = '<div class="monaco-editor-wrapper"><div class="monaco-editor"></div></div>';
dom.window.document.querySelector('.editor-tab').prepend(inactive);
const beforeUnavailable = logs.length;
dom.window.eval(collector);
dom.window.dispatchEvent(csp);
assert.deepEqual(logs.slice(beforeUnavailable), [
  { label: 'caret-probe', data: { editorFound: false, focusedEditorUnavailable: true } },
]);
for (const marker of ['PRIVATE_EDITOR_TEXT', 'PRIVATE_MODEL_MARKER', 'PRIVATE_PATH_MARKER', 'PRIVATE_URL_MARKER']) {
  assert.ok(!JSON.stringify(logs).includes(marker), `${marker} must not be exported`);
}
dom.window.close();
console.log('PASS: caret collector reports only the focused editor, disposes prior listeners, and never exports private markers');
