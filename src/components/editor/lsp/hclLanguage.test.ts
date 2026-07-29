import { describe, it, expect } from "vitest";
import { registerHclLanguage, HCL_LANGUAGE_ID } from "./hclLanguage";

function makeMonacoMock() {
  const registered: string[] = [];
  const monarchByLang: Record<string, unknown> = {};
  return {
    registered,
    monarchByLang,
    languages: {
      getLanguages: () => registered.map((id) => ({ id })),
      register: ({ id }: { id: string }) => registered.push(id),
      setMonarchTokensProvider: (id: string, def: unknown) => {
        monarchByLang[id] = def;
      },
      setLanguageConfiguration: () => undefined,
    },
  };
}

describe("registerHclLanguage", () => {
  it("registers the hcl language exactly once (idempotent)", () => {
    const m = makeMonacoMock();
    registerHclLanguage(m as never);
    registerHclLanguage(m as never);
    expect(m.registered.filter((id) => id === HCL_LANGUAGE_ID)).toHaveLength(1);
  });

  it("installs a monarch tokenizer with terraform keywords", () => {
    const m = makeMonacoMock();
    registerHclLanguage(m as never);
    const def = m.monarchByLang[HCL_LANGUAGE_ID] as { keywords: string[] };
    expect(def.keywords).toContain("resource");
    expect(def.keywords).toContain("variable");
    expect(def.keywords).toContain("module");
  });

  it("defines tokenizer states for root, string, interp, and heredoc", () => {
    const m = makeMonacoMock();
    registerHclLanguage(m as never);
    const def = m.monarchByLang[HCL_LANGUAGE_ID] as { tokenizer: Record<string, unknown> };
    expect(def.tokenizer).toHaveProperty("root");
    expect(def.tokenizer).toHaveProperty("string");
    expect(def.tokenizer).toHaveProperty("interp");
    expect(def.tokenizer).toHaveProperty("heredoc");
  });
});
