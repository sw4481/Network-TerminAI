import { describe, expect, it } from "vitest";
import { getSettingsTabGroups } from "./settingsTabs";

describe("settings tab groups", () => {
  it("keeps General first and sorts everything else alphabetically", () => {
    const groups = getSettingsTabGroups();

    expect(groups[0].category).toBe("General");
    expect(groups[0].tabs.map((tab) => tab.label)).toEqual(["General"]);
    expect(groups.slice(1).map((group) => group.category)).toEqual(
      groups.slice(1).map((group) => group.category).sort((a, b) => a.localeCompare(b)),
    );

    for (const group of groups) {
      expect(group.tabs.map((tab) => tab.label)).toEqual(
        group.tabs.map((tab) => tab.label).sort((a, b) => a.localeCompare(b)),
      );
    }
  });
});
