import { create } from "zustand";
import type { DiagramEvent } from "../lib/tauri";
import { diagramSave, diagramList, diagramDelete } from "../lib/tauri";

/**
 * A draw.io diagram produced by an agent, plus a stable id and capture time
 * so the panel can list and key them.
 */
export interface StoredDiagram {
  id: string;
  title: string;
  format: "xml" | "csv" | "mermaid" | "image" | "markmap";
  xml: string | null;
  source: string | null;
  url: string;
  /** Remote image/viewer URL for "image" (Kroki SVG) and "markmap" formats. */
  imageUrl: string | null;
  receivedAt: number;
}

interface DiagramState {
  diagrams: StoredDiagram[];
  selectedId: string | null;

  /** Append a diagram from an agent `diagram` event, persist it, and select it. */
  addDiagram: (e: DiagramEvent) => StoredDiagram;
  /** Hydrate the list from the DB (persisted diagrams survive reload). */
  loadSaved: () => Promise<void>;
  select: (id: string | null) => void;
  /** Remove one diagram (also deletes its persisted row). */
  remove: (id: string) => void;
  clear: () => void;
}

let _seq = 0;

export const useDiagramStore = create<DiagramState>((set) => ({
  diagrams: [],
  selectedId: null,

  addDiagram: (e) => {
    // Monotonic id without Date.now()/random in the hot path — receivedAt is
    // stamped here (allowed in app code) only for display ordering.
    _seq += 1;
    const stored: StoredDiagram = {
      id: `diagram-${_seq}`,
      title: e.title || "diagram",
      format: e.format,
      xml: e.xml ?? null,
      source: e.source ?? null,
      url: e.url,
      imageUrl: e.image_url ?? null,
      receivedAt: Date.now(),
    };
    // Most-recent-first, and auto-select the new one.
    set((s) => ({
      diagrams: [stored, ...s.diagrams],
      selectedId: stored.id,
    }));
    // Persist so it survives reload. Fire-and-forget: a DB error must never
    // break the live render the user is already seeing.
    void diagramSave({
      id: stored.id,
      title: stored.title,
      format: stored.format,
      xml: stored.xml,
      source: stored.source,
      url: stored.url,
      image_url: stored.imageUrl,
      agent_id: null,
      tab_id: null,
      created_at: Math.floor(stored.receivedAt / 1000),
    }).catch(() => {});
    return stored;
  },

  loadSaved: async () => {
    try {
      const rows = await diagramList();
      const loaded: StoredDiagram[] = rows.map((r) => ({
        id: r.id,
        title: r.title || "diagram",
        format: (r.format as StoredDiagram["format"]) || "xml",
        xml: r.xml,
        source: r.source,
        url: r.url,
        imageUrl: r.image_url,
        receivedAt: (r.created_at || 0) * 1000,
      }));
      // Merge: keep any live diagrams from this session not yet in the DB list,
      // then show DB rows. Dedupe by id, most-recent-first.
      set((s) => {
        const byId = new Map<string, StoredDiagram>();
        for (const d of [...s.diagrams, ...loaded]) {
          if (!byId.has(d.id)) byId.set(d.id, d);
        }
        const merged = Array.from(byId.values()).sort(
          (a, b) => b.receivedAt - a.receivedAt,
        );
        return {
          diagrams: merged,
          selectedId: s.selectedId ?? merged[0]?.id ?? null,
        };
      });
    } catch {
      // No DB / command unavailable — leave the in-memory list as-is.
    }
  },

  select: (id) => set({ selectedId: id }),

  remove: (id) => {
    set((s) => {
      const diagrams = s.diagrams.filter((d) => d.id !== id);
      return {
        diagrams,
        selectedId: s.selectedId === id ? (diagrams[0]?.id ?? null) : s.selectedId,
      };
    });
    void diagramDelete(id).catch(() => {});
  },

  // Clear only the in-session view; persisted diagrams stay in the DB and
  // return on the next loadSaved(). Deleting is per-item via remove().
  clear: () => set({ diagrams: [], selectedId: null }),
}));
