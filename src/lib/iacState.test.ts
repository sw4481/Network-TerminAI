import { describe, it, expect } from "vitest";
import { buildImportCommand } from "./iacState";

describe("buildImportCommand", () => {
  it("formats a terraform import command", () => {
    expect(buildImportCommand("aws_security_group.alb", "sg-abc123")).toBe(
      "terraform import aws_security_group.alb sg-abc123",
    );
  });
});
