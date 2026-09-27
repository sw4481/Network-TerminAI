import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
