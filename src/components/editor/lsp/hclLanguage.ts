import type * as Monaco from "monaco-editor";

/** Language id matching `detect_language` in editor.rs (".tf" -> "hcl"). */
export const HCL_LANGUAGE_ID = "hcl";

/**
 * Register a lightweight HCL/Terraform Monarch grammar. Monaco ships no HCL
 * language, so `.tf` files would otherwise render as plaintext. Idempotent —
 * safe to call on every editor mount.
 */
export function registerHclLanguage(monaco: typeof Monaco): void {
  const already = monaco.languages
    .getLanguages()
    .some((l) => l.id === HCL_LANGUAGE_ID);
  if (already) return;

  monaco.languages.register({ id: HCL_LANGUAGE_ID, extensions: [".tf", ".hcl", ".tfvars"] });

  monaco.languages.setLanguageConfiguration(HCL_LANGUAGE_ID, {
    comments: { lineComment: "#", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
  });

  monaco.languages.setMonarchTokensProvider(HCL_LANGUAGE_ID, {
    keywords: [
      "resource", "variable", "module", "output", "provider", "data",
      "locals", "terraform", "for_each", "count", "depends_on", "true",
      "false", "null", "var", "local", "if", "for", "in",
    ],
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/<<[-~]?\s*"?(\w+)"?/, { token: "string.heredoc", next: "@heredoc" }],
        [/"/, "string", "@string"],
        [/\$\{/, "delimiter.interpolation", "@interp"],
        [/\b\d+(\.\d+)?\b/, "number"],
        [
          /[a-zA-Z_]\w*/,
          { cases: { "@keywords": "keyword", "@default": "identifier" } },
        ],
        [/[{}()\[\]]/, "@brackets"],
        [/[=,.]/, "delimiter"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
      string: [
        [/\$\{/, "delimiter.interpolation", "@interp"],
        [/[^"\\$]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, "string", "@pop"],
      ],
      interp: [
        [/\}/, "delimiter.interpolation", "@pop"],
        [/"/, "string", "@string"],
        [/\b\d+(\.\d+)?\b/, "number"],
        [/[+\-*/%<>=!&|?:]/, "operator"],
        [/[a-zA-Z_]\w*/, "variable"],
        [/[.\[\](),]/, "delimiter"],
      ],
      heredoc: [
        [/^\s*\w+\s*$/, "string.heredoc", "@pop"],
        [/.*$/, "string.heredoc"],
      ],
    },
  } as Monaco.languages.IMonarchLanguage);
}
