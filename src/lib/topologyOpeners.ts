import { useNetconfRunner } from "../state/netconfRunnerStore";
import { buildSshCommand, sshDecryptPassword, sshListConnections, sshMarkUsed, type SshConnection, type SshConnectEventDetail } from "./sshConnections";
import { netconfDeviceGetPassword, netconfDeviceList, tabNewNetconf } from "./tauri";
import type { Tab } from "./types";

export type TopologySshSeed = { savedSsh: { connection: SshConnection; password: string | null } };

/** Saved-device actions for the existing App terminal and NETCONF tab paths. */
export class TopologyOpeners {
  constructor(
    private readonly seedTerminalTab: (opts: TopologySshSeed) => Promise<void>,
    private readonly addTab: (tab: Tab) => void,
  ) {}

  async openSsh(ref: string): Promise<void> {
    const profiles = await sshListConnections().catch(() => {
      throw new Error("Saved SSH profiles could not be loaded.");
    });
    const matches = profiles.filter((profile) => profile.host === ref);
    if (matches.length !== 1) throw new Error(matches.length
      ? "Multiple saved SSH profiles match this host." : "No saved SSH profile matches this host.");
    const connection = matches[0];
    const password = connection.password_encrypted
      ? await sshDecryptPassword(connection.password_encrypted).catch(() => null)
      : null;
    try {
      await this.seedTerminalTab({ savedSsh: { connection, password } });
    } catch {
      throw new Error("SSH terminal could not be opened.");
    }
    // Usage bookkeeping must not turn an already-open terminal into a failed launch.
    await sshMarkUsed(connection.id).catch(() => {});
  }

  static sshConnectDetail(connection: SshConnection, password: string | null, targetTabId: string): SshConnectEventDetail {
    return {
      command: buildSshCommand(connection),
      targetTabId,
      connection: {
        id: connection.id,
        display_name: connection.name,
        vendor: connection.vendor,
        platform: connection.platform,
        accent_color: connection.accent_color,
        syntax_highlighting_enabled: connection.syntax_highlighting_enabled,
        syntax_profile: connection.syntax_profile,
      },
      credentials: { host: connection.host, user: connection.user, password },
    };
  }

  async openNetconf(ref: string): Promise<void> {
    const profiles = await netconfDeviceList().catch(() => {
      throw new Error("Saved NETCONF profiles could not be loaded.");
    });
    const matches = profiles.filter((profile) => profile.host === ref);
    if (matches.length !== 1) throw new Error(matches.length
      ? "Multiple saved NETCONF profiles match this host." : "No saved NETCONF profile matches this host.");
    const device = matches[0];
    const password = await netconfDeviceGetPassword(device.id).catch(() => "");
    try {
      const tab = await tabNewNetconf({ title: device.name });
      useNetconfRunner.getState().patch(tab.id, {
        host: device.host,
        port: device.port,
        username: device.username,
        password,
        device_name: device.name,
        selected_device_id: device.id,
        status: "disconnected",
        connection_error: password ? null : "Password not found - please enter it below",
      });
      this.addTab(tab);
    } catch {
      throw new Error("NETCONF tab could not be opened.");
    }
  }
}
