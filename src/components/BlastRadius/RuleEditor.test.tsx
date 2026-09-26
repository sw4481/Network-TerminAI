import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RuleEditor } from "./RuleEditor";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

const sampleRules = [
  {
    id: "builtin-iosxe-reload",
    name: "IOS-XE reload",
    vendor: "cisco",
    platform: "iosxe",
    pattern_regex: "^\\s*reload\\b",
    tier: 3,
    reason: "Full device reload",
    enabled: true,
    builtin: true,
  },
  {
    id: "user-1",
    name: "My custom rule",
    vendor: "cisco",
    platform: "iosxe",
    pattern_regex: "^\\s*custom\\b",
    tier: 1,
    reason: "Custom",
    enabled: true,
    builtin: false,
  },
];

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "guardrail_rules_list") return sampleRules;
    if (cmd === "guardrail_test_regex") return { matched: true, error: null };
    if (cmd === "guardrail_rule_upsert") return "user-1";
    return null;
  });
});

describe("RuleEditor", () => {
  it("lists rules, marks builtin vs user", async () => {
    render(<RuleEditor />);
    await waitFor(() => screen.getByTestId("re-rule-builtin-iosxe-reload"));
    const builtinRow = screen.getByTestId("re-rule-builtin-iosxe-reload");
    expect(builtinRow).toHaveTextContent("IOS-XE reload");
    const userRow = screen.getByTestId("re-rule-user-1");
    expect(userRow).toHaveTextContent("My custom rule");
  });

  it("disables editing fields when a builtin rule is selected", async () => {
    render(<RuleEditor />);
    await waitFor(() => screen.getByTestId("re-rule-builtin-iosxe-reload"));
    fireEvent.click(screen.getByTestId("re-rule-builtin-iosxe-reload"));
    const name = screen.getByTestId("re-name") as HTMLInputElement;
    expect(name.disabled).toBe(true);
    const save = screen.getByTestId("re-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("filters rules by search", async () => {
    render(<RuleEditor />);
    await waitFor(() => screen.getByTestId("re-rule-user-1"));
    const search = screen.getByTestId("re-search") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "custom" } });
    expect(screen.queryByTestId("re-rule-builtin-iosxe-reload")).toBeNull();
    expect(screen.getByTestId("re-rule-user-1")).toBeInTheDocument();
  });

  it("runs regex test against the Rust engine via guardrail_test_regex", async () => {
    render(<RuleEditor />);
    await waitFor(() => screen.getByTestId("re-rule-user-1"));
    fireEvent.click(screen.getByTestId("re-rule-user-1"));
    fireEvent.change(screen.getByTestId("re-test-input"), {
      target: { value: "custom command" },
    });
    fireEvent.click(screen.getByTestId("re-test-btn"));
    await waitFor(() => screen.getByTestId("re-test-result"));
    expect(mockedInvoke).toHaveBeenCalledWith("guardrail_test_regex", {
      pattern: "^\\s*custom\\b",
      input: "custom command",
    });
    expect(screen.getByTestId("re-test-result").textContent).toMatch(/match/i);
  });

  it("Cmd+N creates a new rule draft", async () => {
    render(<RuleEditor />);
    await waitFor(() => screen.getByTestId("re-rule-user-1"));
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    expect((screen.getByTestId("re-name") as HTMLInputElement).value).toBe(
      "New rule",
    );
  });

  it("supports roving keyboard focus and explicit rule activation", async () => {
    render(<RuleEditor />);
    const builtin = await screen.findByTestId("re-rule-builtin-iosxe-reload");
    const custom = screen.getByTestId("re-rule-user-1");

    expect(builtin).toHaveAttribute("tabindex", "0");
    expect(custom).toHaveAttribute("tabindex", "-1");
    builtin.focus();

    fireEvent.keyDown(builtin, { key: "ArrowDown" });
    expect(custom).toHaveFocus();
    expect(custom).toHaveAttribute("tabindex", "0");
    expect(custom).toHaveAttribute("aria-selected", "false");
    expect(screen.queryByTestId("re-name")).not.toBeInTheDocument();

    fireEvent.keyDown(custom, { key: " " });
    expect(custom).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("re-name")).toHaveValue("My custom rule");

    fireEvent.keyDown(custom, { key: "ArrowUp" });
    expect(builtin).toHaveFocus();
    fireEvent.keyDown(builtin, { key: "End" });
    expect(custom).toHaveFocus();
    fireEvent.keyDown(custom, { key: "Home" });
    expect(builtin).toHaveFocus();
    fireEvent.keyDown(builtin, { key: "Enter" });
    expect(builtin).toHaveAttribute("aria-selected", "true");
    expect(custom).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("re-name")).toHaveValue("IOS-XE reload");
  });
});
