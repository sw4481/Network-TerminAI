import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildPlaybookCommand,
  runInTerminal,
  runPlaybook,
  isAnsiblePlaybook,
} from "./runPlaybook";

describe("buildPlaybookCommand", () => {
  it("builds a dry-run with inventory", () => {
    expect(
      buildPlaybookCommand({ playbook: "playbook.yml", inventory: "inventory.ini", check: true }),
    ).toBe("ansible-playbook -i inventory.ini playbook.yml --check");
  });

  it("builds a real run with inventory", () => {
    expect(
      buildPlaybookCommand({ playbook: "playbook.yml", inventory: "inventory.ini", check: false }),
    ).toBe("ansible-playbook -i inventory.ini playbook.yml");
  });

  it("omits -i when no inventory", () => {
    expect(buildPlaybookCommand({ playbook: "site.yml", inventory: null, check: false })).toBe(
      "ansible-playbook site.yml",
    );
  });

  it("shell-quotes paths with spaces", () => {
    expect(
      buildPlaybookCommand({ playbook: "my playbook.yml", inventory: null, check: true }),
    ).toBe("ansible-playbook 'my playbook.yml' --check");
  });
});

describe("isAnsiblePlaybook", () => {
  it("accepts .yml / .yaml files", () => {
    expect(isAnsiblePlaybook("/ws/playbook.yml")).toBe(true);
    expect(isAnsiblePlaybook("/ws/site.yaml")).toBe(true);
  });
  it("rejects non-yaml", () => {
    expect(isAnsiblePlaybook("/ws/main.tf")).toBe(false);
    expect(isAnsiblePlaybook(null)).toBe(false);
    expect(isAnsiblePlaybook(undefined)).toBe(false);
  });
  it("rejects CI pipeline yaml (not a playbook)", () => {
    expect(isAnsiblePlaybook("/ws/.gitlab-ci.yml")).toBe(false);
    expect(isAnsiblePlaybook("/ws/.github/workflows/terraform.yml")).toBe(false);
  });
});

describe("runInTerminal / runPlaybook event dispatch", () => {
  let events: CustomEvent[];
  const handler = (e: Event) => events.push(e as CustomEvent);

  beforeEach(() => {
    events = [];
    window.addEventListener("ccie:run-in-terminal", handler);
  });
  afterEach(() => {
    window.removeEventListener("ccie:run-in-terminal", handler);
    vi.restoreAllMocks();
  });

  it("runInTerminal dispatches the command + cwd", () => {
    runInTerminal("echo hi", "/ws");
    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({ command: "echo hi", cwd: "/ws" });
  });

  it("runPlaybook dispatches the built command", () => {
    runPlaybook({ playbook: "playbook.yml", inventory: "inventory.ini", check: true }, "/ws");
    expect(events).toHaveLength(1);
    expect(events[0].detail.command).toBe(
      "ansible-playbook -i inventory.ini playbook.yml --check",
    );
    expect(events[0].detail.cwd).toBe("/ws");
  });
});
