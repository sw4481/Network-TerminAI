import "./BlockTabStrip.css";

export type BlockViewMode = "raw" | "structured" | "diff";

interface Props {
  viewMode: BlockViewMode;
  onChange: (mode: BlockViewMode) => void;
  /** Disable the Diff tab when no snapshots exist for this command. */
  diffEnabled?: boolean;
}

export function BlockTabStrip({ viewMode, onChange, diffEnabled = true }: Props) {
  const tabs: { id: BlockViewMode; label: string; disabled?: boolean }[] = [
    { id: "raw", label: "Raw" },
    { id: "structured", label: "Structured" },
    { id: "diff", label: "Diff", disabled: !diffEnabled },
  ];

  return (
    <div
      className="block-tab-strip"
      role="tablist"
      aria-label="Block view mode"
      data-testid="block-tab-strip"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={viewMode === t.id}
          aria-disabled={t.disabled}
          disabled={t.disabled}
          className={`block-tab ${viewMode === t.id ? "active" : ""}`}
          onClick={() => !t.disabled && onChange(t.id)}
          data-testid={`block-tab-${t.id}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
