import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TemplateEditor } from "./TemplateEditor";
const ready = vi.hoisted(() => ({
  callback: undefined as undefined | ((editor: unknown) => void),
}));
vi.mock("../../components/editor/MonacoEditor", () => ({
  DEFAULT_EDITOR_SETTINGS: {},
  MonacoEditor: ({
    value,
    onChange,
    onEditorReady,
  }: {
    value: string;
    onChange(v: string): void;
    onEditorReady?: (editor: unknown) => void;
  }) => {
    ready.callback = onEditorReady;
    return (
      <textarea
        aria-label="TextFSM template"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  },
}));
it("configures the Telemetry editor before the house editor autofocuses", () => {
  render(
    <TemplateEditor
      draft={{
        id: "candidate",
        platform: "iosxe",
        command: "show version",
        text: "",
        sha256: "",
      }}
      sample={null}
      onChange={() => {}}
      onTest={() => {}}
    />,
  );
  const editor = { updateOptions: vi.fn() };
  ready.callback?.(editor);
  expect(editor.updateOptions).toHaveBeenCalledWith({
    occurrencesHighlight: "off",
  });
});
it("template_test_matches_capture_identity", () => {
  const onTest = vi.fn(),
    onChange = vi.fn();
  const sample = {
    capture_id: "retained-id",
    target_id: "a",
    platform: "iosxe" as const,
    command: "show processes cpu",
    parser_id: "original",
    revision: "physical",
    observed_at_ms: 1,
    monotonic_ms: 2,
    raw: "actual retained raw",
  };
  render(
    <TemplateEditor
      draft={{
        id: "candidate",
        platform: "iosxe",
        command: "show processes cpu",
        text: "Value CPU (\\d+)\n\nStart\n ^${CPU} -> Record\n",
        sha256: "",
      }}
      sample={sample}
      onChange={onChange}
      onTest={onTest}
    />,
  );
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "invalid template draft" },
  });
  expect(onChange).toHaveBeenCalledWith("invalid template draft");
  expect(onTest).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Test template" }));
  expect(onTest.mock.calls[0][0]).toBe("retained-id");
  expect(screen.getByText("actual retained raw")).toBeVisible();
});
