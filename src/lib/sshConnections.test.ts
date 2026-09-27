import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  buildSshCommand,
  sshCreateFolder,
  sshDeleteFolder,
  sshGetConnection,
  sshSaveConnection,
  sshUpdateConnection,
  sshUpdateFolder,
} from "./sshConnections";

describe("typed SSH command wrappers", () => {
  beforeEach(() => invokeMock.mockReset().mockResolvedValue(undefined));

  it("passes request objects with the exact Tauri argument shape", async () => {
    const request = {
      name: "edge-1",
      host: "192.0.2.1",
      folder_id: "sites",
      tags: ["wan"],
      accent_color: "cyan" as const,
      vendor: "cisco" as const,
      platform: "ios-xe",
    };
    await sshSaveConnection(request);
    await sshUpdateConnection("connection-1", request);
    await sshGetConnection("connection-1");
    await sshCreateFolder({ parent_id: "root", name: "Sites" });
    await sshUpdateFolder("sites", { parent_id: "root", name: "Branches", position: 2 });
    await sshDeleteFolder("sites");

    expect(invokeMock.mock.calls).toEqual([
      ["ssh_save_connection", { request }],
      ["ssh_update_connection", { id: "connection-1", request }],
      ["ssh_get_connection", { id: "connection-1" }],
      ["ssh_create_folder", { request: { parent_id: "root", name: "Sites" } }],
      ["ssh_update_folder", {
        id: "sites",
        request: { parent_id: "root", name: "Branches", position: 2 },
      }],
      ["ssh_delete_folder", { id: "sites" }],
    ]);
  });

  it("builds a saved-device SSH command from safe connection fields", () => {
    expect(buildSshCommand({
      host: "router.example",
      user: "netops",
      port: 2222,
      identity_file: "/keys/lab_ed25519",
    })).toBe("/usr/bin/ssh -p 2222 -o HostName=router.example -i /keys/lab_ed25519 -- netops@router.example");
    expect(buildSshCommand({
      host: "router.example",
      user: "net ops",
      port: 22,
      identity_file: "/keys/lab key",
    })).toBe("/usr/bin/ssh -p 22 -o HostName=router.example -i '/keys/lab key' -- 'net ops@router.example'");
  });
});
