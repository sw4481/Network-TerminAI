import { describe, expect, it } from "vitest";
import { registerCiscoLanguages } from "./ciscoLanguage";

function fakeMonaco() {
  const registered: string[] = [];
  const configByLang: Record<string, unknown> = {};
  const monarchByLang: Record<string, { keywords: string[] }> = {};

  return {
    registered,
    configByLang,
    monarchByLang,
    languages: {
      getLanguages: () => registered.map((id) => ({ id })),
      register: ({ id }: { id: string }) => registered.push(id),
      setLanguageConfiguration: (id: string, config: unknown) => {
        configByLang[id] = config;
      },
      setMonarchTokensProvider: (
        id: string,
        provider: { keywords: string[] },
      ) => {
        monarchByLang[id] = provider;
      },
    },
  };
}

describe("registerCiscoLanguages", () => {
  it("registers both Cisco language ids exactly once", () => {
    const monaco = fakeMonaco();
    registerCiscoLanguages(monaco as never);
    registerCiscoLanguages(monaco as never);
    expect(monaco.registered).toEqual(["cisco-iosxe", "cisco-nxos"]);
  });

  it("configures comments, brackets, and off-side folding", () => {
    const monaco = fakeMonaco();
    registerCiscoLanguages(monaco as never);
    expect(monaco.configByLang["cisco-iosxe"]).toMatchObject({
      comments: { lineComment: "!" },
      folding: { offSide: true },
    });
    expect(monaco.configByLang["cisco-nxos"]).toMatchObject({
      comments: { lineComment: "!" },
    });
  });

  it("tokenizes Cisco comments, commands, interface names, and addresses", () => {
    const monaco = fakeMonaco();
    registerCiscoLanguages(monaco as never);
    expect(monaco.monarchByLang["cisco-iosxe"].keywords).toContain("interface");
  });
});
