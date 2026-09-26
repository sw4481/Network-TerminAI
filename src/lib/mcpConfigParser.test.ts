import { describe, it, expect } from "vitest";
import { parseMcpConfig, validateMcpConfig } from "./mcpConfigParser";

describe("parseMcpConfig", () => {
  describe("simple stdio format", () => {
    it("should parse a simple stdio server config", () => {
      const json = JSON.stringify({
        name: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
        env: {
          NODE_ENV: "production",
        },
      });

      const result = parseMcpConfig(json);

      expect(result.success).toBe(true);
      expect(result.configs).toHaveLength(1);
      expect(result.configs[0]).toEqual({
        name: "filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
        env: {
          NODE_ENV: "production",
        },
      });
    });

    it("should parse stdio config without env", () => {
      const json = JSON.stringify({
        name: "simple",
        command: "node",
        args: ["server.js"],
      });

      const result = parseMcpConfig(json);

      expect(result.success).toBe(true);
      expect(result.configs[0]).toEqual({
        name: "simple",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: undefined,
      });
    });

    it("should parse stdio config without args", () => {
      const json = JSON.stringify({
        name: "simple",
        command: "server",
      });

      const result = parseMcpConfig(json);

      expect(result.success).toBe(true);
      expect(result.configs[0].args).toEqual([]);
    });

    it("should fail if command is missing", () => {
      const json = JSON.stringify({
        name: "filesystem",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
      });

      const result = parseMcpConfig(json);

      expect(result.success).toBe(false);
      expect(result.error).toContain("command");
    });

    it("should fail if name is missing", () => {
      const json = JSON.stringify({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
      });

      const result = parseMcpConfig(json);

      expect(result.success).toBe(false);
      expect(result.error).toContain("name");
    });
  });

  describe("SSE format", () => {
    it("should parse an SSE server config", () => {
      const json = JSON.stringify({
        name: "remote-tools",
        transport: "sse",
        url: "https://mcp-server.example.com/sse",
      });

      const result = parseMcpConfig(json);

      expect(result.success).toBe(true);
      expect(result.configs).toHaveLength(1);
      expect(result.configs[0]).toEqual({
        name: "remote-tools",
        transport: "sse",
        url: "https://mcp-server.example.com/sse",
      });
    });

    it("should infer SSE transport from url field", () => {
      const json = JSON.stringify({
        name: "remote",
        url: "https://example.com/sse",
      });

      const result = parseMcpConfig(json);

      expect(result.success).toBe(true);
      expect(result.configs[0].transport).toBe("sse");
    });

    it("should fail if url is missing for SSE", () => {
      const json = JSON.stringify({
        name: "remote-tools",
        transport: "sse",
      });

      const result = parseMcpConfig(json);

      expect(result.success).toBe(false);
      expect(result.error).toContain("url");
    });
  });

  describe("Claude Desktop format", () => {
    it("should parse Claude Desktop config with multiple servers", () => {
      const json = JSON.stringify({
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "$HOME/Documents"],
          },
          git: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-git", "$HOME/projects"],
            env: {
              GIT_AUTHOR_NAME: "Claude",
            },
          },
        },
      });

      const result = parseMcpConfig(json);

      expect(result.success).toBe(true);
      expect(result.configs).toHaveLength(2);

      const filesystem = result.configs.find((c) => c.name === "filesystem");
      expect(filesystem).toBeDefined();
      expect(filesystem?.transport).toBe("stdio");
      expect(filesystem?.command).toBe("npx");
      expect(filesystem?.args).toEqual([
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "$HOME/Documents",
      ]);

      const git = result.configs.find((c) => c.name === "git");
      expect(git).toBeDefined();
      expect(git?.env).toEqual({ GIT_AUTHOR_NAME: "Claude" });
    });

    it("should parse Claude Desktop config with SSE server", () => {
      const json = JSON.stringify({
        mcpServers: {
          remote: {
            transport: "sse",
            url: "https://example.com/sse",
          },
        },
      });

      const result = parseMcpConfig(json);

      expect(result.success).toBe(true);
      expect(result.configs).toHaveLength(1);
      expect(result.configs[0]).toEqual({
        name: "remote",
        transport: "sse",
        url: "https://example.com/sse",
      });
    });

    it("should handle mixed valid and invalid servers", () => {
      const json = JSON.stringify({
        mcpServers: {
          valid: {
            command: "node",
            args: ["server.js"],
          },
          invalid: {
            // Missing command
            args: ["test"],
          },
        },
      });

      const result = parseMcpConfig(json);

      expect(result.success).toBe(true);
      expect(result.configs).toHaveLength(1);
      expect(result.configs[0].name).toBe("valid");
      expect(result.error).toContain("invalid");
    });

    it("should fail if all servers are invalid", () => {
      const json = JSON.stringify({
        mcpServers: {
          invalid1: {
            args: ["test"],
          },
          invalid2: {
            transport: "sse",
          },
        },
      });

      const result = parseMcpConfig(json);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("array format", () => {
    it("should parse array of server configs", () => {
      const json = JSON.stringify([
        {
          name: "server1",
          command: "node",
          args: ["server1.js"],
        },
        {
          name: "server2",
          transport: "sse",
          url: "https://example.com/sse",
        },
      ]);

      const result = parseMcpConfig(json);

      expect(result.success).toBe(true);
      expect(result.configs).toHaveLength(2);
      expect(result.configs[0].name).toBe("server1");
      expect(result.configs[1].name).toBe("server2");
    });

    it("should handle mixed valid and invalid in array", () => {
      const json = JSON.stringify([
        {
          name: "valid",
          command: "node",
          args: ["server.js"],
        },
        {
          name: "invalid",
          // Missing command
        },
      ]);

      const result = parseMcpConfig(json);

      expect(result.success).toBe(true);
      expect(result.configs).toHaveLength(1);
      expect(result.error).toContain("Item 1");
    });
  });

  describe("error handling", () => {
    it("should fail on invalid JSON", () => {
      const result = parseMcpConfig("{ invalid json }");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should fail on unrecognized format", () => {
      const json = JSON.stringify({
        someOtherField: "value",
      });

      const result = parseMcpConfig(json);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unrecognized");
    });

    it("should fail if config is not an object", () => {
      const result = parseMcpConfig('"just a string"');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});

describe("validateMcpConfig", () => {
  it("should validate a valid stdio config", () => {
    const config = {
      name: "filesystem",
      transport: "stdio" as const,
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
    };

    const error = validateMcpConfig(config);

    expect(error).toBeNull();
  });

  it("should validate a valid SSE config", () => {
    const config = {
      name: "remote",
      transport: "sse" as const,
      url: "https://example.com/sse",
    };

    const error = validateMcpConfig(config);

    expect(error).toBeNull();
  });

  it("should reject empty name", () => {
    const config = {
      name: "",
      transport: "stdio" as const,
      command: "node",
    };

    const error = validateMcpConfig(config);

    expect(error).toContain("name");
  });

  it("should reject stdio config without command", () => {
    const config = {
      name: "test",
      transport: "stdio" as const,
      command: "",
    };

    const error = validateMcpConfig(config);

    expect(error).toContain("Command");
  });

  it("should reject SSE config without url", () => {
    const config = {
      name: "test",
      transport: "sse" as const,
      url: "",
    };

    const error = validateMcpConfig(config);

    expect(error).toContain("URL");
  });

  it("should reject SSE config with invalid url", () => {
    const config = {
      name: "test",
      transport: "sse" as const,
      url: "not-a-valid-url",
    };

    const error = validateMcpConfig(config);

    expect(error).toContain("Invalid URL");
  });

  it("should reject invalid transport type", () => {
    const config = {
      name: "test",
      transport: "invalid" as any,
    };

    const error = validateMcpConfig(config);

    expect(error).toContain("transport");
  });
});
