import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EndpointPicker } from "./EndpointPicker";
import type { ApiEndpoint } from "../../lib/tauri";

function e(
  id: string,
  method: ApiEndpoint["method"],
  path: string,
  name: string,
  description: string | null = null,
): ApiEndpoint {
  return {
    id,
    method,
    path,
    name,
    description,
    path_params: [],
    query_params: {},
  };
}

const fixture: ApiEndpoint[] = [
  e("list_orgs", "GET", "/organizations", "List Organizations"),
  e("get_org", "GET", "/organizations/{orgId}", "Get Organization"),
  e(
    "list_networks",
    "GET",
    "/organizations/{orgId}/networks",
    "List Networks",
  ),
  e("create_network", "POST", "/organizations/{orgId}/networks", "Create Network"),
];

describe("EndpointPicker", () => {
  it("renders every endpoint when search is empty", () => {
    render(
      <EndpointPicker
        endpoints={fixture}
        value={null}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("api-endpoint-row-list_orgs")).toBeDefined();
    expect(screen.getByTestId("api-endpoint-row-create_network")).toBeDefined();
  });

  it("filters by name substring (case-insensitive)", () => {
    render(
      <EndpointPicker
        endpoints={fixture}
        value={null}
        onChange={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId("api-endpoint-search"), {
      target: { value: "netw" },
    });
    expect(screen.queryByTestId("api-endpoint-row-list_orgs")).toBeNull();
    expect(screen.getByTestId("api-endpoint-row-list_networks")).toBeDefined();
    expect(screen.getByTestId("api-endpoint-row-create_network")).toBeDefined();
  });

  it("filters by method", () => {
    render(
      <EndpointPicker
        endpoints={fixture}
        value={null}
        onChange={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId("api-endpoint-search"), {
      target: { value: "post" },
    });
    expect(screen.queryByTestId("api-endpoint-row-list_orgs")).toBeNull();
    expect(screen.getByTestId("api-endpoint-row-create_network")).toBeDefined();
  });

  it("shows empty state when no endpoints match", () => {
    render(
      <EndpointPicker
        endpoints={fixture}
        value={null}
        onChange={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId("api-endpoint-search"), {
      target: { value: "zzzz-never" },
    });
    expect(screen.getByTestId("api-endpoint-empty")).toBeDefined();
  });

  it("fires onChange with the full endpoint on click", () => {
    const onChange = vi.fn();
    render(
      <EndpointPicker
        endpoints={fixture}
        value={null}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("api-endpoint-row-get_org"));
    expect(onChange).toHaveBeenCalledOnce();
    const arg = onChange.mock.calls[0][0];
    expect(arg.id).toBe("get_org");
    expect(arg.path).toBe("/organizations/{orgId}");
  });

  it("highlights the currently-selected endpoint", () => {
    render(
      <EndpointPicker
        endpoints={fixture}
        value="list_networks"
        onChange={() => {}}
      />,
    );
    const row = screen.getByTestId("api-endpoint-row-list_networks");
    // Selected row has distinct background. We just check it's NOT transparent.
    const bg = (row as HTMLElement).style.background;
    expect(bg).not.toBe("transparent");
    expect(bg).not.toBe("");
  });
});
