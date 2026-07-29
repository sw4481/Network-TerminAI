/**
 * Credential presets for the four built-in Cisco targets.
 *
 * These give the CredentialsPanel a human-friendly "Quick Setup" UI where
 * users fill in labeled fields (API Key, Hostname, Username, Password)
 * instead of having to know the exact env-var names the manifests expect.
 *
 * The `envKey` of each field is the string the manifest YAML references
 * via `${env:X}` / `${var:X}`. If you edit a manifest to rename a key,
 * update the preset here too.
 */

export type CredentialField = {
  /** Env var name written to `<env>.env`. Must match what the manifest references. */
  envKey: string;
  /** Human label shown in the UI. */
  label: string;
  /** Short hint (placeholder text). */
  hint: string;
  /** Secret values render as `<input type="password">` + reveal toggle. */
  isSecret: boolean;
  /** Marked required in the UI — optional fields stay informational. */
  required: boolean;
};

export type CredentialPreset = {
  /** Target id (matches the builtin manifest id). */
  id: string;
  /** Display name shown in the tab strip. */
  label: string;
  /** One-line blurb under the section header. */
  description: string;
  fields: CredentialField[];
};

export const CREDENTIAL_PRESETS: CredentialPreset[] = [
  {
    id: "meraki",
    label: "Meraki",
    description: "Cloud-managed wireless/switching/SD-WAN. Uses a dashboard API key.",
    fields: [
      {
        envKey: "MERAKI_API_KEY",
        label: "API Key",
        hint: "Generate at dashboard.meraki.com → My Profile → API access",
        isSecret: true,
        required: true,
      },
      {
        envKey: "organizationId",
        label: "Organization ID",
        hint: "e.g. L_123456789  (used by path-param endpoints)",
        isSecret: false,
        required: false,
      },
      {
        envKey: "networkId",
        label: "Network ID",
        hint: "e.g. N_987654321  (optional — fill when using network-scoped endpoints)",
        isSecret: false,
        required: false,
      },
    ],
  },
  {
    id: "catalyst_center",
    label: "Catalyst Center (DNA-C)",
    description:
      "On-prem controller. Token-login auth; the first call exchanges Basic creds for a session token.",
    fields: [
      {
        envKey: "DNAC_HOST",
        label: "Hostname",
        hint: "e.g. sandboxdnac.cisco.com  (no https://, no path)",
        isSecret: false,
        required: true,
      },
      {
        envKey: "DNAC_USER",
        label: "Username",
        hint: "Dashboard admin user",
        isSecret: false,
        required: true,
      },
      {
        envKey: "DNAC_PASS",
        label: "Password",
        hint: "Dashboard admin password",
        isSecret: true,
        required: true,
      },
    ],
  },
  {
    id: "ise",
    label: "ISE",
    description:
      "Identity Services Engine. HTTP Basic auth over the ERS / OpenAPI ports (9060 / 443).",
    fields: [
      {
        envKey: "ISE_HOST",
        label: "Hostname",
        hint: "e.g. ise.lab.local  (no https://, no port — port 9060 is baked into the manifest)",
        isSecret: false,
        required: true,
      },
      {
        envKey: "ISE_USER",
        label: "Username",
        hint: "Admin or ERS-enabled account",
        isSecret: false,
        required: true,
      },
      {
        envKey: "ISE_PASS",
        label: "Password",
        hint: "Account password",
        isSecret: true,
        required: true,
      },
    ],
  },
  {
    id: "sna",
    label: "SNA (Stealthwatch)",
    description:
      "Secure Network Analytics. Session-cookie auth: the first call logs in and the jar is reused.",
    fields: [
      {
        envKey: "SNA_HOST",
        label: "Hostname",
        hint: "e.g. smc.lab.local  (the Manager, not a flow collector)",
        isSecret: false,
        required: true,
      },
      {
        envKey: "SNA_USER",
        label: "Username",
        hint: "SMC admin user",
        isSecret: false,
        required: true,
      },
      {
        envKey: "SNA_PASS",
        label: "Password",
        hint: "SMC admin password",
        isSecret: true,
        required: true,
      },
    ],
  },
];

export function findPreset(id: string): CredentialPreset | undefined {
  return CREDENTIAL_PRESETS.find((p) => p.id === id);
}
