import { useMemo } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useState } from "react";

/**
 * Auto-detecting table view for JSON array responses.
 *
 * - Columns = union of top-level keys across all rows (stable order: the
 *   order the key first appears in the data)
 * - Missing cells render as "—"
 * - Non-primitive cells render as compact JSON
 * - Click a column header to sort
 *
 * Deliberately NOT virtualized in Step 6 — good enough for the 10k-row
 * Meraki inventory case. Virtualization arrives if we ever hit a real
 * perf wall.
 */
export type TableRow = Record<string, unknown>;

type Props = {
  rows: unknown[];
  /** Called when the user right-clicks a cell. Receives the raw value. */
  onCellContext?: (value: unknown, column: string, row: TableRow) => void;
};

function stringifyCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Collect the union of top-level keys in order of first appearance. */
function collectColumns(rows: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (r && typeof r === "object" && !Array.isArray(r)) {
      for (const k of Object.keys(r as object)) {
        if (!seen.has(k)) {
          seen.add(k);
          out.push(k);
        }
      }
    }
  }
  return out;
}

export function ArrayTableView({ rows, onCellContext }: Props) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const typedRows: TableRow[] = useMemo(
    () =>
      rows
        .filter((r): r is TableRow =>
          r !== null && typeof r === "object" && !Array.isArray(r),
        )
        .map((r) => r as TableRow),
    [rows],
  );

  const columns: ColumnDef<TableRow>[] = useMemo(() => {
    const names = collectColumns(rows);
    return names.map((name) => ({
      id: name,
      accessorFn: (r) => r[name],
      header: name,
      enableSorting: true,
      sortingFn: "alphanumeric",
      cell: (info) => {
        const v = info.getValue();
        return (
          <span
            style={{ cursor: onCellContext ? "context-menu" : undefined }}
            onContextMenu={
              onCellContext
                ? (e) => {
                    e.preventDefault();
                    onCellContext(v, name, info.row.original);
                  }
                : undefined
            }
            data-testid={`api-table-cell-${name}`}
          >
            {stringifyCell(v)}
          </span>
        );
      },
    }));
  }, [rows, onCellContext]);

  const table = useReactTable({
    data: typedRows,
    columns,
    state: { sorting },
    enableSorting: true,
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (rows.length === 0) {
    return (
      <div
        data-testid="api-table-empty"
        style={{
          padding: 12,
          color: "var(--text-muted)",
          fontFamily: "Menlo, monospace",
          fontSize: 12,
        }}
      >
        (empty array)
      </div>
    );
  }

  if (typedRows.length === 0) {
    return (
      <div
        data-testid="api-table-not-objects"
        style={{
          padding: 12,
          color: "var(--text-muted)",
          fontFamily: "Menlo, monospace",
          fontSize: 12,
        }}
      >
        Array does not contain objects; use Body view.
      </div>
    );
  }

  return (
    <div
      data-testid="api-table"
      style={{
        flex: 1,
        overflow: "auto",
        background: "var(--app-canvas)",
        borderRadius: 4,
      }}
    >
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontFamily: "Menlo, monospace",
          fontSize: 12,
        }}
      >
        <thead style={{ position: "sticky", top: 0, background: "var(--surface-2)" }}>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const sort = h.column.getIsSorted();
                return (
                  <th
                    key={h.id}
                    data-testid={`api-table-header-${h.id}`}
                    onClick={() => h.column.toggleSorting()}
                    style={{
                      textAlign: "left",
                      padding: "6px 10px",
                      color: "var(--text-secondary)",
                      fontWeight: 600,
                      cursor: "pointer",
                      borderBottom: "1px solid var(--border-default)",
                      userSelect: "none",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {sort === "asc" ? " ↑" : sort === "desc" ? " ↓" : ""}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row, i) => (
            <tr
              key={row.id}
              data-testid={`api-table-row-${i}`}
              style={{
                background: i % 2 === 0 ? "var(--app-canvas)" : "var(--surface-2)",
                color: "var(--text-primary)",
              }}
            >
              {row.getVisibleCells().map((cell) => (
                <td
                  key={cell.id}
                  style={{
                    padding: "4px 10px",
                    verticalAlign: "top",
                    maxWidth: 320,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
