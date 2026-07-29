import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StateDrawer } from "./StateDrawer";
import { useIacStateStore } from "../state/iacStateStore";

beforeEach(() => {
  useIacStateStore.setState({
    open: true,
    projectPath: "/infra/dev",
    pathDraft: "/infra/dev",
    resources: [
      { resourceType: "aws_security_group", resourceName: "alb",
        address: "aws_security_group.alb", resourceId: "sg-abc", attributes: {} },
    ],
    query: "",
    loading: false,
    error: null,
    drift: null,
    exceptions: [],
    driftLoading: false,
  });
});

describe("StateDrawer", () => {
  it("lists resources grouped by type", () => {
    render(<StateDrawer />);
    expect(screen.getByText("aws_security_group.alb")).toBeTruthy();
  });

  it("shows an empty state when there are no resources", () => {
    useIacStateStore.setState({ resources: [] });
    render(<StateDrawer />);
    expect(screen.getByText(/No Terraform state found/i)).toBeTruthy();
  });

  it("renders nothing when closed", () => {
    useIacStateStore.setState({ open: false });
    const { container } = render(<StateDrawer />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the current project directory in the selector", () => {
    render(<StateDrawer />);
    const input = screen.getByLabelText("Project directory") as HTMLInputElement;
    expect(input.value).toBe("/infra/dev");
  });

  it("loads a new directory when the path is changed and submitted", () => {
    const setProjectPath = vi.fn();
    useIacStateStore.setState({ setProjectPath });
    render(<StateDrawer />);
    const input = screen.getByLabelText("Project directory");
    fireEvent.change(input, { target: { value: "/tmp/tf-drift-test" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setProjectPath).toHaveBeenCalledWith("/tmp/tf-drift-test");
  });
});
