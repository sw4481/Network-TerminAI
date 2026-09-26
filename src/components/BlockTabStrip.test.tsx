import { render, fireEvent, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { BlockTabStrip } from "./BlockTabStrip";

describe("BlockTabStrip", () => {
  it("renders three tabs", () => {
    render(<BlockTabStrip viewMode="raw" onChange={vi.fn()} />);
    expect(screen.getByTestId("block-tab-raw")).toBeInTheDocument();
    expect(screen.getByTestId("block-tab-structured")).toBeInTheDocument();
    expect(screen.getByTestId("block-tab-diff")).toBeInTheDocument();
  });

  it("marks the active tab with aria-selected=true", () => {
    render(<BlockTabStrip viewMode="structured" onChange={vi.fn()} />);
    expect(
      screen.getByTestId("block-tab-structured").getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByTestId("block-tab-raw").getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("calls onChange when a tab is clicked", () => {
    const onChange = vi.fn();
    render(<BlockTabStrip viewMode="raw" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("block-tab-structured"));
    expect(onChange).toHaveBeenCalledWith("structured");
  });

  it("disables Diff tab when diffEnabled=false", () => {
    const onChange = vi.fn();
    render(<BlockTabStrip viewMode="raw" onChange={onChange} diffEnabled={false} />);
    const diff = screen.getByTestId("block-tab-diff");
    expect(diff.hasAttribute("disabled")).toBe(true);
    fireEvent.click(diff);
    expect(onChange).not.toHaveBeenCalled();
  });
});
