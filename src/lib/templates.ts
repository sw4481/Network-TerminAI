// src/lib/templates.ts
// Command template definitions for quick command insertion

export interface CommandTemplate {
  id: string;
  name: string;
  category: 'network' | 'file' | 'process' | 'system';
  template: string;
  description: string;
  parameters?: string[]; // Parameter names in order they appear in template
}

export const TEMPLATES: CommandTemplate[] = [
  // NETWORK CATEGORY
  {
    id: 'net-ping',
    name: 'Ping Host',
    category: 'network',
    template: 'ping -c 4 {{host}}',
    description: 'Send 4 ICMP echo requests to a host',
    parameters: ['host'],
  },
  {
    id: 'net-traceroute',
    name: 'Traceroute',
    category: 'network',
    template: 'traceroute {{host}}',
    description: 'Trace network path to a host',
    parameters: ['host'],
  },
  {
    id: 'net-nslookup',
    name: 'DNS Lookup',
    category: 'network',
    template: 'nslookup {{domain}}',
    description: 'Query DNS records for a domain',
    parameters: ['domain'],
  },
  {
    id: 'net-netstat',
    name: 'Network Connections',
    category: 'network',
    template: 'netstat -an | grep {{port}}',
    description: 'Show network connections for a specific port',
    parameters: ['port'],
  },
  {
    id: 'net-curl',
    name: 'HTTP Request',
    category: 'network',
    template: 'curl -v {{url}}',
    description: 'Make HTTP request with verbose output',
    parameters: ['url'],
  },
  {
    id: 'net-wget',
    name: 'Download File',
    category: 'network',
    template: 'wget {{url}}',
    description: 'Download file from URL',
    parameters: ['url'],
  },

  // FILE CATEGORY
  {
    id: 'file-find',
    name: 'Find Files',
    category: 'file',
    template: 'find . -name "{{pattern}}" -type f',
    description: 'Find files by name pattern',
    parameters: ['pattern'],
  },
  {
    id: 'file-grep',
    name: 'Search in Files',
    category: 'file',
    template: 'grep -r "{{pattern}}" .',
    description: 'Search for text pattern in files recursively',
    parameters: ['pattern'],
  },
  {
    id: 'file-tar',
    name: 'Create Archive',
    category: 'file',
    template: 'tar -czf {{filename}}.tar.gz {{directory}}',
    description: 'Create compressed tar archive',
    parameters: ['filename', 'directory'],
  },
  {
    id: 'file-untar',
    name: 'Extract Archive',
    category: 'file',
    template: 'tar -xzf {{filename}}.tar.gz',
    description: 'Extract compressed tar archive',
    parameters: ['filename'],
  },
  {
    id: 'file-chmod',
    name: 'Change Permissions',
    category: 'file',
    template: 'chmod {{mode}} {{file}}',
    description: 'Change file permissions',
    parameters: ['mode', 'file'],
  },
  {
    id: 'file-du',
    name: 'Disk Usage',
    category: 'file',
    template: 'du -sh {{directory}}',
    description: 'Show directory size in human-readable format',
    parameters: ['directory'],
  },

  // PROCESS CATEGORY
  {
    id: 'proc-ps',
    name: 'Find Process',
    category: 'process',
    template: 'ps aux | grep {{name}}',
    description: 'Find running processes by name',
    parameters: ['name'],
  },
  {
    id: 'proc-kill',
    name: 'Kill Process',
    category: 'process',
    template: 'kill -9 {{pid}}',
    description: 'Force kill process by PID',
    parameters: ['pid'],
  },
  {
    id: 'proc-port',
    name: 'Process Using Port',
    category: 'process',
    template: 'lsof -i :{{port}}',
    description: 'Find process listening on port',
    parameters: ['port'],
  },

  // SYSTEM CATEGORY
  {
    id: 'sys-df',
    name: 'Disk Space',
    category: 'system',
    template: 'df -h',
    description: 'Show disk space usage',
  },
  {
    id: 'sys-free',
    name: 'Memory Usage',
    category: 'system',
    template: 'free -h',
    description: 'Show memory usage in human-readable format',
  },
  {
    id: 'sys-uptime',
    name: 'System Uptime',
    category: 'system',
    template: 'uptime',
    description: 'Show system uptime and load',
  },
  {
    id: 'sys-uname',
    name: 'System Info',
    category: 'system',
    template: 'uname -a',
    description: 'Show system information',
  },
];

export function getTemplatesByCategory(category: CommandTemplate['category']): CommandTemplate[] {
  return TEMPLATES.filter(t => t.category === category);
}

export function getCategoryName(category: CommandTemplate['category']): string {
  const names: Record<CommandTemplate['category'], string> = {
    network: 'Network',
    file: 'File Operations',
    process: 'Process Management',
    system: 'System Info',
  };
  return names[category];
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}
