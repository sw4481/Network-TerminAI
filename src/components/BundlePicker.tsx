import { useEffect } from "react";
import { useChangeVerifyStore } from "../state/changeVerifyStore";
import "./BundlePicker.css";

interface BundlePickerProps {
  vendor: string;
  platform: string;
  onSelect: (bundleId: string) => void;
  onEdit: (bundleId: string) => void;
  onDelete: (bundleId: string) => void;
  onCreateNew: () => void;
}

export function BundlePicker({
  vendor,
  platform,
  onSelect,
  onEdit,
  onDelete,
  onCreateNew,
}: BundlePickerProps) {
  const { bundles, loading, loadBundles, selectedBundleId } = useChangeVerifyStore();

  useEffect(() => {
    loadBundles(vendor, platform);
  }, [vendor, platform, loadBundles]);

  if (loading) {
    return <div className="bundle-picker-loading">Loading bundles...</div>;
  }

  return (
    <div className="bundle-picker">
      <div className="bundle-list">
        {bundles.length === 0 ? (
          <div className="bundle-empty">
            No bundles found for {vendor}/{platform}.
          </div>
        ) : (
          bundles.map((bundle) => (
            <div
              key={bundle.id}
              className={`bundle-item ${selectedBundleId === bundle.id ? "selected" : ""}`}
              onClick={() => onSelect(bundle.id)}
            >
              <div className="bundle-item-header">
                <span className="bundle-name">{bundle.name}</span>
                <span className="bundle-command-count">
                  {bundle.commands.length} commands
                </span>
              </div>
              {bundle.description && (
                <div className="bundle-description">{bundle.description}</div>
              )}
              <div className="bundle-actions">
                <button
                  type="button"
                  className="bundle-action-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(bundle.id);
                  }}
                  aria-label="Edit bundle"
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="bundle-action-btn delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete bundle "${bundle.name}"?`)) {
                      onDelete(bundle.id);
                    }
                  }}
                  aria-label="Delete bundle"
                >
                  ✕
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      <button type="button" className="bundle-create-btn" onClick={onCreateNew}>
        + Create New Bundle
      </button>
    </div>
  );
}
