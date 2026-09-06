import type * as Monaco from "monaco-editor";
import { ciscoLanguageId } from "../../../lib/ciscoLint";

export const CISCO_IOSXE_LANGUAGE_ID = ciscoLanguageId("iosxe");
export const CISCO_NXOS_LANGUAGE_ID = ciscoLanguageId("nxos");

const CISCO_LANGUAGE_IDS = [
  CISCO_IOSXE_LANGUAGE_ID,
  CISCO_NXOS_LANGUAGE_ID,
] as const;

const CISCO_LANGUAGE_CONFIGURATION: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "!" },
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
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  folding: { offSide: true },
  indentationRules: {
    increaseIndentPattern:
      /^\s*(?:interface|router|line|vrf|vlan|address-family|policy-map|class-map)\b/i,
    decreaseIndentPattern: /^\s*(?:exit|end)\s*$/i,
    unIndentedLinePattern: /^\s*!/,
  },
};

const CISCO_MONARCH_LANGUAGE: Monaco.languages.IMonarchLanguage = {
  ignoreCase: true,
  keywords: [
    "aaa",
    "access-list",
    "copy",
    "description",
    "enable",
    "end",
    "exit",
    "feature",
    "hostname",
    "interface",
    "ip",
    "ipv6",
    "logging",
    "neighbor",
    "network",
    "no",
    "ntp",
    "router",
    "show",
    "shutdown",
    "snmp-server",
    "switchport",
    "username",
    "write",
  ],
  modeKeywords: [
    "address-family",
    "class-map",
    "interface",
    "line",
    "policy-map",
    "route-map",
    "router",
    "vlan",
    "vrf",
  ],
  tokenizer: {
    root: [
      [/^\s*!.*$/, "comment"],
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/'(?:[^'\\]|\\.)*'/, "string"],
      [/\$[A-Za-z_][\w.-]*/, "variable"],
      [/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/, "number.address"],
      [
        /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,7}[0-9a-f]{1,4}|::(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{0,4}|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})(?:\/\d{1,3})?(?![\w:])/i,
        "number.address",
      ],
      [
        /\b(?:FastEthernet|GigabitEthernet|TenGigabitEthernet|TwentyFiveGigE|FortyGigabitEthernet|HundredGigE|Ethernet|Port-channel|Loopback|Vlan|Tunnel|Management|mgmt|Fa|Gi|Te|Twe|Fo|Hu|Eth|Po|Lo|Vl|Tu)\d+(?:[/.:-]\d+)*\b/i,
        "type.identifier",
      ],
      [/\b\d+(?:\.\d+)?\b/, "number"],
      [
        /[A-Za-z][\w-]*/,
        {
          cases: {
            "@modeKeywords": "keyword.control",
            "@keywords": "keyword",
            "@default": "identifier",
          },
        },
      ],
    ],
  },
};

export function registerCiscoLanguages(monaco: typeof Monaco): void {
  if (!("languages" in monaco)) return;

  const registered = new Set(monaco.languages.getLanguages().map(({ id }) => id));

  for (const id of CISCO_LANGUAGE_IDS) {
    if (registered.has(id)) continue;

    monaco.languages.register({ id });
    monaco.languages.setLanguageConfiguration(id, CISCO_LANGUAGE_CONFIGURATION);
    monaco.languages.setMonarchTokensProvider(id, CISCO_MONARCH_LANGUAGE);
  }
}
