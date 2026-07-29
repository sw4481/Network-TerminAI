import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DriftDetailModal } from "./DriftDetailModal";
import { useIacStateStore } from "../state/iacStateStore";

const writeText = vi.fn();
beforeEach(() => {
  writeText.mockReset();
  Object.assign(navigator, { clipboard: { writeText } });
  useIacStateStore.setState({
    projectPath: "/infra/dev",
    exceptions: [],
    drift: {
      hasDrift: true,
      drifted: [
        { resourceType: "aws_security_group", resourceName: "alb",
          address: "aws_security_group.alb", detectedChanges: "drifted (update)" },
      ],
      analysis: {
        analyses: [
          { resource: "aws_security_group.alb", explanation: "Manual ingress rule.",
            cause: "manual change", recommendation: "import", impact: "exposure" },
        ],
      },
    },
  });
});

describe("DriftDetailModal", () => {
  it("renders per-resource AI analysis", () => {
    render(<DriftDetailModal />);
    expect(screen.getByText(/Manual ingress rule/)).toBeTruthy();
  });

  it("shows an AI-unavailable fallback", () => {
    useIacStateStore.setState({
      drift: {
        hasDrift: true,
        drifted: [
          { resourceType: "aws_instance", resourceName: "web",
            address: "aws_instance.web", detectedChanges: "drifted (update)" },
        ],
        analysis: { analyses: [], unavailable: true },
      },
    });
    render(<DriftDetailModal />);
    expect(screen.getByText(/AI analysis unavailable/i)).toBeTruthy();
  });

  it("copies an import command to the clipboard", () => {
    render(<DriftDetailModal />);
    fireEvent.click(screen.getByText(/Generate Import Command/i));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("terraform import aws_security_group.alb"),
    );
  });
});
