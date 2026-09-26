import { describe, expect, it } from "vitest";
import {
  fileUriToPath,
  pathIsWithinWorkspace,
} from "./locationRouting";

describe("LSP location routing", () => {
  it("converts encoded POSIX and Windows file URIs", () => {
    expect(fileUriToPath("file:///opt/example/test/My%20Project/main.py")).toBe(
      "/opt/example/test/My Project/main.py",
    );
    expect(fileUriToPath("file:///C:/Projects/demo/main.py")).toBe(
      "C:/Projects/demo/main.py",
    );
    expect(fileUriToPath("https://example.com/main.py")).toBeNull();
  });

  it("allows only exact workspace paths or descendants", () => {
    expect(pathIsWithinWorkspace("/repo/main.py", "/repo")).toBe(true);
    expect(pathIsWithinWorkspace("/repo", "/repo/")).toBe(true);
    expect(pathIsWithinWorkspace("/repo-other/main.py", "/repo")).toBe(false);
    expect(pathIsWithinWorkspace("C:\\Repo\\main.py", "c:/repo")).toBe(true);
  });
});
