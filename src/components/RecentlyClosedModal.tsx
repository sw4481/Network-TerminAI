import { useClosedTabs, type ClosedTab } from "../state/closedTabsStore";

type Props = {
  open: boolean;
  onClose: () => void;
  onPick: (tab: ClosedTab) => void;
};

export function RecentlyClosedModal({ open, onClose, onPick }: Props) {
  const items = useClosedTabs((s) => s.items);
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card recently-closed" onClick={(e) => e.stopPropagation()}>
        <h3>Recently Closed</h3>
        {items.length === 0 ? (
          <p className="empty">No recently closed tabs</p>
        ) : (
          <ul className="closed-list">
            {items.map((t) => (
              <li key={t.id}>
                <button
                  className="closed-row"
                  onClick={() => { onPick(t); onClose(); }}
                >
                  <span className="title">{t.title}</span>
                  <span className="cwd">{t.cwd}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
