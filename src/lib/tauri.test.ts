import { describe, it, expect } from "vitest";
import {
  extractEnvPlaceholders,
  manifestRequiredEnvKeys,
  type ApiTargetManifest,
} from "./tauri";

describe("extractEnvPlaceholders", () => {
  it("returns [] for null / empty / no placeholders", () => {
    expect(extractEnvPlaceholders(null)).toEqual([]);
    expect(extractEnvPlaceholders(undefined)).toEqual([]);
    expect(extractEnvPlaceholders("")).toEqual([]);
    expect(extractEnvPlaceholders("plain text")).toEqual([]);
  });

  it("extracts a single placeholder", () => {
    expect(extractEnvPlaceholders("${env:MERAKI_API_KEY}")).toEqual([
      "MERAKI_API_KEY",
    ]);
  });

  it("extracts multiple + dedupes", () => {
    expect(
      extractEnvPlaceholders("${env:A}/${env:B}/${env:A}"),
    ).toEqual(["A", "B"]);
  });

  it("ignores ${var:X} and ${response.X.y}", () => {
    expect(
      extractEnvPlaceholders("${var:host}/${response.foo.id}"),
    ).toEqual([]);
  });
});

describe("manifestRequiredEnvKeys", () => {
  const base: ApiTargetManifest = {
    id: "x",
    display_name: "X",
    schema_version: 1,
    base_url: "https://api.example/${env:BASE_HOST}",
    auth: { type: "none" },
    tls: { verify: true, ca_bundle: null, client_cert: null },
    defaults: { headers: {} },
    openapi_url: null,
    endpoints: [],
  };

  it("picks up ${env:X} in base_url", () => {
    expect(manifestRequiredEnvKeys(base)).toEqual(["BASE_HOST"]);
  });

  it("picks up header-auth variables (THIS is the Meraki regression test)", () => {
    const m: ApiTargetManifest = {
      ...base,
      base_url: "https://api.meraki.com/api/v1",
      auth: {
        type: "header",
        header_name: "X-Cisco-Meraki-API-Key",
        value: "${env:MERAKI_API_KEY}",
      },
    };
    expect(manifestRequiredEnvKeys(m)).toEqual(["MERAKI_API_KEY"]);
  });

  it("picks up basic-auth user + pass", () => {
    const m: ApiTargetManifest = {
      ...base,
      base_url: "https://ise.example",
      auth: {
        type: "basic",
        username: "${env:ISE_USER}",
        password: "${env:ISE_PASS}",
      },
    };
    expect(manifestRequiredEnvKeys(m).sort()).toEqual([
      "ISE_PASS",
      "ISE_USER",
    ]);
  });

  it("picks up token_login placeholders from login + credentials + apply", () => {
    const m: ApiTargetManifest = {
      ...base,
      base_url: "https://${env:DNAC_HOST}",
      auth: {
        type: "token_login",
        login: {
          method: "POST",
          url: "/dna/auth/${env:DNAC_PATH}",
          credentials: {
            type: "basic",
            username: "${env:DNAC_USER}",
            password: "${env:DNAC_PASS}",
          },
          token_jsonpath: "$.Token",
        },
        apply: { mode: "header", name: "X-Auth-Token" },
        refresh_on_status: [401],
      },
    };
    expect(manifestRequiredEnvKeys(m).sort()).toEqual([
      "DNAC_HOST",
      "DNAC_PASS",
      "DNAC_PATH",
      "DNAC_USER",
    ]);
  });

  it("picks up session_cookie credentials (json body variant)", () => {
    const m: ApiTargetManifest = {
      ...base,
      base_url: "https://sna.example",
      auth: {
        type: "session_cookie",
        login: {
          method: "POST",
          url: "/token/v2/authenticate",
          credentials: {
            type: "json_body",
            body: '{"username":"${env:SNA_USER}","password":"${env:SNA_PASS}"}',
          },
        },
      },
    };
    expect(manifestRequiredEnvKeys(m).sort()).toEqual(["SNA_PASS", "SNA_USER"]);
  });

  it("picks up placeholders in default headers", () => {
    const m: ApiTargetManifest = {
      ...base,
      base_url: "https://x",
      defaults: { headers: { "X-Thing": "${env:THING_ID}" } },
    };
    expect(manifestRequiredEnvKeys(m)).toEqual(["THING_ID"]);
  });

  it("returns [] for none-auth + no placeholders", () => {
    const m: ApiTargetManifest = {
      ...base,
      base_url: "https://x",
    };
    expect(manifestRequiredEnvKeys(m)).toEqual([]);
  });
});
