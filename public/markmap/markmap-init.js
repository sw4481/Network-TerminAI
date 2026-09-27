/**
 * Markmap inline renderer for the CCIE Terminal DiagramPanel.
 *
 * Loaded as the last <script src> in the markmap srcdoc (after d3.min.js,
 * markmap-view.js and markmap-lib.js, which all merge into window.markmap).
 * Reads the markdown from the non-executed <script type="text/template"> block
 * — the untrusted content never enters a script context — transforms it, and
 * renders the mind-map into the page's <svg>. No inline script is needed, so
 * the document stays clean under a `script-src 'self'` CSP.
 */
(function () {
  function render() {
    try {
      var tpl = document.getElementById("markmap-source");
      var markdown = tpl ? tpl.textContent || "" : "";
      var mm = window.markmap || {};
      var Transformer = mm.Transformer;
      var Markmap = mm.Markmap;
      if (!Transformer || !Markmap) return;
      var transformer = new Transformer();
      var result = transformer.transform(markdown);
      var svg = document.getElementById("markmap-svg");
      Markmap.create(svg, null, result.root);
    } catch (e) {
      var err = document.getElementById("markmap-error");
      if (err) err.textContent = "Failed to render mind-map: " + (e && e.message ? e.message : e);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
