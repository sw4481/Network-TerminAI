import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  EditorBreadcrumbs,
  breadcrumbSegments,
} from "./EditorBreadcrumbs";

describe("EditorBreadcrumbs", () => {
  it("uses a project-root-relative path when possible", () => {
    expect(
      breadcrumbSegments(
        "/work/project/src/components/App.tsx",
        "/work/project",
      ),
    ).toEqual(["src", "components", "App.tsx"]);
  });

  it("falls back to absolute path segments outside the root", () => {
    expect(
      breadcrumbSegments("/tmp/example.py", "/work/project"),
    ).toEqual(["tmp", "example.py"]);
  });

  it("does not treat a shared path prefix as a project-root match", () => {
    expect(
      breadcrumbSegments(
        "/work/project-two/src/main.tsx",
        "/work/project",
      ),
    ).toEqual(["work", "project-two", "src", "main.tsx"]);
  });

  it("renders ordered segments with the file marked current", () => {
    render(
      <EditorBreadcrumbs
        filePath="/work/project/src/main.tsx"
        rootPath="/work/project"
      />,
    );
    expect(screen.getByLabelText("Editor breadcrumb"))
      .toHaveTextContent("src›main.tsx");
    expect(screen.getByText("main.tsx")).toHaveAttribute("aria-current", "page");
  });
});
