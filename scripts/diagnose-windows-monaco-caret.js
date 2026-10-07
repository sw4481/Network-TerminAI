// Paste into the inspected TerminAI editor WebView2 DevTools Console on a nonsensitive scratch buffer.
// Logs only focus, cursor style/geometry, and CSP directive names; never text, paths, or URLs.
(() => {
  if (typeof window.__terminaiCaretProbeDispose === 'function') window.__terminaiCaretProbeDispose();
  let active = true;
  const unsubscribers = [];
  const dispose = () => {
    active = false;
    for (const unsubscribe of unsubscribers) unsubscribe();
    if (window.__terminaiCaretProbeDispose === dispose) delete window.__terminaiCaretProbeDispose;
  };
  window.__terminaiCaretProbeDispose = dispose;
  const editor = document.querySelector('.editor-pane--focused .monaco-editor-wrapper .monaco-editor');
  if (!editor) {
    console.log('caret-probe', JSON.stringify({ editorFound: false, focusedEditorUnavailable: true }));
    return;
  }
  const input = editor.querySelector('textarea.inputarea');
  const listen = (target, type, handler) => {
    if (!target) return;
    target.addEventListener(type, handler, true);
    unsubscribers.push(() => target.removeEventListener(type, handler, true));
  };
  const sample = phase => {
    const layer = editor.querySelector('.cursors-layer');
    const cursor = layer?.querySelector(':scope > .cursor');
    const style = cursor && getComputedStyle(cursor);
    const layerStyle = layer && getComputedStyle(layer);
    const box = cursor?.getBoundingClientRect();
    console.log('caret-probe', JSON.stringify({
      phase,
      mode: editor.closest('.editor-tab')?.getAttribute('data-editor-mode') ?? null,
      documentFocused: document.hasFocus(),
      editorFocused: editor.classList.contains('focused'),
      inputActive: document.activeElement === input,
      inputPresent: !!input,
      imeInput: input?.classList.contains('ime-input') ?? false,
      cursorCount: layer?.querySelectorAll(':scope > .cursor').length ?? 0,
      inlineVisibility: cursor?.style.visibility ?? null,
      visibility: style?.visibility ?? null,
      display: style?.display ?? null,
      opacity: style?.opacity ?? null,
      width: box?.width ?? null,
      height: box?.height ?? null,
      backgroundColor: style?.backgroundColor ?? null,
      borderColor: style?.borderColor ?? null,
      themeCursor: getComputedStyle(editor).getPropertyValue('--vscode-editorCursor-foreground').trim() || null,
      layerVisibility: layerStyle?.visibility ?? null,
      layerOpacity: layerStyle?.opacity ?? null,
      styleSheetCount: document.styleSheets.length,
    }));
  };
  const later = type => requestAnimationFrame(() => { if (active) sample(type); });
  for (const type of ['focusin', 'focusout', 'pointerup']) {
    listen(editor, type, () => later(type));
  }
  for (const type of ['compositionstart', 'compositionend']) {
    listen(input, type, () => later(type));
  }
  listen(window, 'securitypolicyviolation', event => {
    console.log('caret-csp', JSON.stringify({ directive: event.effectiveDirective }));
  });
  sample('installed');
})();
