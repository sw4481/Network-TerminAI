import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { PromptLibraryManager } from "./PromptLibraryManager";
import type { PromptLibrary } from "../lib/tauri";

const library = (prompts: PromptLibrary["prompts"] = []): PromptLibrary => ({
  schemaVersion: 1,
  revision: 0,
  prompts,
});

const samplePrompt = {
  id: "p1",
  title: "Explain interfaces",
  category: "Troubleshooting",
  body: "Explain this output.",
  createdAt: 1,
  updatedAt: 1,
};

describe("PromptLibraryManager", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string, args?: { library?: PromptLibrary }) => {
      if (command === "prompt_library_get") return Promise.resolve(library([samplePrompt]));
      if (command === "prompt_library_set") return Promise.resolve({ ...args?.library, revision: 1 });
      return Promise.resolve(null);
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("renders saved prompts and calls onUse", async () => {
    const onUse = vi.fn();
    const user = userEvent.setup();
    render(<PromptLibraryManager compact onUse={onUse} />);

    await screen.findByText("Explain interfaces");
    await user.click(screen.getByRole("button", { name: "Use prompt Explain interfaces" }));

    expect(onUse).toHaveBeenCalledWith("Explain this output.");
  });

  it("creates a prompt", async () => {
    const user = userEvent.setup();
    render(<PromptLibraryManager />);

    await screen.findByText("Explain interfaces");
    await user.type(screen.getByLabelText("Title"), "New prompt");
    await user.clear(screen.getByLabelText("Category"));
    await user.type(screen.getByLabelText("Category"), "General");
    await user.type(screen.getByLabelText("Prompt"), "Do the thing");
    await user.click(screen.getByRole("button", { name: "Create Prompt" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      "prompt_library_set",
      expect.objectContaining({
        library: expect.objectContaining({
          prompts: expect.arrayContaining([expect.objectContaining({ title: "New prompt", body: "Do the thing" })]),
        }),
      }),
    ));
  });

  it("renders hostile category names without crashing", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "prompt_library_get") return Promise.resolve(library([{ ...samplePrompt, category: "__proto__" }]));
      return Promise.resolve(null);
    });

    render(<PromptLibraryManager />);

    expect(await screen.findByText("__proto__")).toBeInTheDocument();
  });

  it("edits and deletes a prompt", async () => {
    const user = userEvent.setup();
    render(<PromptLibraryManager />);

    await screen.findByText("Explain interfaces");
    await user.click(screen.getByRole("button", { name: "Edit prompt Explain interfaces" }));
    await user.clear(screen.getByLabelText("Title"));
    await user.type(screen.getByLabelText("Title"), "Edited");
    await user.click(screen.getByRole("button", { name: "Save Prompt" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      "prompt_library_set",
      expect.objectContaining({
        library: expect.objectContaining({
          prompts: expect.arrayContaining([expect.objectContaining({ id: "p1", title: "Edited" })]),
        }),
      }),
    ));

    await user.click(screen.getByRole("button", { name: "Delete prompt Explain interfaces" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      "prompt_library_set",
      expect.objectContaining({ library: expect.objectContaining({ prompts: [] }) }),
    ));
  });
});
