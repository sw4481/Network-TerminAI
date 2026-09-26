export function normalizeBookmarkLines(
  lines: readonly number[],
  lineCount: number,
): number[] {
  return [...new Set(lines.filter((line) =>
    Number.isInteger(line) && line >= 1 && line <= lineCount,
  ))].sort((a, b) => a - b);
}

export function toggleBookmarkLine(
  lines: readonly number[],
  line: number,
  lineCount: number,
): number[] {
  const normalized = normalizeBookmarkLines(lines, lineCount);

  if (!Number.isInteger(line) || line < 1 || line > lineCount) {
    return normalized;
  }

  return normalized.includes(line)
    ? normalized.filter((bookmarkLine) => bookmarkLine !== line)
    : [...normalized, line].sort((a, b) => a - b);
}

export function nextBookmarkLine(
  lines: readonly number[],
  currentLine: number,
): number | null {
  const normalized = [...new Set(lines.filter((line) =>
    Number.isInteger(line) && line >= 1,
  ))].sort((a, b) => a - b);

  return normalized.find((line) => line > currentLine) ?? normalized[0] ?? null;
}

export function previousBookmarkLine(
  lines: readonly number[],
  currentLine: number,
): number | null {
  const normalized = [...new Set(lines.filter((line) =>
    Number.isInteger(line) && line >= 1,
  ))].sort((a, b) => a - b);

  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (normalized[index] < currentLine) {
      return normalized[index];
    }
  }

  return normalized[normalized.length - 1] ?? null;
}
