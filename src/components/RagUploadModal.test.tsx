/**
 * RAG user-tags follow-up — upload modal user-tag picker tests.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RagUploadModal } from "./RagUploadModal";
import type { RagTaxonomy } from "../lib/rag";

const TAXONOMY: RagTaxonomy = {
  builtin: ["cisco-iosxe-router", "generic"],
  user: [{ tag: "customer-acme", usage_count: 2 }],
};

const FILES = [
  {
    path: "/tmp/foo.pdf",
    title: "foo",
    kind: "pdf" as const,
    bytes: 1024,
  },
];

describe("RagUploadModal user tags", () => {
  it("renders builtin and user chips in separate rows", () => {
    render(
      <RagUploadModal
        files={FILES}
        taxonomy={TAXONOMY}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(
      screen.getByRole("group", { name: /builtin tags/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: /your tags/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("cisco-iosxe-router")).toBeInTheDocument();
    expect(screen.getByText("customer-acme")).toBeInTheDocument();
  });

  it("creates a chip when typing a valid slug and pressing Enter", () => {
    render(
      <RagUploadModal
        files={FILES}
        taxonomy={{ ...TAXONOMY, user: [] }}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );
    const input = screen.getByTestId("rag-modal-new-tag-input");
    fireEvent.change(input, { target: { value: "project1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("project1")).toBeInTheDocument();
  });

  it("shows an error for an invalid shape", () => {
    render(
      <RagUploadModal
        files={FILES}
        taxonomy={{ ...TAXONOMY, user: [] }}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );
    const input = screen.getByTestId("rag-modal-new-tag-input");
    fireEvent.change(input, { target: { value: "Bad Tag!" } });
    expect(
      screen.getByTestId("rag-modal-new-tag-error"),
    ).toBeInTheDocument();
  });

  it("rejects reserved-prefix tags", () => {
    render(
      <RagUploadModal
        files={FILES}
        taxonomy={{ ...TAXONOMY, user: [] }}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );
    const input = screen.getByTestId("rag-modal-new-tag-input");
    fireEvent.change(input, { target: { value: "cisco-foo" } });
    expect(
      screen.getByTestId("rag-modal-new-tag-error"),
    ).toBeInTheDocument();
  });

  it("dedups against an existing user tag (selects rather than duplicates)", () => {
    const onSubmit = vi.fn();
    render(
      <RagUploadModal
        files={FILES}
        taxonomy={TAXONOMY}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );
    const input = screen.getByTestId(
      "rag-modal-new-tag-input",
    ) as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "customer-acme" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Only one chip with that text, and it's now selected.
    const chips = screen.getAllByText("customer-acme");
    expect(chips).toHaveLength(1);
    const chip = chips[0].closest("button");
    expect(chip?.getAttribute("aria-pressed")).toBe("true");
    // Enter while the new-tag input is focused must not also submit.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders an empty-state hint when no user tags exist", () => {
    render(
      <RagUploadModal
        files={FILES}
        taxonomy={{ ...TAXONOMY, user: [] }}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByText(/no custom tags yet/i)).toBeInTheDocument();
  });

  it("submits with both a builtin and a newly created tag", () => {
    const onSubmit = vi.fn();
    render(
      <RagUploadModal
        files={FILES}
        taxonomy={{ ...TAXONOMY, user: [] }}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByText("cisco-iosxe-router"));
    const input = screen.getByTestId("rag-modal-new-tag-input");
    fireEvent.change(input, { target: { value: "project1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Submit via the modal's primary button — labelled "Upload N doc(s)".
    fireEvent.click(
      screen.getByRole("button", { name: /^upload \d+ docs?$/i }),
    );
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [, tags] = onSubmit.mock.calls[0];
    expect(tags).toEqual(
      expect.arrayContaining(["cisco-iosxe-router", "project1"]),
    );
  });
});
