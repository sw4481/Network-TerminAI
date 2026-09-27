import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkflowExportImport } from "./WorkflowExportImport";
import type { Workflow } from "../lib/workflows";

const saveMock = vi.fn();
const openMock = vi.fn();
const writeMock = vi.fn();
const readMock = vi.fn();
const invokeMock = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...a: unknown[]) => saveMock(...a),
  open: (...a: unknown[]) => openMock(...a),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: (...a: unknown[]) => writeMock(...a),
  readTextFile: (...a: unknown[]) => readMock(...a),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}));

const sample: Workflow = {
  id: "1",
  name: "Test/sample",
  description: "",
  vendor: "cisco",
  platform: "iosxe",
  tags: [],
  created_at: 0,
  updated_at: 0,
  steps: [{ idx: 0, command_template: "show ver" }],
  params: [],
};

beforeEach(() => {
  saveMock.mockReset();
  openMock.mockReset();
  writeMock.mockReset();
  readMock.mockReset();
  invokeMock.mockReset();
});

describe("WorkflowExportImport", () => {
  it("exports a workflow to a .yaml file (sanitizing the filename)", async () => {
    saveMock.mockResolvedValueOnce("/tmp/test.yaml");
    writeMock.mockResolvedValueOnce(undefined);
    const onExported = vi.fn();
    render(
      <WorkflowExportImport
        workflow={sample}
        onExported={onExported}
        onImported={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /export yaml/i }));
    await waitFor(() =>
      expect(onExported).toHaveBeenCalledWith("/tmp/test.yaml"),
    );
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "Test_sample.yaml",
      }),
    );
    expect(writeMock).toHaveBeenCalled();
  });

  it("does not export if user cancels save dialog", async () => {
    saveMock.mockResolvedValueOnce(null);
    const onExported = vi.fn();
    render(
      <WorkflowExportImport
        workflow={sample}
        onExported={onExported}
        onImported={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /export yaml/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(writeMock).not.toHaveBeenCalled();
    expect(onExported).not.toHaveBeenCalled();
  });

  it("imports a workflow from a .yaml file (and rewrites id to allocate new uuid)", async () => {
    openMock.mockResolvedValueOnce("/tmp/in.yaml");
    readMock.mockResolvedValueOnce(
      `schema: ccie-workflow/v1\nname: Imported\ndescription: ""\nvendor: cisco\nplatform: iosxe\ntags: []\nparams: []\nsteps:\n  - idx: 0\n    command_template: show ver\n`,
    );
    invokeMock.mockResolvedValueOnce("new-uuid"); // workflow_upsert
    const onImported = vi.fn();
    render(
      <WorkflowExportImport
        workflow={null}
        onExported={vi.fn()}
        onImported={onImported}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /import yaml/i }));
    await waitFor(() =>
      expect(onImported).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Imported", id: "new-uuid" }),
      ),
    );
    // workflow_upsert should be called with id: "" so backend allocates uuid.
    expect(invokeMock).toHaveBeenCalledWith(
      "workflow_upsert",
      expect.objectContaining({
        workflow: expect.objectContaining({ id: "" }),
      }),
    );
  });

  it("calls onError when import YAML is malformed", async () => {
    openMock.mockResolvedValueOnce("/tmp/bad.yaml");
    readMock.mockResolvedValueOnce("schema: ccie-workflow/v9\nname: x\n");
    const onError = vi.fn();
    const onImported = vi.fn();
    render(
      <WorkflowExportImport
        workflow={null}
        onExported={vi.fn()}
        onImported={onImported}
        onError={onError}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /import yaml/i }));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onImported).not.toHaveBeenCalled();
  });

  it("hides Export button when no workflow is selected", () => {
    render(
      <WorkflowExportImport
        workflow={null}
        onExported={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /export yaml/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /import yaml/i }),
    ).toBeInTheDocument();
  });
});
