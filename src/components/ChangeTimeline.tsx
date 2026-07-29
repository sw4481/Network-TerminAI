import "./ChangeTimeline.css";

type PanelStage = "select" | "pre-running" | "pre-done" | "change-open" | "post-running" | "report";

interface ChangeTimelineProps {
  currentStage: PanelStage;
}

const stages = [
  { key: "select", label: "Select Bundle" },
  { key: "pre-running", label: "Pre-Check" },
  { key: "change-open", label: "Make Change" },
  { key: "post-running", label: "Post-Check" },
  { key: "report", label: "Review" },
] as const;

export function ChangeTimeline({ currentStage }: ChangeTimelineProps) {
  const currentIndex = stages.findIndex(
    (s) => s.key === currentStage || (currentStage === "pre-done" && s.key === "pre-running"),
  );

  return (
    <div className="change-timeline">
      {stages.map((stage, index) => {
        const isActive = index === currentIndex;
        const isDone = index < currentIndex;

        return (
          <div
            key={stage.key}
            className={`timeline-step ${isActive ? "active" : ""} ${isDone ? "done" : ""}`}
          >
            <div className="timeline-marker">
              {isDone ? "✓" : index + 1}
            </div>
            <span className="timeline-label">{stage.label}</span>
          </div>
        );
      })}
    </div>
  );
}
