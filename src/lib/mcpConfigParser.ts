export type McpTransport = "stdio" | "sse";

export interface McpServerConfig {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface ParseResult {
  success: boolean;
  configs: McpServerConfig[];
  error?: string;
}

/**
 * Parse MCP server configuration from JSON string
 * Supports multiple formats:
 * 1. Simple stdio: { name, command, args, env }
 * 2. SSE: { name, transport: "sse", url }
 * 3. Claude Desktop format: { mcpServers: { [name]: { command, args, env } } }
 */
export function parseMcpConfig(json: string): ParseResult {
  try {
    const parsed = JSON.parse(json);

    // Detect format
    if (parsed.mcpServers) {
      // Claude Desktop format
      return parseClaudeDesktopFormat(parsed);
    } else if (Array.isArray(parsed)) {
      // Array of server configs
      return parseArrayFormat(parsed);
    } else if (parsed.name || parsed.command || parsed.url) {
      // Single server config
      return parseSingleConfig(parsed);
    } else {
      return {
        success: false,
        configs: [],
        error: "Unrecognized config format. Expected a server config object, array, or Claude Desktop format.",
      };
    }
  } catch (e) {
    return {
      success: false,
      configs: [],
      error: e instanceof Error ? e.message : "Invalid JSON",
    };
  }
}

function parseClaudeDesktopFormat(parsed: any): ParseResult {
  const configs: McpServerConfig[] = [];
  const errors: string[] = [];

  const mcpServers = parsed.mcpServers;
  if (typeof mcpServers !== "object" || mcpServers === null) {
    return {
      success: false,
      configs: [],
      error: "mcpServers must be an object",
    };
  }

  for (const [name, config] of Object.entries(mcpServers)) {
    if (typeof config !== "object" || config === null) {
      errors.push(`Server "${name}": config must be an object`);
      continue;
    }

    const serverConfig = config as any;

    // Check for SSE transport
    if (serverConfig.transport === "sse") {
      if (!serverConfig.url) {
        errors.push(`Server "${name}": SSE transport requires url`);
        continue;
      }
      configs.push({
        name,
        transport: "sse",
        url: serverConfig.url,
      });
    } else {
      // Assume stdio transport
      if (!serverConfig.command) {
        errors.push(`Server "${name}": stdio transport requires command`);
        continue;
      }

      configs.push({
        name,
        transport: "stdio",
        command: serverConfig.command,
        args: Array.isArray(serverConfig.args) ? serverConfig.args : [],
        env: typeof serverConfig.env === "object" ? serverConfig.env : undefined,
      });
    }
  }

  if (configs.length === 0 && errors.length > 0) {
    return {
      success: false,
      configs: [],
      error: errors.join("; "),
    };
  }

  return {
    success: true,
    configs,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}

function parseArrayFormat(parsed: any[]): ParseResult {
  const configs: McpServerConfig[] = [];
  const errors: string[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const result = parseSingleConfig(parsed[i]);
    if (result.success && result.configs.length > 0) {
      configs.push(result.configs[0]);
    } else if (result.error) {
      errors.push(`Item ${i}: ${result.error}`);
    }
  }

  if (configs.length === 0 && errors.length > 0) {
    return {
      success: false,
      configs: [],
      error: errors.join("; "),
    };
  }

  return {
    success: true,
    configs,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}

function parseSingleConfig(parsed: any): ParseResult {
  if (typeof parsed !== "object" || parsed === null) {
    return {
      success: false,
      configs: [],
      error: "Config must be an object",
    };
  }

  // Determine transport type
  const transport = parsed.transport || (parsed.url ? "sse" : "stdio");

  // SSE transport
  if (transport === "sse") {
    if (!parsed.url) {
      return {
        success: false,
        configs: [],
        error: "SSE transport requires url field",
      };
    }

    if (!parsed.name) {
      return {
        success: false,
        configs: [],
        error: "name field is required",
      };
    }

    return {
      success: true,
      configs: [
        {
          name: parsed.name,
          transport: "sse",
          url: parsed.url,
        },
      ],
    };
  }

  // Stdio transport
  if (!parsed.command) {
    return {
      success: false,
      configs: [],
      error: "stdio transport requires command field",
    };
  }

  if (!parsed.name) {
    return {
      success: false,
      configs: [],
      error: "name field is required",
    };
  }

  return {
    success: true,
    configs: [
      {
        name: parsed.name,
        transport: "stdio",
        command: parsed.command,
        args: Array.isArray(parsed.args) ? parsed.args : [],
        env: typeof parsed.env === "object" && parsed.env !== null ? parsed.env : undefined,
      },
    ],
  };
}

/**
 * Validate a parsed MCP config before saving
 */
export function validateMcpConfig(config: McpServerConfig): string | null {
  if (!config.name || config.name.trim().length === 0) {
    return "Server name is required";
  }

  if (config.transport === "sse") {
    if (!config.url || config.url.trim().length === 0) {
      return "URL is required for SSE transport";
    }
    try {
      new URL(config.url);
    } catch {
      return "Invalid URL format";
    }
  } else if (config.transport === "stdio") {
    if (!config.command || config.command.trim().length === 0) {
      return "Command is required for stdio transport";
    }
  } else {
    return "Invalid transport type";
  }

  return null;
}
