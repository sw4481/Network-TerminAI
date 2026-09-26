import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EnvironmentPicker, NO_ENVIRONMENT } from "./EnvironmentPicker";

const apiListEnvironmentsMock = vi.fn();
const apiCreateEnvironmentMock = vi.fn();

vi.mock("../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...actual,
    apiListEnvironments: (...args: unknown[]) =>
      apiListEnvironmentsMock(...args),
    apiCreateEnvironment: (...args: unknown[]) =>
      apiCreateEnvironmentMock(...args),
  };
});

describe("EnvironmentPicker", () => {
  beforeEach(() => {
    apiListEnvironmentsMock.mockReset();
    apiCreateEnvironmentMock.mockReset();
  });

  it("renders the empty-state option even before envs load", () => {
    apiListEnvironmentsMock.mockReturnValue(new Promise(() => {}));
    render(<EnvironmentPicker value={NO_ENVIRONMENT} onChange={() => {}} />);
    const select = screen.getByTestId("api-env-select") as HTMLSelectElement;
    expect(
      Array.from(select.options).some((o) => o.value === NO_ENVIRONMENT),
    ).toBe(true);
  });

  it("populates the dropdown with fetched envs", async () => {
    apiListEnvironmentsMock.mockResolvedValue(["lab", "prod"]);
    render(<EnvironmentPicker value={NO_ENVIRONMENT} onChange={() => {}} />);
    await waitFor(() => {
      const select = screen.getByTestId("api-env-select") as HTMLSelectElement;
      const values = Array.from(select.options).map((o) => o.value);
      expect(values).toEqual(["", "lab", "prod"]);
    });
  });

  it("fires onChange when selecting an env", async () => {
    apiListEnvironmentsMock.mockResolvedValue(["lab"]);
    const onChange = vi.fn();
    render(<EnvironmentPicker value={NO_ENVIRONMENT} onChange={onChange} />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("api-env-select") as HTMLSelectElement).options
          .length,
      ).toBeGreaterThan(1),
    );
    fireEvent.change(screen.getByTestId("api-env-select"), {
      target: { value: "lab" },
    });
    expect(onChange).toHaveBeenCalledWith("lab");
  });

  it("adds a new env and selects it", async () => {
    apiListEnvironmentsMock.mockResolvedValue([]);
    apiCreateEnvironmentMock.mockResolvedValue(true);
    const onChange = vi.fn();
    render(<EnvironmentPicker value={NO_ENVIRONMENT} onChange={onChange} />);
    await waitFor(() => expect(apiListEnvironmentsMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("api-env-add"));
    fireEvent.change(screen.getByTestId("api-env-new-name"), {
      target: { value: "staging" },
    });
    apiListEnvironmentsMock.mockResolvedValueOnce(["staging"]);
    fireEvent.click(screen.getByTestId("api-env-save"));

    await waitFor(() => {
      expect(apiCreateEnvironmentMock).toHaveBeenCalledWith("staging");
    });
    expect(onChange).toHaveBeenCalledWith("staging");
  });

  it("Enter on the add input commits, Escape aborts", async () => {
    apiListEnvironmentsMock.mockResolvedValue([]);
    apiCreateEnvironmentMock.mockResolvedValue(true);
    render(<EnvironmentPicker value={NO_ENVIRONMENT} onChange={() => {}} />);
    await waitFor(() => expect(apiListEnvironmentsMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("api-env-add"));
    fireEvent.change(screen.getByTestId("api-env-new-name"), {
      target: { value: "lab" },
    });
    fireEvent.keyDown(screen.getByTestId("api-env-new-name"), { key: "Enter" });
    await waitFor(() =>
      expect(apiCreateEnvironmentMock).toHaveBeenCalledWith("lab"),
    );

    // Now re-open add, type, escape → should not call create.
    apiCreateEnvironmentMock.mockClear();
    fireEvent.click(screen.getByTestId("api-env-add"));
    fireEvent.change(screen.getByTestId("api-env-new-name"), {
      target: { value: "rollback" },
    });
    fireEvent.keyDown(screen.getByTestId("api-env-new-name"), { key: "Escape" });
    expect(apiCreateEnvironmentMock).not.toHaveBeenCalled();
  });

  it("credentials button is disabled when no env is selected", async () => {
    apiListEnvironmentsMock.mockResolvedValue(["lab"]);
    render(
      <EnvironmentPicker
        value={NO_ENVIRONMENT}
        onChange={() => {}}
        onOpenCredentials={() => {}}
      />,
    );
    await waitFor(() => expect(apiListEnvironmentsMock).toHaveBeenCalled());
    const btn = screen.getByTestId("api-env-credentials") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("credentials button fires callback when env selected", async () => {
    apiListEnvironmentsMock.mockResolvedValue(["lab"]);
    const onOpen = vi.fn();
    render(
      <EnvironmentPicker
        value="lab"
        onChange={() => {}}
        onOpenCredentials={onOpen}
      />,
    );
    await waitFor(() => expect(apiListEnvironmentsMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("api-env-credentials"));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("surfaces list errors inline", async () => {
    apiListEnvironmentsMock.mockRejectedValue(new Error("perm denied"));
    render(<EnvironmentPicker value={NO_ENVIRONMENT} onChange={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("api-env-error").textContent).toContain(
        "perm denied",
      ),
    );
  });
});
