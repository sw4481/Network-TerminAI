import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TargetPicker, CUSTOM_TARGET_ID } from "./TargetPicker";

const apiListTargetsMock = vi.fn();

vi.mock("../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...actual,
    apiListTargets: (...args: unknown[]) => apiListTargetsMock(...args),
  };
});

describe("TargetPicker", () => {
  beforeEach(() => {
    apiListTargetsMock.mockReset();
  });

  it("always renders the Custom option, even before targets load", () => {
    apiListTargetsMock.mockReturnValue(new Promise(() => {}));
    render(<TargetPicker value={CUSTOM_TARGET_ID} onChange={() => {}} />);
    const select = screen.getByTestId("api-target-select") as HTMLSelectElement;
    const custom = Array.from(select.options).find(
      (o) => o.value === CUSTOM_TARGET_ID,
    );
    expect(custom).toBeDefined();
  });

  it("populates dropdown with fetched targets", async () => {
    apiListTargetsMock.mockResolvedValue([
      {
        id: "meraki",
        display_name: "Cisco Meraki Dashboard",
        base_url: "https://api.meraki.com/api/v1",
        builtin: true,
        has_openapi: false,
        endpoint_count: 5,
      },
      {
        id: "labgear",
        display_name: "Lab Gear",
        base_url: "https://lab",
        builtin: false,
        has_openapi: false,
        endpoint_count: 0,
      },
    ]);
    render(<TargetPicker value={CUSTOM_TARGET_ID} onChange={() => {}} />);
    await waitFor(() => {
      const select = screen.getByTestId("api-target-select") as HTMLSelectElement;
      const values = Array.from(select.options).map((o) => o.value);
      expect(values).toContain("meraki");
      expect(values).toContain("labgear");
    });
    const merakiOption = Array.from(
      (screen.getByTestId("api-target-select") as HTMLSelectElement).options,
    ).find((o) => o.value === "meraki");
    expect(merakiOption?.textContent).toContain("builtin");
  });

  it("fires onChange when user selects a target", async () => {
    apiListTargetsMock.mockResolvedValue([
      {
        id: "meraki",
        display_name: "Meraki",
        base_url: "x",
        builtin: true,
        has_openapi: false,
        endpoint_count: 0,
      },
    ]);
    const onChange = vi.fn();
    render(<TargetPicker value={CUSTOM_TARGET_ID} onChange={onChange} />);
    await waitFor(() => {
      expect(
        (screen.getByTestId("api-target-select") as HTMLSelectElement).options
          .length,
      ).toBeGreaterThan(1);
    });
    fireEvent.change(screen.getByTestId("api-target-select"), {
      target: { value: "meraki" },
    });
    expect(onChange).toHaveBeenCalledWith("meraki");
  });

  it("surfaces API errors inline without crashing", async () => {
    apiListTargetsMock.mockRejectedValue(new Error("boom: dir missing"));
    render(<TargetPicker value={CUSTOM_TARGET_ID} onChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("api-target-error").textContent).toContain(
        "boom",
      );
    });
  });
});
