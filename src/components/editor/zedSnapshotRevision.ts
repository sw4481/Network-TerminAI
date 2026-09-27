export type ZedSnapshotRevision = {
  counter: number;
  sourceId: string;
};

export const INITIAL_ZED_SNAPSHOT_REVISION: ZedSnapshotRevision = {
  counter: 0,
  sourceId: "",
};

export function compareZedSnapshotRevision(
  candidate: ZedSnapshotRevision,
  current: ZedSnapshotRevision,
): number {
  if (candidate.counter !== current.counter) {
    return candidate.counter < current.counter ? -1 : 1;
  }
  if (candidate.sourceId === current.sourceId) return 0;
  return candidate.sourceId < current.sourceId ? -1 : 1;
}

export function isNewerZedSnapshotRevision(
  candidate: ZedSnapshotRevision,
  current: ZedSnapshotRevision,
): boolean {
  return compareZedSnapshotRevision(candidate, current) > 0;
}

export function nextZedSnapshotRevision(
  current: ZedSnapshotRevision,
  sourceId: string,
): ZedSnapshotRevision {
  return {
    counter: current.counter + 1,
    sourceId,
  };
}
