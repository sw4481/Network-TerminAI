/**
 * Minimal browser fixture extracted from the public `Terminal.options` setter
 * in @xterm/xterm@5.5.0/lib/xterm.js. Provenance: the exact CDN artifact
 * TerminAI loads from jsDelivr, SHA-256
 * 1f991ac3b4b283ebf96e60ae23a00a52765dd3a2e46fa6fdda9f1aab032f7495.
 *
 * The real 5.5 bundle creates public accessors over its core options, forbids
 * `cols`/`rows` at the public setter, and assigns each key in `options = {}`
 * through those accessors. This fixture preserves only that deterministic
 * contract so tests do not need the network or the installed 6.x package.
 */
const READONLY_OPTIONS = new Set(["cols", "rows"]);
const PUBLIC_OPTION_KEYS = [
  "cols", "rows", "theme", "fontFamily", "fontSize", "fontWeight",
  "lineHeight", "cursorStyle", "cursorBlink", "convertEol",
  "scrollback", "rightClickSelectsWord", "allowProposedApi",
] as const;

export class Terminal {
  private readonly rawOptions: Record<string, unknown>;
  private readonly publicOptions: Record<string, unknown> = {};
  readonly assigned: string[] = [];

  constructor(initial: Record<string, unknown> = {}) {
    this.rawOptions = { ...initial };
    for (const key of PUBLIC_OPTION_KEYS) {
      Object.defineProperty(this.publicOptions, key, {
        enumerable: true,
        get: () => this.rawOptions[key],
        set: (value: unknown) => {
          if (READONLY_OPTIONS.has(key)) {
            throw new Error(`Option "${key}" can only be set in the constructor`);
          }
          this.assigned.push(key);
          this.rawOptions[key] = value;
        },
      });
    }
  }

  get options(): Record<string, unknown> {
    return this.publicOptions;
  }

  set options(options: Record<string, unknown>) {
    for (const key in options) this.publicOptions[key] = options[key];
  }
}
