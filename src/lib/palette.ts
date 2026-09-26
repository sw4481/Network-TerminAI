import { invoke } from "@tauri-apps/api/core";

export type PaletteKind =
  | "command"
  | "workflow"
  | "notebook"
  | "device"
  | "block"
  | "ssh";

export type PaletteScope = "tab" | "device" | "global";

export interface PaletteHit {
  kind: PaletteKind;
  target_id: string;
  title: string;
  subtitle: string | null;
  score: number;
  recency_boost: number;
  frequency_boost: number;
  meta: Record<string, unknown>;
}

export interface PaletteSearchArgs {
  query: string;
  scope: PaletteScope;
  activeTabId?: string | null;
  activeDeviceId?: string | null;
  kindFilter?: PaletteKind | null;
  limit: number;
}

/**
 * Map a `>` keybinding prefix to the matching {@link PaletteKind}, returning
 * the residual search text after the chip is consumed. Mirrors the Rust
 * `PaletteKind::as_target_type` ordering.
 *
 *   ">w bgp"  → { kind: "workflow",  text: "bgp" }
 *   ">"       → { kind: null,        text: ""    }  (waiting for next char)
 *   "show"    → { kind: null,        text: "show" }
 */
export function parseCategoryPrefix(input: string): {
  kindFilter: PaletteKind | null;
  searchText: string;
} {
  if (!input.startsWith(">")) {
    return { kindFilter: null, searchText: input };
  }
  const rest = input.slice(1);
  if (rest.length === 0) {
    return { kindFilter: null, searchText: "" };
  }
  const tag = rest[0]?.toLowerCase();
  const remainder = rest.slice(1).trimStart();
  switch (tag) {
    case "c":
      return { kindFilter: "command", searchText: remainder };
    case "w":
      return { kindFilter: "workflow", searchText: remainder };
    case "n":
      return { kindFilter: "notebook", searchText: remainder };
    case "d":
      return { kindFilter: "device", searchText: remainder };
    case "b":
      return { kindFilter: "block", searchText: remainder };
    case "s":
      return { kindFilter: "ssh", searchText: remainder };
    default:
      // Unknown prefix — fall back to literal text search.
      return { kindFilter: null, searchText: input };
  }
}

export async function paletteSearch(
  args: PaletteSearchArgs,
): Promise<PaletteHit[]> {
  return invoke<PaletteHit[]>("palette_search", {
    payload: {
      args: {
        query: args.query,
        scope: args.scope,
        active_tab_id: args.activeTabId ?? null,
        active_device_id: args.activeDeviceId ?? null,
        kind_filter: args.kindFilter ?? null,
        limit: args.limit,
      },
    },
  });
}

export async function paletteRecordUse(
  targetType: PaletteKind,
  targetId: string,
): Promise<void> {
  await invoke("palette_record_use", {
    targetType,
    targetId,
  });
}

/** Glyph used in the palette row for each kind. */
export function iconForKind(kind: PaletteKind): string {
  switch (kind) {
    case "command":
      return "📋";
    case "workflow":
      return "🧩";
    case "notebook":
      return "📓";
    case "device":
      return "🖧";
    case "block":
      return "🧱";
    case "ssh":
      return "🔌";
  }
}

/** Short, human-readable label rendered in the kind column. */
export function labelForKind(kind: PaletteKind): string {
  switch (kind) {
    case "command":
      return "Command";
    case "workflow":
      return "Workflow";
    case "notebook":
      return "Notebook";
    case "device":
      return "Device";
    case "block":
      return "Block";
    case "ssh":
      return "SSH";
  }
}
