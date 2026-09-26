import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { IntentEditor } from "./IntentEditor";
import { useIntentStore } from "../state/intentStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
// Stub Monaco so we don't load the heavy editor in jsdom
vi.mock("./editor/MonacoEditor", () => ({
  MonacoEditor: ({ value }: { value: string }) => (
    <div data-testid="mock-monaco">{value}</div>
  ),
}));

beforeEach(() => {
  useIntentStore.setState({
    templates: [],
    selectedId: null,
    loading: false,
    error: null,
  });
});

describe("IntentEditor", () => {
  it("renders empty state when no templates", async () => {
    render(<IntentEditor />);
    await waitFor(() =>
      expect(screen.getByText(/No intent templates yet/i)).toBeInTheDocument(),
    );
  });

  it("lists templates and shows the selected one's body", () => {
    useIntentStore.setState({
      templates: [
        {
          id: "g1",
          name: "core-golden",
          vendor: "cisco",
          platform: "iosxe",
          kind: "golden",
          body: "hostname core-01",
          vars_yaml: "",
          selector: { device_ids: [], tags: ["core"] },
          match_mode: "baseline",
          created_at: 0,
          updated_at: 0,
        },
      ],
      selectedId: "g1",
    });
    render(<IntentEditor />);
    // List entry renders synchronously; the Monaco editor is lazy-loaded
    // and never resolves under jsdom (its dynamic import has no synchronous
    // fallback in this harness), so we don't assert on the editor itself.
    expect(screen.getByText("core-golden")).toBeInTheDocument();
    expect(screen.getByTestId("intent-tab-body")).toBeInTheDocument();
  });

  it("creates a template via an inline input (no blocked window.prompt)", async () => {
    // window.prompt returns null in the Tauri webview, so the editor must use
    // an inline input. Clicking "+ New" reveals it; submitting calls create.
    const createSpy = vi.fn(async () => {});
    useIntentStore.setState({ create: createSpy as never });

    render(<IntentEditor />);
    fireEvent.click(screen.getByTestId("intent-new"));
    const input = await screen.findByTestId("intent-new-input");

    fireEvent.change(input, { target: { value: "core-golden" } });
    fireEvent.submit(input);

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: "core-golden", kind: "golden" }),
      );
    });
  });

  it("does not create when the inline name input is blank", async () => {
    const createSpy = vi.fn(async () => {});
    useIntentStore.setState({ create: createSpy as never });

    render(<IntentEditor />);
    fireEvent.click(screen.getByTestId("intent-new"));
    const input = await screen.findByTestId("intent-new-input");
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.submit(input);

    expect(createSpy).not.toHaveBeenCalled();
  });

  it("renames via an inline input (no blocked window.prompt)", async () => {
    const renameSpy = vi.fn(async () => {});
    useIntentStore.setState({
      templates: [
        {
          id: "g1",
          name: "old-name",
          vendor: "cisco",
          platform: "iosxe",
          kind: "golden",
          body: "",
          vars_yaml: "",
          selector: { device_ids: [], tags: [] },
          match_mode: "baseline",
          created_at: 0,
          updated_at: 0,
        },
      ],
      selectedId: "g1",
      // refresh() runs on mount and would otherwise overwrite templates with
      // the mocked invoke's empty list, dropping the selection.
      refresh: (async () => {}) as never,
      rename: renameSpy as never,
    });

    render(<IntentEditor />);
    fireEvent.click(screen.getByTestId("intent-rename"));
    const input = await screen.findByTestId("intent-rename-input");
    fireEvent.change(input, { target: { value: "new-name" } });
    fireEvent.submit(input);

    await waitFor(() => {
      expect(renameSpy).toHaveBeenCalledWith("g1", "new-name");
    });
  });

  it("does not show vars tab for golden intents", () => {
    useIntentStore.setState({
      templates: [
        {
          id: "g1",
          name: "x",
          vendor: "cisco",
          platform: "iosxe",
          kind: "golden",
          body: "",
          vars_yaml: "",
          selector: { device_ids: [], tags: [] },
          match_mode: "baseline",
          created_at: 0,
          updated_at: 0,
        },
      ],
      selectedId: "g1",
    });
    render(<IntentEditor />);
    expect(screen.queryByTestId("intent-tab-vars")).not.toBeInTheDocument();
  });

  it("shows vars tab for jinja intents", () => {
    useIntentStore.setState({
      templates: [
        {
          id: "j1",
          name: "x",
          vendor: "cisco",
          platform: "iosxe",
          kind: "jinja",
          body: "",
          vars_yaml: "",
          selector: { device_ids: [], tags: [] },
          match_mode: "baseline",
          created_at: 0,
          updated_at: 0,
        },
      ],
      selectedId: "j1",
    });
    render(<IntentEditor />);
    expect(screen.getByTestId("intent-tab-vars")).toBeInTheDocument();
  });
});
