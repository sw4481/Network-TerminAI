export const SETTINGS_TABS = [
  { id: "general", label: "General", category: "General" },
  { id: "agentComputers", label: "Agent Computers", category: "AI & Agents" },
  { id: "agents", label: "Agents", category: "AI & Agents" },
  { id: "networkArchitect", label: "Network Architect", category: "AI & Agents" },
  { id: "rag", label: "RAG", category: "AI & Agents" },
  { id: "skills", label: "Skills", category: "AI & Agents" },
  { id: "vendorKeywords", label: "Vendor Keywords", category: "AI & Agents" },
  { id: "appearance", label: "Appearance", category: "Application" },
  { id: "browser", label: "Browser", category: "Application" },
  { id: "editor", label: "Editor", category: "Application" },
  { id: "terminal", label: "Terminal", category: "Application" },
  { id: "updates", label: "Updates", category: "Application" },
  { id: "aci", label: "ACI", category: "Cisco" },
  { id: "catalyst_center", label: "Catalyst Center", category: "Cisco" },
  { id: "cisco_xdr", label: "Cisco XDR", category: "Cisco" },
  { id: "cml", label: "CML", category: "Cisco" },
  { id: "fmc", label: "FMC", category: "Cisco" },
  { id: "ise", label: "ISE", category: "Cisco" },
  { id: "meraki", label: "Meraki", category: "Cisco" },
  { id: "secure_endpoint", label: "Secure Endpoint", category: "Cisco" },
  { id: "stealthwatch", label: "Stealthwatch", category: "Cisco" },
  { id: "thousandeyes", label: "ThousandEyes", category: "Cisco" },
  { id: "gnmi", label: "gNMI", category: "Network Data" },
  { id: "mist", label: "Juniper Mist", category: "Network Data" },
  { id: "netbox", label: "NetBox", category: "Network Data" },
  { id: "pyats", label: "pyATS", category: "Network Data" },
  { id: "topolograph", label: "Topolograph", category: "Network Data" },
  { id: "grafana", label: "Grafana", category: "Observability" },
  { id: "prometheus", label: "Prometheus", category: "Observability" },
  { id: "splunk", label: "Splunk", category: "Observability" },
  { id: "zabbix", label: "Zabbix", category: "Observability" },
  { id: "ftp", label: "FTP Server", category: "Services" },
  { id: "gitci", label: "Git / CI", category: "Services" },
  { id: "mcp", label: "MCP Servers", category: "Services" },
  { id: "proxmox", label: "Proxmox", category: "Services" },
  { id: "sketchfab", label: "Sketchfab", category: "Services" },
  { id: "tftp", label: "TFTP Server", category: "Services" },
  { id: "whatsapp", label: "WhatsApp", category: "Services" },
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

type SettingsTab = (typeof SETTINGS_TABS)[number];

export function getSettingsTabGroups(): { category: string; tabs: SettingsTab[] }[] {
  const groups = new Map<string, SettingsTab[]>();
  for (const tab of SETTINGS_TABS) {
    groups.set(tab.category, [...(groups.get(tab.category) ?? []), tab]);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a === "General" ? -1 : b === "General" ? 1 : a.localeCompare(b))
    .map(([category, tabs]) => ({
      category,
      tabs: [...tabs].sort((a, b) => a.label.localeCompare(b.label)),
    }));
}
