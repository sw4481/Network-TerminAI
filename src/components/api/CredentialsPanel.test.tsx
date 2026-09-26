import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CredentialsPanel } from "./CredentialsPanel";

const apiGetEnvVarsMock = vi.fn();
const apiSetEnvVarMock = vi.fn();
const apiDeleteEnvVarMock = vi.fn();

vi.mock("../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...actual,
    apiGetEnvVars: (...args: unknown[]) => apiGetEnvVarsMock(...args),
    apiSetEnvVar: (...args: unknown[]) => apiSetEnvVarMock(...args),
    apiDeleteEnvVar: (...args: unknown[]) => apiDeleteEnvVarMock(...args),
  };
});

describe("CredentialsPanel", () => {
  beforeEach(() => {
    apiGetEnvVarsMock.mockReset();
    apiSetEnvVarMock.mockReset();
    apiDeleteEnvVarMock.mockReset();
    apiSetEnvVarMock.mockResolvedValue(undefined);
    apiDeleteEnvVarMock.mockResolvedValue(undefined);
  });

  it("renders empty state when no vars exist", async () => {
    apiGetEnvVarsMock.mockResolvedValue([]);
    render(<CredentialsPanel environment="lab" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-credentials-empty")).toBeDefined(),
    );
  });

  it("lists existing variables; masks secrets by default", async () => {
    apiGetEnvVarsMock.mockResolvedValue([
      { key: "MERAKI_API_KEY", value: "deadbeef", is_secret: true },
      { key: "MERAKI_ORG_ID", value: "L_9", is_secret: false },
    ]);
    render(<CredentialsPanel environment="lab" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-credentials-row-MERAKI_API_KEY")).toBeDefined(),
    );
    // Value is held in an editable input; the DOM value matches the stored
    // value, but the input's type = password masks it visually.
    const secretInput = screen.getByTestId(
      "api-credentials-value-MERAKI_API_KEY",
    ) as HTMLInputElement;
    expect(secretInput.value).toBe("deadbeef");
    expect(secretInput.type).toBe("password");
    const plainInput = screen.getByTestId(
      "api-credentials-value-MERAKI_ORG_ID",
    ) as HTMLInputElement;
    expect(plainInput.value).toBe("L_9");
    expect(plainInput.type).toBe("text");
  });

  it("reveal toggle flips the secret input to type=text", async () => {
    apiGetEnvVarsMock.mockResolvedValue([
      { key: "TOKEN", value: "deadbeef", is_secret: true },
    ]);
    render(<CredentialsPanel environment="lab" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-credentials-reveal-TOKEN")).toBeDefined(),
    );
    const input = screen.getByTestId(
      "api-credentials-value-TOKEN",
    ) as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.click(screen.getByTestId("api-credentials-reveal-TOKEN"));
    expect(
      (screen.getByTestId("api-credentials-value-TOKEN") as HTMLInputElement)
        .type,
    ).toBe("text");
  });

  it("editing the value and blurring commits via apiSetEnvVar", async () => {
    apiGetEnvVarsMock.mockResolvedValue([
      { key: "MERAKI_API_KEY", value: "", is_secret: true },
    ]);
    render(<CredentialsPanel environment="lab" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-credentials-value-MERAKI_API_KEY")).toBeDefined(),
    );
    const input = screen.getByTestId(
      "api-credentials-value-MERAKI_API_KEY",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "deadbeef" } });
    // "unsaved" badge appears while draft != stored
    expect(
      screen.getByTestId("api-credentials-dirty-MERAKI_API_KEY"),
    ).toBeDefined();
    apiGetEnvVarsMock.mockResolvedValueOnce([
      { key: "MERAKI_API_KEY", value: "deadbeef", is_secret: true },
    ]);
    fireEvent.blur(input);
    await waitFor(() =>
      expect(apiSetEnvVarMock).toHaveBeenCalledWith({
        environment: "lab",
        key: "MERAKI_API_KEY",
        value: "deadbeef",
        isSecret: true,
      }),
    );
  });

  it("Enter commits the edit; Escape reverts the draft", async () => {
    apiGetEnvVarsMock.mockResolvedValue([
      { key: "T", value: "original", is_secret: false },
    ]);
    render(<CredentialsPanel environment="lab" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-credentials-value-T")).toBeDefined(),
    );
    const input = screen.getByTestId(
      "api-credentials-value-T",
    ) as HTMLInputElement;
    // Edit then Escape → no backend call, input reverts.
    fireEvent.change(input, { target: { value: "scratch" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(apiSetEnvVarMock).not.toHaveBeenCalled();
    expect(
      (screen.getByTestId("api-credentials-value-T") as HTMLInputElement).value,
    ).toBe("original");

    // Edit then click save → commits.
    apiGetEnvVarsMock.mockResolvedValueOnce([
      { key: "T", value: "committed", is_secret: false },
    ]);
    const again = screen.getByTestId(
      "api-credentials-value-T",
    ) as HTMLInputElement;
    fireEvent.change(again, { target: { value: "committed" } });
    fireEvent.click(screen.getByTestId("api-credentials-save-T"));
    await waitFor(() =>
      expect(apiSetEnvVarMock).toHaveBeenCalledWith({
        environment: "lab",
        key: "T",
        value: "committed",
        isSecret: false,
      }),
    );
  });

  it("adds a new variable via the Add row", async () => {
    apiGetEnvVarsMock.mockResolvedValue([]);
    render(<CredentialsPanel environment="lab" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-credentials-empty")).toBeDefined(),
    );
    fireEvent.change(screen.getByTestId("api-credentials-new-key"), {
      target: { value: "MERAKI_API_KEY" },
    });
    fireEvent.change(screen.getByTestId("api-credentials-new-value"), {
      target: { value: "deadbeef" },
    });
    apiGetEnvVarsMock.mockResolvedValueOnce([
      { key: "MERAKI_API_KEY", value: "deadbeef", is_secret: true },
    ]);
    fireEvent.click(screen.getByTestId("api-credentials-add"));
    await waitFor(() => {
      expect(apiSetEnvVarMock).toHaveBeenCalledWith({
        environment: "lab",
        key: "MERAKI_API_KEY",
        value: "deadbeef",
        isSecret: true,
      });
    });
  });

  it("deletes a variable", async () => {
    apiGetEnvVarsMock.mockResolvedValue([
      { key: "GONE", value: "x", is_secret: false },
    ]);
    render(<CredentialsPanel environment="lab" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-credentials-row-GONE")).toBeDefined(),
    );
    apiGetEnvVarsMock.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByTestId("api-credentials-delete-GONE"));
    await waitFor(() => {
      expect(apiDeleteEnvVarMock).toHaveBeenCalledWith("lab", "GONE");
    });
  });

  it("toggling the secret checkbox fires a set_var call to update metadata", async () => {
    apiGetEnvVarsMock.mockResolvedValue([
      { key: "TOKEN", value: "abc", is_secret: false },
    ]);
    render(<CredentialsPanel environment="lab" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-credentials-secret-TOKEN")).toBeDefined(),
    );
    fireEvent.click(screen.getByTestId("api-credentials-secret-TOKEN"));
    await waitFor(() => {
      expect(apiSetEnvVarMock).toHaveBeenCalledWith({
        environment: "lab",
        key: "TOKEN",
        value: "abc",
        isSecret: true,
      });
    });
  });

  it("Add button is disabled until both fields are non-empty", async () => {
    apiGetEnvVarsMock.mockResolvedValue([]);
    render(<CredentialsPanel environment="lab" onClose={() => {}} />);
    await waitFor(() => expect(apiGetEnvVarsMock).toHaveBeenCalled());
    const add = screen.getByTestId("api-credentials-add") as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("api-credentials-new-key"), {
      target: { value: "K" },
    });
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("api-credentials-new-value"), {
      target: { value: "V" },
    });
    expect(add.disabled).toBe(false);
  });

  it("close button calls onClose", async () => {
    apiGetEnvVarsMock.mockResolvedValue([]);
    const onClose = vi.fn();
    render(<CredentialsPanel environment="lab" onClose={onClose} />);
    await waitFor(() => expect(apiGetEnvVarsMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("api-credentials-close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("surfaces backend errors without crashing the panel", async () => {
    apiGetEnvVarsMock.mockRejectedValue(new Error("disk full"));
    render(<CredentialsPanel environment="lab" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-credentials-error").textContent).toContain(
        "disk full",
      ),
    );
  });

  it("shows the 'missing required' banner when required keys aren't set", async () => {
    apiGetEnvVarsMock.mockResolvedValue([
      { key: "OTHER", value: "x", is_secret: false },
    ]);
    render(
      <CredentialsPanel
        environment="lab"
        onClose={() => {}}
        requiredKeys={["MERAKI_API_KEY", "OTHER", "ANOTHER_MISSING"]}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("api-credentials-missing")).toBeDefined(),
    );
    const banner = screen.getByTestId("api-credentials-missing");
    expect(banner.textContent).toContain("MERAKI_API_KEY");
    expect(banner.textContent).toContain("ANOTHER_MISSING");
    // OTHER exists, so it must NOT appear in the "missing" list.
    expect(banner.textContent).not.toContain("OTHER,");
    expect(banner.textContent).not.toContain(", OTHER");
  });

  it("'Add missing rows' button creates empty rows for every missing key", async () => {
    apiGetEnvVarsMock.mockResolvedValue([]);
    render(
      <CredentialsPanel
        environment="lab"
        onClose={() => {}}
        requiredKeys={["MERAKI_API_KEY", "MERAKI_ORG_ID"]}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("api-credentials-add-required")).toBeDefined(),
    );
    apiGetEnvVarsMock.mockResolvedValueOnce([
      { key: "MERAKI_API_KEY", value: "", is_secret: true },
      { key: "MERAKI_ORG_ID", value: "", is_secret: true },
    ]);
    fireEvent.click(screen.getByTestId("api-credentials-add-required"));
    await waitFor(() =>
      expect(apiSetEnvVarMock).toHaveBeenCalledTimes(2),
    );
    expect(apiSetEnvVarMock.mock.calls[0][0].key).toBe("MERAKI_API_KEY");
    expect(apiSetEnvVarMock.mock.calls[1][0].key).toBe("MERAKI_ORG_ID");
  });

  it("does NOT show the banner when every required key exists", async () => {
    apiGetEnvVarsMock.mockResolvedValue([
      { key: "MERAKI_API_KEY", value: "deadbeef", is_secret: true },
    ]);
    render(
      <CredentialsPanel
        environment="lab"
        onClose={() => {}}
        requiredKeys={["MERAKI_API_KEY"]}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("api-credentials-row-MERAKI_API_KEY"),
      ).toBeDefined(),
    );
    expect(screen.queryByTestId("api-credentials-missing")).toBeNull();
  });

  describe("Quick Setup preset section", () => {
    it("renders a tab for every built-in preset", async () => {
      apiGetEnvVarsMock.mockResolvedValue([]);
      render(<CredentialsPanel environment="lab" onClose={() => {}} />);
      await waitFor(() =>
        expect(screen.getByTestId("api-credentials-presets")).toBeDefined(),
      );
      expect(screen.getByTestId("api-credentials-preset-meraki")).toBeDefined();
      expect(
        screen.getByTestId("api-credentials-preset-catalyst_center"),
      ).toBeDefined();
      expect(screen.getByTestId("api-credentials-preset-ise")).toBeDefined();
      expect(screen.getByTestId("api-credentials-preset-sna")).toBeDefined();
    });

    it("auto-selects the matching preset when targetId is set", async () => {
      apiGetEnvVarsMock.mockResolvedValue([]);
      render(
        <CredentialsPanel
          environment="lab"
          onClose={() => {}}
          targetId="ise"
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("api-preset-ISE_HOST")).toBeDefined(),
      );
      // Meraki fields should NOT be rendered since ISE is active.
      expect(screen.queryByTestId("api-preset-MERAKI_API_KEY")).toBeNull();
    });

    it("typing into a preset field and blurring saves to the right env var name", async () => {
      apiGetEnvVarsMock.mockResolvedValue([]);
      render(
        <CredentialsPanel
          environment="lab"
          onClose={() => {}}
          targetId="meraki"
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("api-preset-MERAKI_API_KEY")).toBeDefined(),
      );
      const input = screen.getByTestId(
        "api-preset-MERAKI_API_KEY",
      ) as HTMLInputElement;
      // Labeled as "API Key" for humans, but the env var name under the
      // hood is MERAKI_API_KEY — exactly what the manifest references.
      expect(input.type).toBe("password");
      fireEvent.change(input, { target: { value: "deadbeef" } });
      apiGetEnvVarsMock.mockResolvedValueOnce([
        { key: "MERAKI_API_KEY", value: "deadbeef", is_secret: true },
      ]);
      fireEvent.click(screen.getByTestId("api-preset-save-MERAKI_API_KEY"));
      await waitFor(() =>
        expect(apiSetEnvVarMock).toHaveBeenCalledWith({
          environment: "lab",
          key: "MERAKI_API_KEY",
          value: "deadbeef",
          isSecret: true,
        }),
      );
    });

    it("non-secret preset field saves with isSecret=false (Meraki organizationId)", async () => {
      apiGetEnvVarsMock.mockResolvedValue([]);
      render(
        <CredentialsPanel
          environment="lab"
          onClose={() => {}}
          targetId="meraki"
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("api-preset-organizationId")).toBeDefined(),
      );
      const input = screen.getByTestId(
        "api-preset-organizationId",
      ) as HTMLInputElement;
      // Not a secret → plain text input, no reveal button.
      expect(input.type).toBe("text");
      expect(
        screen.queryByTestId("api-preset-reveal-organizationId"),
      ).toBeNull();
      fireEvent.change(input, { target: { value: "L_123456" } });
      apiGetEnvVarsMock.mockResolvedValueOnce([
        { key: "organizationId", value: "L_123456", is_secret: false },
      ]);
      fireEvent.click(screen.getByTestId("api-preset-save-organizationId"));
      await waitFor(() =>
        expect(apiSetEnvVarMock).toHaveBeenCalledWith({
          environment: "lab",
          key: "organizationId",
          value: "L_123456",
          isSecret: false,
        }),
      );
    });

    it("clicking a different preset tab swaps the visible fields", async () => {
      apiGetEnvVarsMock.mockResolvedValue([]);
      render(
        <CredentialsPanel
          environment="lab"
          onClose={() => {}}
          targetId="meraki"
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("api-preset-MERAKI_API_KEY")).toBeDefined(),
      );
      fireEvent.click(screen.getByTestId("api-credentials-preset-catalyst_center"));
      await waitFor(() =>
        expect(screen.getByTestId("api-preset-DNAC_HOST")).toBeDefined(),
      );
      expect(screen.queryByTestId("api-preset-MERAKI_API_KEY")).toBeNull();
    });

    it("pre-fills preset inputs with existing env values", async () => {
      apiGetEnvVarsMock.mockResolvedValue([
        { key: "MERAKI_API_KEY", value: "existing-token", is_secret: true },
        { key: "organizationId", value: "L_42", is_secret: false },
      ]);
      render(
        <CredentialsPanel
          environment="lab"
          onClose={() => {}}
          targetId="meraki"
        />,
      );
      await waitFor(() => {
        const a = screen.getByTestId(
          "api-preset-MERAKI_API_KEY",
        ) as HTMLInputElement;
        const o = screen.getByTestId(
          "api-preset-organizationId",
        ) as HTMLInputElement;
        expect(a.value).toBe("existing-token");
        expect(o.value).toBe("L_42");
      });
    });
  });
});
