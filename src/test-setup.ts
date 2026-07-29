import '@testing-library/jest-dom/vitest';

// jsdom polyfills for browser APIs that ReactFlow v12 (and likely future
// graph/canvas tests) touch during init. Each polyfill is guarded so it
// won't override a real DOM impl if the runtime ever provides one.

if (typeof globalThis.ResizeObserver === "undefined") {
  // ReactFlow v12 invokes `new ResizeObserver(...)` during init; jsdom
  // does not provide one. A no-op shim is sufficient because our unit
  // tests don't assert on ReactFlow-computed layout — only on rendered
  // DOM (the inline panel asserts on store-derived node attributes, and
  // the data-protocol contract is verified by mounting the custom edge
  // component directly).
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
}

if (typeof globalThis.DOMMatrixReadOnly === "undefined") {
  // ReactFlow reads element bounding boxes via DOMMatrixReadOnly during
  // pre-render; jsdom doesn't ship one. The minimal shim below
  // satisfies the props ReactFlow inspects.
  (globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly =
    class {
      m22 = 1;
      constructor(_t?: string) {}
    };
}
