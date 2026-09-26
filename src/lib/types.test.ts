import { describe, it, expect } from "vitest";
import type { Tab, TabType } from "./types";

describe("TabType", () => {
  it("includes iac-studio and models an IaC Studio tab", () => {
    const t: TabType = "iac-studio";
    const tab: Tab = {
      id: "x",
      title: "IaC Studio",
      shell_cmd: "",
      cwd: "/tmp/project",
      created_at: 0,
      tab_type: t,
    };
    expect(tab.tab_type).toBe("iac-studio");
  });
});
