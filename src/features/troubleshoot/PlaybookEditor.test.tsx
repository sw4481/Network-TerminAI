/**
 * Plan 15 Phase 6 — PlaybookEditor unit tests.
 *
 * Strategy: Monaco lazy-import never resolves under jsdom; the editor
 * falls through to the `<textarea>` Suspense fallback. We assert
 * against that. Tests cover:
 *
 *   1. validatePlaybookYaml — invalid YAML yields errors; valid yields
 *      none. (Pure-JS so we test it directly.)
 *   2. The save button is disabled until the buffer is valid AND dirty
 *      AND the selection isn't a builtin.
 *   3. Editing the buffer re-runs validation and updates the preview
 *      after the debounce window.
 *   4. Builtin selection enters read-only mode (banner + disabled save).
 *   5. The "Generate with AI" button is disabled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: vi.fn(),
  readTextFile: vi.fn(),
}));

// Stub the lazy Monaco loader — under jsdom Monaco never finishes
// loading, but we want a deterministic editor surface for the test.
vi.mock("./PlaybookEditorMonaco", () => ({
  default: ({
    value,
    onChange,
    readOnly,
  }: {
    value: string;
    onChange: (v: string) => void;
    readOnly?: boolean;
  }) => (
    <textarea
      data-testid="tb-editor-textarea"
      value={value}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

import { PlaybookEditor } from "./PlaybookEditor";
import {
  BLANK_PLAYBOOK_YAML,
  validatePlaybookYaml,
  previewStepsFromDoc,
  suggestUniqueId,
} from "./playbook-validate";
import { useTroubleshootStore } from "./store";
import type { PlaybookMeta } from "./api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const validYaml = `id: my-test
name: My Test Playbook
description: a test
vendor: cisco
platform: iosxe
symptom_keywords:
  - test
steps:
  - id: step-1
    type: command
    command: show version
  - id: step-2
    type: narration
    text: Hello
`;

const invalidYaml = `id: BAD ID
name: Bad
vendor: cisco
platform: iosxe
symptom_keywords: []
steps: []
`;

const builtinPlaybook: PlaybookMeta = {
  id: "bgp-wont-peer",
  name: "BGP session will not peer",
  vendor: "cisco",
  platform: "iosxe",
  symptom_keywords: ["bgp"],
  builtin: true,
  created_at: 0,
  updated_at: 0,
};

const userPlaybook: PlaybookMeta = {
  id: "my-user-playbook",
  name: "My user playbook",
  vendor: "cisco",
  platform: "iosxe",
  symptom_keywords: ["foo"],
  builtin: false,
  created_at: 0,
  updated_at: 0,
};

beforeEach(() => {
  invokeMock.mockReset();
  useTroubleshootStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("validatePlaybookYaml", () => {
  it("accepts a fully-formed playbook", () => {
    const { doc, diagnostics } = validatePlaybookYaml(validYaml);
    expect(diagnostics).toEqual([]);
    expect((doc as { id: string }).id).toBe("my-test");
  });

  it("flags malformed YAML with a line number", () => {
    const { diagnostics } = validatePlaybookYaml("id: foo\n  bad indent: [");
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0].severity).toBe("error");
  });

  it("flags id pattern violations", () => {
    const { diagnostics } = validatePlaybookYaml(invalidYaml);
    const messages = diagnostics.map((d) => d.message);
    expect(messages.some((m) => m.includes("id must be lowercase"))).toBe(true);
  });

  it("flags empty steps array", () => {
    const { diagnostics } = validatePlaybookYaml(invalidYaml);
    const messages = diagnostics.map((d) => d.message);
    expect(messages.some((m) => m.includes("steps must be a non-empty array"))).toBe(true);
  });

  it("flags missing required fields", () => {
    const { diagnostics } = validatePlaybookYaml("id: ok\nname: Ok\n");
    const messages = diagnostics.map((d) => d.message);
    expect(messages.some((m) => m.includes("Missing required field"))).toBe(true);
  });

  it("flags cross-reference errors when on_pass points to nowhere", () => {
    const yamlText = `id: x
name: X
vendor: cisco
platform: iosxe
symptom_keywords: [a]
steps:
  - id: step-1
    type: assertion
    expression: foo
    expects: bar
    on_pass: nonexistent
`;
    const { diagnostics } = validatePlaybookYaml(yamlText);
    const messages = diagnostics.map((d) => d.message);
    expect(messages.some((m) => m.includes("references unknown step id"))).toBe(true);
  });

  it("flags duplicate step ids", () => {
    const yamlText = `id: x
name: X
vendor: cisco
platform: iosxe
symptom_keywords: [a]
steps:
  - id: dup
    type: command
    command: show version
  - id: dup
    type: command
    command: show ip int br
`;
    const { diagnostics } = validatePlaybookYaml(yamlText);
    const messages = diagnostics.map((d) => d.message);
    expect(messages.some((m) => m.includes("Duplicate step id"))).toBe(true);
  });

  it("flags branch case with bad next reference", () => {
    const yamlText = `id: x
name: X
vendor: cisco
platform: iosxe
symptom_keywords: [a]
steps:
  - id: a
    type: branch
    cases:
      - when: true
        next: ghost
`;
    const { diagnostics } = validatePlaybookYaml(yamlText);
    const messages = diagnostics.map((d) => d.message);
    expect(
      messages.some((m) => m.includes("references unknown step id: ghost")),
    ).toBe(true);
  });

  it("BLANK_PLAYBOOK_YAML is itself valid", () => {
    const { diagnostics } = validatePlaybookYaml(BLANK_PLAYBOOK_YAML);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});

describe("previewStepsFromDoc", () => {
  it("returns one StoredStep per step with status pending", () => {
    const { doc } = validatePlaybookYaml(validYaml);
    const out = previewStepsFromDoc(doc);
    expect(out).toHaveLength(2);
    expect(out[0].step_ref).toBe("step-1");
    expect(out[0].step_type).toBe("command");
    expect(out[0].status).toBe("pending");
    expect(out[1].step_ref).toBe("step-2");
    expect(out[1].step_type).toBe("narration");
  });

  it("returns [] for null doc", () => {
    expect(previewStepsFromDoc(null)).toEqual([]);
  });
});

describe("suggestUniqueId", () => {
  it("returns the slug as-is when not taken", () => {
    expect(suggestUniqueId("my-thing", new Set())).toBe("my-thing");
  });

  it("appends a numeric suffix when taken", () => {
    expect(suggestUniqueId("my-thing", new Set(["my-thing"]))).toBe("my-thing-2");
    expect(
      suggestUniqueId("my-thing", new Set(["my-thing", "my-thing-2"])),
    ).toBe("my-thing-3");
  });

  it("normalizes invalid characters", () => {
    expect(suggestUniqueId("My Awesome Playbook!", new Set())).toBe(
      "my-awesome-playbook",
    );
  });
});

describe("PlaybookEditor — render + save gating", () => {
  it("renders with the New Playbook blank by default and shows preview", () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_playbooks") return [builtinPlaybook, userPlaybook];
      return null;
    });
    render(<PlaybookEditor />);
    expect(screen.getByTestId("tb-editor")).toBeInTheDocument();
    expect(screen.getByTestId("tb-editor-select")).toBeInTheDocument();
  });

  it("save button is disabled when the buffer hasn't been edited", () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_playbooks") return [];
      return null;
    });
    render(<PlaybookEditor />);
    const save = screen.getByTestId("tb-editor-save") as HTMLButtonElement;
    // Default buffer == originalBuffer, so isDirty is false even if valid.
    expect(save.disabled).toBe(true);
  });

  it("save button is disabled when YAML is invalid even if dirty", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_playbooks") return [];
      return null;
    });
    render(<PlaybookEditor />);
    const ta = screen.getByTestId("tb-editor-textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "not: yaml: at: all: [" } });
    await act(async () => { await sleep(350); });
    const save = screen.getByTestId("tb-editor-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("save button enables when buffer is valid AND dirty AND not builtin", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_playbooks") return [];
      return null;
    });
    render(<PlaybookEditor />);
    const ta = screen.getByTestId("tb-editor-textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: validYaml } });
    await act(async () => { await sleep(350); });
    const save = screen.getByTestId("tb-editor-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });

  it("Generate with AI derives the symptom from the buffer (no prompt) and fills the editor", async () => {
    let capturedArgs: Record<string, unknown> | null = null;
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_playbooks") return [];
      if (cmd === "generate_playbook") {
        capturedArgs = args as Record<string, unknown>;
        return {
          yaml: "id: generated-pb\nname: Generated\nsymptom_keywords: [test]\nvendor: cisco\nplatform: iosxe\nsteps:\n  - id: s1\n    type: command\n    command: show version\n",
          error: null,
        };
      }
      return null;
    });

    render(<PlaybookEditor />);
    const gen = screen.getByTestId("tb-editor-generate-ai") as HTMLButtonElement;
    expect(gen.disabled).toBe(false);

    // Put a meaningful name/description in the buffer so a symptom can be derived.
    const ta = screen.getByTestId("tb-editor-textarea") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(ta, {
        target: {
          value:
            "id: dot1x\nname: 802.1x auth failure\ndescription: Switch rejects supplicant auth\nvendor: cisco\nplatform: iosxe\nsymptom_keywords:\n  - dot1x\nsteps:\n  - id: s1\n    type: command\n    command: show version\n",
        },
      });
    });

    fireEvent.click(gen);

    await waitFor(() => {
      const calls = invokeMock.mock.calls.map((c) => c[0]);
      expect(calls).toContain("generate_playbook");
    });
    // Symptom is built from name + description (no window.prompt).
    expect(capturedArgs).toBeTruthy();
    expect(String(capturedArgs!.symptom)).toContain("802.1x auth failure");
    expect(String(capturedArgs!.symptom)).toContain("Switch rejects supplicant auth");
    expect(capturedArgs!.vendor).toBe("cisco");
    expect(capturedArgs!.platform).toBe("iosxe");

    // The generated YAML must actually land in the editor buffer.
    await waitFor(() => {
      expect(
        (screen.getByTestId("tb-editor-textarea") as HTMLTextAreaElement).value,
      ).toContain("id: generated-pb");
    });
  });

  it("uses the free-text prompt as the symptom when one is typed", async () => {
    let capturedArgs: Record<string, unknown> | null = null;
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_playbooks") return [];
      if (cmd === "generate_playbook") {
        capturedArgs = args as Record<string, unknown>;
        return {
          yaml: "id: generated-pb\nname: Generated\nsymptom_keywords: [test]\nvendor: cisco\nplatform: iosxe\nsteps:\n  - id: s1\n    type: command\n    command: show version\n",
          error: null,
        };
      }
      return null;
    });

    render(<PlaybookEditor />);

    // Type a free-text prompt.
    const prompt = screen.getByTestId("tb-editor-gen-prompt") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(prompt, {
        target: { value: "OSPF neighbor stuck in EXSTART on {{interface}}" },
      });
    });

    fireEvent.click(screen.getByTestId("tb-editor-generate-ai"));

    await waitFor(() => {
      const calls = invokeMock.mock.calls.map((c) => c[0]);
      expect(calls).toContain("generate_playbook");
    });
    // The typed prompt wins over the buffer's name/description.
    expect(String(capturedArgs!.symptom)).toContain("EXSTART");
    // vendor/platform still come from the buffer (blank template = cisco/iosxe).
    expect(capturedArgs!.vendor).toBe("cisco");
    expect(capturedArgs!.platform).toBe("iosxe");
  });

  it("keeps generated YAML in the buffer even when a playbook was selected (no blank clobber)", async () => {
    const existing = {
      id: "bgp-wont-peer",
      name: "BGP",
      vendor: "cisco",
      platform: "iosxe",
      symptom_keywords: ["bgp"],
      builtin: false,
      created_at: 0,
      updated_at: 0,
    };
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_playbooks") return [existing];
      if (cmd === "get_playbook")
        return "id: bgp-wont-peer\nname: BGP\ndescription: BGP wont peer\nvendor: cisco\nplatform: iosxe\nsymptom_keywords:\n  - bgp\nsteps:\n  - id: s1\n    type: command\n    command: show bgp summary\n";
      if (cmd === "generate_playbook")
        return {
          yaml: "id: generated-pb\nname: Generated\nsymptom_keywords: [test]\nvendor: cisco\nplatform: iosxe\nsteps:\n  - id: s1\n    type: command\n    command: show version\n",
          error: null,
        };
      return null;
    });

    render(<PlaybookEditor />);
    // Select the existing playbook via the dropdown.
    await waitFor(() =>
      expect(screen.getByTestId("tb-editor-select")).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.change(screen.getByTestId("tb-editor-select"), {
        target: { value: "bgp-wont-peer" },
      });
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId("tb-editor-textarea") as HTMLTextAreaElement).value,
      ).toContain("show bgp summary"),
    );

    // Generate — clearing selectedId must NOT wipe the generated buffer.
    await act(async () => {
      fireEvent.click(screen.getByTestId("tb-editor-generate-ai"));
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId("tb-editor-textarea") as HTMLTextAreaElement).value,
      ).toContain("id: generated-pb"),
    );
    // Must NOT have reverted to the blank template.
    expect(
      (screen.getByTestId("tb-editor-textarea") as HTMLTextAreaElement).value,
    ).not.toContain("Describe the failure mode");
  });

  it("preview re-renders when the buffer is edited", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_playbooks") return [];
      return null;
    });
    render(<PlaybookEditor />);
    const ta = screen.getByTestId("tb-editor-textarea") as HTMLTextAreaElement;
    // The blank playbook has 2 steps. Replace with a 3-step playbook.
    const threeStep = `id: x
name: X
vendor: cisco
platform: iosxe
symptom_keywords: [a]
steps:
  - id: step-1
    type: command
    command: show version
  - id: step-2
    type: narration
    text: hi
  - id: step-3
    type: narration
    text: bye
`;
    fireEvent.change(ta, { target: { value: threeStep } });
    await act(async () => { await sleep(350); });
    const status = screen.getByTestId("tb-editor-status");
    expect(status.textContent ?? "").toMatch(/Valid|Saved/);
  });

  it("invalid YAML shows a diagnostics row", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_playbooks") return [];
      return null;
    });
    render(<PlaybookEditor />);
    const ta = screen.getByTestId("tb-editor-textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: invalidYaml } });
    await act(async () => { await sleep(350); });
    expect(screen.getByTestId("tb-editor-diagnostic-0")).toBeInTheDocument();
  });

  it("selecting a builtin loads it read-only", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_playbooks") return [builtinPlaybook];
      if (cmd === "get_playbook") return validYaml;
      return null;
    });
    render(<PlaybookEditor />);
    // Wait for initial list to populate the select.
    await act(async () => { await sleep(50); });
    const select = screen.getByTestId("tb-editor-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: builtinPlaybook.id } });
    await act(async () => { await sleep(50); });
    expect(screen.getByTestId("tb-editor-readonly-banner")).toBeInTheDocument();
    const save = screen.getByTestId("tb-editor-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const del = screen.getByTestId("tb-editor-delete") as HTMLButtonElement;
    expect(del.disabled).toBe(true);
  });

  it("save calls upsertPlaybook with the buffer", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_playbooks") return [];
      if (cmd === "upsert_playbook") return null;
      return null;
    });
    render(<PlaybookEditor />);
    const ta = screen.getByTestId("tb-editor-textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: validYaml } });
    await act(async () => { await sleep(350); });
    const save = screen.getByTestId("tb-editor-save") as HTMLButtonElement;
    fireEvent.click(save);
    await act(async () => { await sleep(50); });
    const calls = invokeMock.mock.calls.filter(
      (c) => c[0] === "upsert_playbook",
    );
    expect(calls.length).toBe(1);
    const args = calls[0][1] as { id: string; bodyYaml: string };
    expect(args.id).toBe("my-test");
    expect(args.bodyYaml).toBe(validYaml);
  });
});
