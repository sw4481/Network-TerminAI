export const DEVICE_VENDORS = [
  "cisco",
  "juniper",
  "arista",
  "meraki",
  "generic",
] as const;

export type Vendor = (typeof DEVICE_VENDORS)[number];

export interface DeviceProfileOption {
  label: string;
  vendor: Vendor;
  platform: string;
}

export const DEVICE_PROFILES: readonly DeviceProfileOption[] = [
  { label: "Generic", vendor: "generic", platform: "generic" },
  { label: "Cisco IOS-XE", vendor: "cisco", platform: "iosxe" },
  { label: "Cisco IOS", vendor: "cisco", platform: "ios" },
  { label: "Cisco NX-OS", vendor: "cisco", platform: "nxos" },
  { label: "Cisco IOS XR", vendor: "cisco", platform: "iosxr" },
  { label: "Juniper Junos", vendor: "juniper", platform: "junos" },
  { label: "Arista EOS", vendor: "arista", platform: "eos" },
  { label: "Meraki", vendor: "meraki", platform: "generic" },
] as const;

export const PARSER_DEVICE_PROFILES: readonly DeviceProfileOption[] =
  DEVICE_PROFILES.filter(
    (profile) =>
      (profile.vendor === "cisco" && ["iosxe", "ios", "nxos"].includes(profile.platform)) ||
      (profile.vendor === "juniper" && profile.platform === "junos") ||
      (profile.vendor === "arista" && profile.platform === "eos"),
  );

export const PLATFORMS_BY_VENDOR: Readonly<Record<Vendor, readonly string[]>> = {
  cisco: ["iosxe", "ios", "nxos", "iosxr", "generic"],
  juniper: ["junos", "generic"],
  arista: ["eos", "generic"],
  meraki: ["generic"],
  generic: ["generic"],
};

export const DEVICE_ACCENT_COLORS = [
  "blue",
  "cyan",
  "green",
  "amber",
  "orange",
  "red",
  "purple",
  "pink",
] as const;

export type DeviceAccentColor = (typeof DEVICE_ACCENT_COLORS)[number];

export const SYNTAX_PROFILES = ["auto", "cisco", "junos", "arista", "generic"] as const;
export type SyntaxProfile = (typeof SYNTAX_PROFILES)[number];

export type ResolvedSyntaxProfile = Exclude<SyntaxProfile, "auto">;

export function resolveSyntaxProfile(
  profile: SyntaxProfile,
  vendor: Vendor,
  platform: string,
): ResolvedSyntaxProfile {
  if (profile !== "auto") return profile;
  const normalizedPlatform = platform.toLowerCase();
  if (vendor === "cisco" || ["ios", "iosxe", "iosxr", "nxos"].includes(normalizedPlatform)) {
    return "cisco";
  }
  if (vendor === "juniper" || normalizedPlatform === "junos") return "junos";
  if (vendor === "arista" || normalizedPlatform === "eos") return "arista";
  return "generic";
}

export function isVendor(value: string): value is Vendor {
  return (DEVICE_VENDORS as readonly string[]).includes(value);
}
