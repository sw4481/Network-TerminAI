import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { FanoutGroupsPanel } from "./FanoutGroupsPanel";
import { useFanoutStore } from "../state/fanoutStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockInvoke.mockReset();
  useFanoutStore.setState({
    groups: [],
    membersByGroup: {},
    loading: false,
    error: null,
  });
});

describe("FanoutGroupsPanel", () => {
  it("renders empty state when no groups exist", async () => {
    mockInvoke.mockResolvedValueOnce([]);
    render(<FanoutGroupsPanel />);
    await waitFor(() => {
      expect(screen.getByText(/No groups yet/i)).toBeInTheDocument();
    });
  });

  it("lists groups from the store", async () => {
    useFanoutStore.setState({
      groups: [
        {
          id: "g1",
          name: "site-atl",
          description: null,
          created_at: 0,
          updated_at: 0,
          member_count: 5,
        },
        {
          id: "g2",
          name: "site-bos",
          description: "boston",
          created_at: 0,
          updated_at: 0,
          member_count: 0,
        },
      ],
    });
    mockInvoke.mockResolvedValueOnce([]); // refreshGroups call
    render(<FanoutGroupsPanel />);
    expect(screen.getByText("site-atl")).toBeInTheDocument();
    expect(screen.getByText("site-bos")).toBeInTheDocument();
    expect(screen.getByText("5 devices")).toBeInTheDocument();
  });

  it("creates a group via an inline input (no blocked window.prompt)", async () => {
    // window.prompt returns null in the Tauri webview, so the panel must use
    // an inline input instead. Clicking "+ New" reveals an input; submitting
    // it invokes fanout_group_create.
    mockInvoke.mockResolvedValueOnce([]); // refreshGroups
    render(<FanoutGroupsPanel />);

    fireEvent.click(screen.getByTestId("fanout-new-group"));
    const input = await screen.findByTestId("fanout-new-group-input");

    mockInvoke.mockResolvedValueOnce({
      id: "g-new",
      name: "site-nyc",
      description: null,
      created_at: 0,
      updated_at: 0,
      member_count: 0,
    });
    fireEvent.change(input, { target: { value: "site-nyc" } });
    fireEvent.submit(input);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("fanout_group_create", {
        name: "site-nyc",
        description: null,
      });
    });
  });

  it("does not create a group when the inline input is blank", async () => {
    mockInvoke.mockResolvedValueOnce([]); // refreshGroups
    render(<FanoutGroupsPanel />);

    fireEvent.click(screen.getByTestId("fanout-new-group"));
    const input = await screen.findByTestId("fanout-new-group-input");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input);

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "fanout_group_create",
      expect.anything(),
    );
  });

  it("shows the prompt to select a group on the right pane", () => {
    useFanoutStore.setState({
      groups: [
        {
          id: "g1",
          name: "x",
          description: null,
          created_at: 0,
          updated_at: 0,
          member_count: 0,
        },
      ],
    });
    mockInvoke.mockResolvedValue([]);
    render(<FanoutGroupsPanel />);
    expect(
      screen.getByText(/Select a group to view its devices/i),
    ).toBeInTheDocument();
  });
});
