import { describe, expect, it } from "vitest";
import { registerCiscoLanguages } from "./ciscoLanguage";

function fakeMonaco() {
  const registered: string[] = [];
  const configByLang: Record<string, unknown> = {};
  const monarchByLang: Record<string, {
    keywords: string[];
    modeKeywords?: string[];
    tokenizer: { root: Array<[RegExp, string | { cases: Record<string, string> }]> };
  }> = {};

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
      setMonarchTokensProvider: (id: string, provider: typeof monarchByLang[string]) => {
        monarchByLang[id] = provider;
      },
    },
  };
}

function tokenize(
  monaco: ReturnType<typeof fakeMonaco>,
  languageId: string,
  line: string,
) {
  const provider = monaco.monarchByLang[languageId];
  const tokens: Array<{ text: string; token: string }> = [];
  let offset = 0;

  while (offset < line.length) {
    const remaining = line.slice(offset);
    const rule = provider.tokenizer.root.find(([pattern]) => {
      const match = new RegExp(pattern.source, pattern.flags.replace("g", "")).exec(remaining);
      return match?.index === 0;
    });

    if (!rule) {
      offset += 1;
      continue;
    }

    const [pattern, action] = rule;
    const match = new RegExp(pattern.source, pattern.flags.replace("g", "")).exec(remaining);
    if (!match || match[0].length === 0) {
      offset += 1;
      continue;
    }

    let token = typeof action === "string" ? action : "identifier";
    if (typeof action !== "string") {
      const word = match[0].toLowerCase();
      token = action.cases[
        provider.modeKeywords?.some((keyword) => keyword.toLowerCase() === word)
          ? "@modeKeywords"
          : provider.keywords.some((keyword) => keyword.toLowerCase() === word)
            ? "@keywords"
            : "@default"
      ];
    }
    tokens.push({ text: match[0], token });
    offset += match[0].length;
  }

  return tokens;
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
    const iosConfig = monaco.configByLang["cisco-iosxe"];
    const nxosConfig = monaco.configByLang["cisco-nxos"];
    expect(iosConfig).toMatchObject({
      comments: { lineComment: "!" },
      brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
      autoClosingPairs: expect.arrayContaining([
        { open: "{", close: "}" },
        { open: '"', close: '"' },
      ]),
      folding: { offSide: true },
      indentationRules: {
        increaseIndentPattern: expect.any(RegExp),
        decreaseIndentPattern: expect.any(RegExp),
        unIndentedLinePattern: expect.any(RegExp),
      },
    });
    expect(nxosConfig).toMatchObject({
      comments: { lineComment: "!" },
      brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
      folding: { offSide: true },
    });
    expect(nxosConfig).toBe(iosConfig);
    expect(monaco.monarchByLang["cisco-nxos"]).toBe(monaco.monarchByLang["cisco-iosxe"]);
  });

  it("tokenizes Cisco comments, commands, interface names, and addresses", () => {
    const monaco = fakeMonaco();
    registerCiscoLanguages(monaco as never);
    expect(tokenize(monaco, "cisco-iosxe", "! captured config")).toContainEqual({
      text: "! captured config",
      token: "comment",
    });
    expect(tokenize(monaco, "cisco-iosxe", "interface GigabitEthernet1/0/1")).toEqual([
      { text: "interface", token: "keyword.control" },
      { text: "GigabitEthernet1/0/1", token: "type.identifier" },
    ]);
    expect(tokenize(monaco, "cisco-iosxe", " ip address 192.0.2.1 255.255.255.0")).toEqual([
      { text: "ip", token: "keyword" },
      { text: "address", token: "identifier" },
      { text: "192.0.2.1", token: "number.address" },
      { text: "255.255.255.0", token: "number.address" },
    ]);
    expect(tokenize(monaco, "cisco-iosxe", " ipv6 address ::1 2001:db8::")).toEqual([
      { text: "ipv6", token: "keyword" },
      { text: "address", token: "identifier" },
      { text: "::1", token: "number.address" },
      { text: "2001:db8::", token: "number.address" },
    ]);
  });
});
