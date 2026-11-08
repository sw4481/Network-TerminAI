import { describe, expect, it } from "vitest";
import { SnmpProfile } from "./snmpProfile";
import type { SecretDto } from "./vault";

const valid = () => ({ ...SnmpProfile.empty(), username: "synthetic-user", authKey: "synthetic-auth", privKey: "synthetic-privacy" });
describe("encrypted SNMP profile boundary", () => {
  it("defaults to v3 authPriv and serializes only versioned profile fields", () => {
    expect(JSON.parse(SnmpProfile.serialize(valid()))).toEqual({ schema: 1, version: "3", username: "synthetic-user", auth_key: "synthetic-auth", priv_key: "synthetic-privacy", context: "", port: 161 });
    expect(JSON.parse(SnmpProfile.serialize({ ...valid(), version: "2c", community: "synthetic-community" }))).toEqual({ schema: 1, version: "2c", community: "synthetic-community", port: 161 });
  });
  it.each(["0", "65536", "1.5", "", "NaN", " 161", "1e2"])("rejects invalid port %s", (port) => {
    expect(() => SnmpProfile.serialize({ ...valid(), port })).toThrow();
  });
  it.each([{ username: "" }, { username: "界".repeat(11) }, { authKey: "short" }, { privKey: "bad\nvalue" }, { context: "x".repeat(33) }])("rejects invalid v3 fields %j", (fields) => {
    expect(() => SnmpProfile.serialize({ ...valid(), ...fields })).toThrow();
  });
  it.each(["", "x".repeat(256), "bad\u007fvalue"])("rejects invalid v2c communities", (community) => {
    expect(() => SnmpProfile.serialize({ ...valid(), version: "2c", community })).toThrow();
  });
  it("selects only marked metadata of the exact explicit version, never legacy values", () => {
    const secret = { kind: "snmp_community", metadata: { format: "topology-snmp-v1", version: "3" } } as unknown as SecretDto;
    expect(SnmpProfile.matches(secret, "3")).toBe(true);
    expect(SnmpProfile.matches(secret, "2c")).toBe(false);
    expect(SnmpProfile.matches({ ...secret, metadata: {} }, "3")).toBe(false);
    expect(SnmpProfile.matches({ ...secret, kind: "password" }, "3")).toBe(false);
  });
});
