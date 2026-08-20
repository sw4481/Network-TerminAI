import { useEffect, useState } from "react";
import {
  apiListPostmanCollections,
  apiListTargets,
  type ApiTargetSummary,
  type PostmanCollectionSummary,
} from "../../lib/tauri";

/** DOM sentinel used when the user wants a blank / raw request. */
export const CUSTOM_TARGET_ID = "__custom__";

export type ApiTargetSelection =
  | { kind: "custom" }
  | { kind: "manifest"; id: string }
  | { kind: "postman"; id: string };

export const CUSTOM_TARGET_SELECTION: ApiTargetSelection = { kind: "custom" };

type Props = {
  value: ApiTargetSelection;
  onChange: (selection: ApiTargetSelection) => void;
  /** Refresh signal after a Postman collection is imported or deleted. */
  refreshKey?: number;
};

function selectionValue(selection: ApiTargetSelection): string {
  switch (selection.kind) {
    case "custom":
      return CUSTOM_TARGET_ID;
    case "manifest":
      return `manifest:${encodeURIComponent(selection.id)}`;
    case "postman":
      return `postman:${encodeURIComponent(selection.id)}`;
  }
}

function selectionFromValue(value: string): ApiTargetSelection {
  if (value === CUSTOM_TARGET_ID) return CUSTOM_TARGET_SELECTION;
  const separator = value.indexOf(":");
  if (separator < 0) return CUSTOM_TARGET_SELECTION;
  const kind = value.slice(0, separator);
  const id = decodeURIComponent(value.slice(separator + 1));
  if (kind === "manifest") return { kind, id };
  if (kind === "postman") return { kind, id };
  return CUSTOM_TARGET_SELECTION;
}

export function TargetPicker({ value, onChange, refreshKey }: Props) {
  const [targets, setTargets] = useState<ApiTargetSummary[] | null>(null);
  const [collections, setCollections] = useState<PostmanCollectionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.allSettled([apiListTargets(), apiListPostmanCollections()]).then(
      ([targetResult, collectionResult]) => {
        if (cancelled) return;
        const errors: string[] = [];
        if (targetResult.status === "fulfilled") {
          setTargets(targetResult.value);
        } else {
          setTargets([]);
          errors.push(
            targetResult.reason instanceof Error
              ? targetResult.reason.message
              : String(targetResult.reason),
          );
        }
        if (collectionResult.status === "fulfilled") {
          setCollections(collectionResult.value);
        } else {
          setCollections([]);
          errors.push(
            collectionResult.reason instanceof Error
              ? collectionResult.reason.message
              : String(collectionResult.reason),
          );
        }
        setError(errors.length > 0 ? errors.join("; ") : null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8 }}
      data-testid="api-target-picker"
    >
      <label style={{ color: "var(--text-secondary)", fontSize: 12 }}>Target:</label>
      <select
        data-testid="api-target-select"
        value={selectionValue(value)}
        onChange={(event) => onChange(selectionFromValue(event.target.value))}
        disabled={(targets === null || collections === null) && !error}
        style={{
          background: "var(--surface-2)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-default)",
          borderRadius: 4,
          padding: "4px 8px",
          minWidth: 160,
        }}
      >
        <option value={CUSTOM_TARGET_ID}>— Custom (raw) —</option>
        {(targets ?? []).map((target) => (
          <option key={`manifest-${target.id}`} value={selectionValue({ kind: "manifest", id: target.id })}>
            {target.display_name}
            {target.builtin ? " (builtin)" : ""}
          </option>
        ))}
        {(collections ?? []).map((collection) => (
          <option key={`postman-${collection.id}`} value={selectionValue({ kind: "postman", id: collection.id })}>
            {collection.name} (Postman)
          </option>
        ))}
      </select>
      {error && (
        <span
          data-testid="api-target-error"
          style={{ color: "var(--status-danger)", fontSize: 11 }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
