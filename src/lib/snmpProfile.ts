import type { SecretDto } from "./vault";

export type SnmpVersion = "3" | "2c";
export interface SnmpProfileFields {
  version: SnmpVersion;
  username: string;
  authKey: string;
  privKey: string;
  community: string;
  context: string;
  port: string;
}

/** Only format/version are public metadata; the complete value stays encrypted. */
export class SnmpProfile {
  static empty(): SnmpProfileFields {
    return { version: "3", username: "", authKey: "", privKey: "", community: "", context: "", port: "161" };
  }

  static serialize(fields: SnmpProfileFields): string {
    const bytes = (value: string) => new TextEncoder().encode(value).length;
    const text = (value: string, minimum: number, maximum: number) =>
      bytes(value) >= minimum && bytes(value) <= maximum && !/[\x00-\x1f\x7f]/.test(value);
    if (!/^\d+$/.test(fields.port) || Number(fields.port) < 1 || Number(fields.port) > 65535) {
      throw new Error("SNMP port must be an integer from 1 to 65535.");
    }
    const port = Number(fields.port);
    if (fields.version === "2c") {
      if (!text(fields.community, 1, 255)) throw new Error("Enter a community of 1–255 UTF-8 bytes, without control characters.");
      return JSON.stringify({ schema: 1, version: "2c", community: fields.community, port });
    }
    if (fields.version !== "3" || !text(fields.username, 1, 32) ||
      !text(fields.authKey, 8, 1024) || !text(fields.privKey, 8, 1024) || !text(fields.context, 0, 32)) {
      throw new Error("SNMPv3 requires a 1–32 byte username, authentication/privacy passphrases of 8–1024 bytes, and a context of at most 32 bytes; control characters are not allowed.");
    }
    return JSON.stringify({ schema: 1, version: "3", username: fields.username,
      auth_key: fields.authKey, priv_key: fields.privKey, context: fields.context, port });
  }

  static matches(secret: SecretDto, version: SnmpVersion): boolean {
    return secret.kind === "snmp_community" && secret.metadata?.format === "topology-snmp-v1" && secret.metadata.version === version;
  }
}
