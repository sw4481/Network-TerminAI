import { create } from "zustand";

export type McpServer = {
  id: string;
  name: string;
  transport: string;
  command_json: string | null;
  url: string | null;
  env_json: string | null;
  enabled: boolean;
  created_at: number;
};

export type McpTool = {
  name: string;
  description: string | null;
};

export type McpPolicy = {
  server_name: string;
  tool_name: string;
  policy: string;
  scope: string;
  created_at: number;
  updated_at: number;
};

type McpStore = {
  servers: McpServer[];
  setServers: (servers: McpServer[]) => void;
  addServer: (server: McpServer) => void;
  removeServer: (id: string) => void;
  updateServer: (id: string, updates: Partial<McpServer>) => void;
};

export const useMcpStore = create<McpStore>((set) => ({
  servers: [],
  setServers: (servers) => set({ servers }),
  addServer: (server) => set((s) => ({ servers: [...s.servers, server] })),
  removeServer: (id) =>
    set((s) => ({ servers: s.servers.filter((srv) => srv.id !== id) })),
  updateServer: (id, updates) =>
    set((s) => ({
      servers: s.servers.map((srv) =>
        srv.id === id ? { ...srv, ...updates } : srv
      ),
    })),
}));
