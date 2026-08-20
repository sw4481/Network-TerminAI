import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AgentWorkingIndicator,
  shouldRenderAgentMessage,
} from "./AgentWorkingIndicator";

describe("AgentWorkingIndicator", () => {
  it("renders three accessible animated-dot hooks", () => {
    const { container } = render(<AgentWorkingIndicator />);

    expect(screen.getByRole("status", { name: "Agent is working" })).toBeInTheDocument();
    expect(container.querySelectorAll(".streaming-dot")).toHaveLength(3);
  });

  it("suppresses only empty assistant shells", () => {
    expect(shouldRenderAgentMessage("assistant", "  \n")).toBe(false);
    expect(shouldRenderAgentMessage("assistant", "Answer")).toBe(true);
    expect(shouldRenderAgentMessage("user", "")).toBe(true);
  });
});
