import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { VaultTab } from "./VaultTab";
import { useVault } from "../../state/vaultStore";

const selectedEnvelope = {
  id: "topolograph-envelope",
  name: "Topolograph",
  description: null,
  createdAt: 1,
  updatedAt: 1,
  autoUnlock: false,
};

function configureVaultApi() {
  let autoUnlockEnabled = false;
  invokeMock.mockImplementation((command: string) => {
    if (command === "vault_list_envelopes") {
      return Promise.resolve([{ ...selectedEnvelope, autoUnlock: autoUnlockEnabled }]);
    }
    if (command === "vault_unlocked_ids") return Promise.resolve([]);
    if (command === "vault_set_auto_unlock") {
      autoUnlockEnabled = true;
      return Promise.resolve();
    }
    throw new Error(`Unhandled Vault command: ${command}`);
  });
}

afterEach(cleanup);

describe("VaultTab SNMP profiles", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "vault_list_envelopes") return [selectedEnvelope];
      if (command === "vault_unlocked_ids") return [selectedEnvelope.id];
      if (command === "vault_list_secrets") return [];
      if (command === "vault_add_secret") return "synthetic-secret";
      throw new Error(`Unhandled Vault command: ${command}`);
    });
    useVault.setState({ envelopes: [], unlockedIds: new Set(), selectedEnvelopeId: selectedEnvelope.id,
      secretsByEnvelope: {}, revealedUntil: {}, revealedPlaintext: {} });
  });
  const openProfile = async () => {
    render(<VaultTab />);
    fireEvent.click(await screen.findByTestId("vault-add-secret"));
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "snmp_community" } });
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Synthetic profile" } });
  };
  it("saves the v3 encrypted payload with nonsecret format/version metadata only", async () => {
    await openProfile();
    expect(screen.getByLabelText("SNMP version")).toHaveValue("3");
    for (const [label, value] of [["SNMP username", "synthetic-user"], ["Authentication passphrase", "synthetic-auth"], ["Privacy passphrase", "synthetic-privacy"]]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(invokeMock.mock.calls.some(([command]) => command === "vault_add_secret")).toBe(true));
    const args = invokeMock.mock.calls.find(([command]) => command === "vault_add_secret")![1];
    expect(JSON.parse(args.metadataJson)).toEqual({ format: "topology-snmp-v1", version: "3" });
    expect(JSON.parse(args.plaintext)).toMatchObject({ schema: 1, version: "3", username: "synthetic-user", auth_key: "synthetic-auth", priv_key: "synthetic-privacy" });
    expect(invokeMock.mock.calls.some(([command]) => command === "vault_reveal_secret")).toBe(false);
  });
  it("requires explicit v2c, clears v3 values on version change and erases the form on cancel", async () => {
    await openProfile();
    fireEvent.change(screen.getByLabelText("Authentication passphrase"), { target: { value: "synthetic-auth" } });
    fireEvent.change(screen.getByLabelText("SNMP version"), { target: { value: "2c" } });
    expect(screen.queryByLabelText("Authentication passphrase")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("SNMP community"), { target: { value: "synthetic-community" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByTestId("vault-add-secret"));
    expect(screen.getByLabelText("SNMP version")).toHaveValue("3");
    expect(screen.getByLabelText("Authentication passphrase")).toHaveValue("");
    expect(invokeMock.mock.calls.some(([command]) => command === "vault_add_secret")).toBe(false);
  });
  it("shows a sanitized validation error without attempting to save incomplete fields", async () => {
    await openProfile();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Secret could not be saved");
    expect(invokeMock.mock.calls.some(([command]) => command === "vault_add_secret")).toBe(false);
  });
});

describe("VaultTab auto-unlock", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    configureVaultApi();
    useVault.setState({
      envelopes: [],
      unlockedIds: new Set(),
      selectedEnvelopeId: "topolograph-envelope",
      secretsByEnvelope: {},
      revealedUntil: {},
      revealedPlaintext: {},
    });
  });

  it("renders the auto-unlock checkbox with a native button boundary", async () => {
    render(<VaultTab />);

    const checkbox = await screen.findByRole("checkbox", {
      name: "Auto-unlock on app startup",
    });

    expect(checkbox.tagName).toBe("BUTTON");
    expect(checkbox).toHaveAttribute("type", "button");
    expect(checkbox).toHaveAttribute("aria-checked", "false");
  });

  it("instructs the operator to enter the passphrase without enabling auto-unlock", async () => {
    render(<VaultTab />);
    const checkbox = await screen.findByRole("checkbox", {
      name: "Auto-unlock on app startup",
    });
    invokeMock.mockClear();

    fireEvent.click(checkbox);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter the passphrase above and try again.",
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("enables auto-unlock from the existing passphrase field and refreshes envelope metadata", async () => {
    render(<VaultTab />);
    const checkbox = await screen.findByRole("checkbox", {
      name: "Auto-unlock on app startup",
    });
    invokeMock.mockClear();
    const syntheticPassphrase = "synthetic-vault-passphrase";

    fireEvent.change(screen.getByPlaceholderText("Passphrase"), {
      target: { value: syntheticPassphrase },
    });
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("vault_set_auto_unlock", {
        envelopeId: "topolograph-envelope",
        enabled: true,
        passphrase: syntheticPassphrase,
      });
    });
    expect(invokeMock.mock.calls.filter(([command]) => command === "vault_set_auto_unlock"))
      .toHaveLength(1);
    await waitFor(() => expect(checkbox).toBeChecked());
  });
});
