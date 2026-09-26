/**
 * HelpModal — covers the in-app Help surface (User Guide, Quick Start,
 * Shortcuts, About). The four sections are pulled from static markdown so
 * these tests don't need to mock invoke() or the menu bridge.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { HelpModal, type HelpSection } from "./HelpModal";
import { SHORTCUTS_MD } from "./content/shortcuts";
import { USER_GUIDE_MD } from "./content/userGuide";

describe("HelpModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the four sidebar tabs", () => {
    render(<HelpModal section="user-guide" onClose={() => {}} />);
    expect(screen.getByTestId("help-nav-user-guide")).toBeInTheDocument();
    expect(screen.getByTestId("help-nav-quick-start")).toBeInTheDocument();
    expect(screen.getByTestId("help-nav-shortcuts")).toBeInTheDocument();
    expect(screen.getByTestId("help-nav-about")).toBeInTheDocument();
  });

  it("documents editor power-editing discoverability", () => {
    expect(SHORTCUTS_MD).toContain("## Editor Power Editing");
    expect(SHORTCUTS_MD).toContain("Toggle Bookmark");
    expect(SHORTCUTS_MD).toContain("Next Bookmark");

    render(<HelpModal section="shortcuts" onClose={() => {}} />);
    const content = within(screen.getByTestId("help-content-shortcuts"));
    expect(
      content.getByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent?.replace(/\s+/g, " ").trim() ===
            "Inside an editor, use the context menu for multi-cursor, line operations, indentation, case transforms, folding, and bookmarks, including Toggle Bookmark and Next Bookmark. Choose Command Palette from the Monaco editor context menu to search the available editor commands. Enable Column Selection in Editor Settings for rectangular mouse/keyboard selection.",
      ),
    ).toBeInTheDocument();
    expect(
      content.getByText("Command Palette", { selector: "code" }),
    ).toBeInTheDocument();
    expect(
      content.getByText("Column Selection", { selector: "code" }),
    ).toBeInTheDocument();
  });

  it("documents and surfaces Agent panel voice dictation", () => {
    expect(USER_GUIDE_MD).toContain("#### Voice dictation");
    expect(USER_GUIDE_MD).toContain("does not send automatically");

    render(<HelpModal section="user-guide" onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("help-modal-search"), {
      target: { value: "dictation" },
    });

    expect(screen.getByTestId("help-nav-user-guide")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("help-content-user-guide")).getByRole("heading", {
        name: "Voice dictation",
      }),
    ).toBeInTheDocument();
  });

  it("starts on the section indicated by the prop", () => {
    render(<HelpModal section="quick-start" onClose={() => {}} />);
    expect(
      screen.getByTestId("help-nav-quick-start"),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("help-content-quick-start")).toBeInTheDocument();
  });

  it("switches sections when a sidebar item is clicked", () => {
    render(<HelpModal section="user-guide" onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("help-nav-shortcuts"));
    expect(screen.getByTestId("help-content-shortcuts")).toBeInTheDocument();
    expect(
      screen.getByTestId("help-nav-shortcuts"),
    ).toHaveAttribute("aria-current", "page");
  });

  it("closes when Esc is pressed", () => {
    const onClose = vi.fn();
    render(<HelpModal section="about" onClose={onClose} />);
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape" }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the overlay is clicked", () => {
    const onClose = vi.fn();
    render(<HelpModal section="user-guide" onClose={onClose} />);
    fireEvent.click(screen.getByTestId("help-modal-overlay"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when the modal body is clicked", () => {
    const onClose = vi.fn();
    render(<HelpModal section="user-guide" onClose={onClose} />);
    fireEvent.click(screen.getByTestId("help-modal"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("filters sidebar entries via the search box", () => {
    render(<HelpModal section="user-guide" onClose={() => {}} />);
    const search = screen.getByTestId("help-modal-search");
    // "asciinema" only appears in the User Guide and About bodies; querying
    // for "asciinema" should drop the Quick Start and Shortcuts tabs.
    fireEvent.change(search, { target: { value: "asciinema" } });
    expect(screen.getByTestId("help-nav-user-guide")).toBeInTheDocument();
    expect(screen.queryByTestId("help-nav-shortcuts")).not.toBeInTheDocument();
    expect(screen.queryByTestId("help-nav-quick-start")).not.toBeInTheDocument();
  });

  it("shows an empty state when no section matches the query", () => {
    render(<HelpModal section="user-guide" onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("help-modal-search"), {
      target: { value: "thisstringdoesnotexistanywhere" },
    });
    expect(screen.getByText(/No matching sections/i)).toBeInTheDocument();
  });

  it("re-targets the active section when the prop changes", () => {
    const { rerender } = render(
      <HelpModal section="user-guide" onClose={() => {}} />,
    );
    expect(screen.getByTestId("help-content-user-guide")).toBeInTheDocument();
    rerender(<HelpModal section="about" onClose={() => {}} />);
    expect(screen.getByTestId("help-content-about")).toBeInTheDocument();
  });

  it.each<HelpSection>([
    "user-guide",
    "quick-start",
    "shortcuts",
    "about",
  ])("renders %s without throwing", (section) => {
    render(<HelpModal section={section} onClose={() => {}} />);
    expect(screen.getByTestId(`help-content-${section}`)).toBeInTheDocument();
  });
});
