import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const getStructuredMock = vi.fn();
vi.mock("../lib/structured", () => ({
  getStructured: (...args: unknown[]) => getStructuredMock(...args),
}));

import { StructuredTab } from "./StructuredTab";

const baseList = {
  blockId: "b1",
  parser: "textfsm" as const,
  command: "show ip int br",
  vendor: "cisco",
  platform: "iosxe",
  data: [
    { interface: "Gi1", ip: "10.0.0.1", status: "up" },
    { interface: "Gi2", ip: "10.0.0.2", status: "down" },
    { interface: "Gi3", ip: "10.0.0.3", status: "up" },
  ],
  createdAt: 0,
};

const baseDict = {
  blockId: "b1",
  parser: "genie" as const,
  command: "show version",
  vendor: "cisco",
  platform: "iosxe",
  data: { hostname: "R1", uptime_days: 42, version: "17.09.04" },
  createdAt: 0,
};

describe("StructuredTab", () => {
  beforeEach(() => {
    getStructuredMock.mockReset();
  });

  it("renders TextFSM list as a table with columns from inferColumns", async () => {
    getStructuredMock.mockResolvedValue(baseList);
    render(<StructuredTab blockId="b1" />);
    await waitFor(() => screen.getByTestId("structured-table"));
    expect(screen.getByText("interface")).toBeInTheDocument();
    expect(screen.getByText("Gi1")).toBeInTheDocument();
    expect(screen.getByText("Gi2")).toBeInTheDocument();
  });

  it("renders Genie nested dict as flattened key/value rows", async () => {
    getStructuredMock.mockResolvedValue(baseDict);
    render(<StructuredTab blockId="b1" />);
    await waitFor(() => screen.getByTestId("structured-table"));
    expect(screen.getByText("hostname")).toBeInTheDocument();
    expect(screen.getByText("R1")).toBeInTheDocument();
    expect(screen.getByText("17.09.04")).toBeInTheDocument();
  });

  it("typing in a column filter narrows visible rows", async () => {
    getStructuredMock.mockResolvedValue(baseList);
    render(<StructuredTab blockId="b1" />);
    await waitFor(() => screen.getByTestId("structured-table"));
    const filter = screen.getByTestId("structured-filter-status");
    fireEvent.change(filter, { target: { value: "up" } });
    await waitFor(() => {
      expect(screen.getByText("Gi1")).toBeInTheDocument();
      expect(screen.queryByText("Gi2")).not.toBeInTheDocument();
      expect(screen.getByText("Gi3")).toBeInTheDocument();
    });
  });

  it("clicking a column header toggles sort", async () => {
    getStructuredMock.mockResolvedValue(baseList);
    render(<StructuredTab blockId="b1" />);
    await waitFor(() => screen.getByTestId("structured-table"));
    const header = screen.getByText("interface");
    fireEvent.click(header);
    expect(header.textContent).toContain("▲");
    fireEvent.click(header);
    expect(header.textContent).toContain("▼");
  });

  it("shows 'No parser available' when parsed is null", async () => {
    getStructuredMock.mockResolvedValue(null);
    render(<StructuredTab blockId="b1" />);
    await waitFor(() => screen.getByText("No parser available"));
  });

  it("calls onPinSnapshot when the toolbar button is clicked", async () => {
    getStructuredMock.mockResolvedValue(baseList);
    const onPin = vi.fn();
    render(<StructuredTab blockId="b1" onPinSnapshot={onPin} />);
    await waitFor(() => screen.getByTestId("structured-pin-snapshot"));
    fireEvent.click(screen.getByTestId("structured-pin-snapshot"));
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it("JSONPath input only appears for nested-dict data", async () => {
    getStructuredMock.mockResolvedValue(baseList);
    const { rerender } = render(<StructuredTab blockId="b1" />);
    await waitFor(() => screen.getByTestId("structured-table"));
    expect(screen.queryByTestId("structured-jsonpath")).not.toBeInTheDocument();

    getStructuredMock.mockResolvedValue(baseDict);
    rerender(<StructuredTab blockId="b2" />);
    await waitFor(() => screen.getByTestId("structured-jsonpath"));
  });
});
