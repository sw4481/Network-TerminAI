import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  TargetPicker,
  CUSTOM_TARGET_ID,
  CUSTOM_TARGET_SELECTION,
} from "./TargetPicker";

const apiListTargetsMock = vi.fn();
const apiListPostmanCollectionsMock = vi.fn();

vi.mock("../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...actual,
    apiListTargets: (...args: unknown[]) => apiListTargetsMock(...args),
    apiListPostmanCollections: (...args: unknown[]) =>
      apiListPostmanCollectionsMock(...args),
  };
});

describe("TargetPicker", () => {
  beforeEach(() => {
    apiListTargetsMock.mockReset();
    apiListPostmanCollectionsMock.mockReset();
    apiListPostmanCollectionsMock.mockResolvedValue([]);
  });

  it("always renders the Custom option, even before targets load", () => {
    apiListTargetsMock.mockReturnValue(new Promise(() => {}));
    render(<TargetPicker value={CUSTOM_TARGET_SELECTION} onChange={() => {}} />);
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
    apiListPostmanCollectionsMock.mockResolvedValue([
      {
        id: "meraki",
        name: "Imported Meraki",
        environment: "imported_meraki",
        request_count: 3,
      },
    ]);
    render(<TargetPicker value={CUSTOM_TARGET_SELECTION} onChange={() => {}} />);
    await waitFor(() => {
      const select = screen.getByTestId("api-target-select") as HTMLSelectElement;
      const values = Array.from(select.options).map((o) => o.value);
      expect(values).toContain("manifest:meraki");
      expect(values).toContain("manifest:labgear");
      expect(values).toContain("postman:meraki");
    });
    const merakiOption = Array.from(
      (screen.getByTestId("api-target-select") as HTMLSelectElement).options,
    ).find((o) => o.value === "manifest:meraki");
    expect(merakiOption?.textContent).toContain("builtin");
    const postmanOption = Array.from(
      (screen.getByTestId("api-target-select") as HTMLSelectElement).options,
    ).find((o) => o.value === "postman:meraki");
    expect(postmanOption?.textContent).toContain("Imported Meraki");
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
    render(<TargetPicker value={CUSTOM_TARGET_SELECTION} onChange={onChange} />);
    await waitFor(() => {
      expect(
        (screen.getByTestId("api-target-select") as HTMLSelectElement).options
          .length,
      ).toBeGreaterThan(1);
    });
    fireEvent.change(screen.getByTestId("api-target-select"), {
      target: { value: "manifest:meraki" },
    });
    expect(onChange).toHaveBeenCalledWith({ kind: "manifest", id: "meraki" });
  });

  it("surfaces API errors inline without crashing", async () => {
    apiListTargetsMock.mockRejectedValue(new Error("boom: dir missing"));
    render(<TargetPicker value={CUSTOM_TARGET_SELECTION} onChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("api-target-error").textContent).toContain(
        "boom",
      );
    });
  });
});
