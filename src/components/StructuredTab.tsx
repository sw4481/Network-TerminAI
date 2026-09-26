import { useMemo, useState, useEffect } from "react";
import {
  ColumnDef,
  ColumnFiltersState,
  SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { JSONPath } from "jsonpath-plus";
import { useStructuredOutput } from "../hooks/useStructuredOutput";
import {
  flattenToRows,
  inferColumns,
  isListOfDicts,
} from "../lib/flatten";
import "./StructuredTab.css";

interface Props {
  blockId: string;
  /** Optional pipe-filter applied automatically (Phase 5). */
  initialFilter?: { column: string; value: string } | null;
  /** Phase 3 hook: open the pin-snapshot dialog. */
  onPinSnapshot?: () => void;
  /** Phase 5 export hooks. */
  onExportCsv?: (rows: Record<string, unknown>[], columns: string[]) => void;
  onExportJson?: (rows: Record<string, unknown>[]) => void;
  onCopyMarkdown?: (rows: Record<string, unknown>[], columns: string[]) => void;
}

const renderCell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

export function StructuredTab({
  blockId,
  initialFilter,
  onPinSnapshot,
  onExportCsv,
  onExportJson,
  onCopyMarkdown,
}: Props) {
  const { loading, parsed, error } = useStructuredOutput(blockId);
  const [jsonPath, setJsonPath] = useState("");
  const [jsonPathError, setJsonPathError] = useState<string | null>(null);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(
    initialFilter
      ? [{ id: initialFilter.column, value: initialFilter.value }]
      : [],
  );

  const data = parsed?.data;
  const isList = data !== undefined && isListOfDicts(data);

  const { rows, columns } = useMemo(() => {
    if (data === null || data === undefined) return { rows: [], columns: [] };
    if (isList) {
      const list = data as Record<string, unknown>[];
      return { rows: list, columns: inferColumns(list) };
    }
    let value: unknown = data;
    if (jsonPath.trim().length > 0) {
      try {
        const result = JSONPath({ path: jsonPath, json: data as object });
        value = Array.isArray(result) && result.length === 1 ? result[0] : result;
        setJsonPathError(null);
      } catch (e) {
        setJsonPathError(String(e));
        value = data;
      }
    }
    const flat = flattenToRows(value);
    return {
      rows: flat as unknown as Record<string, unknown>[],
      columns: ["key", "value"],
    };
  }, [data, isList, jsonPath]);

  const tableColumns = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () =>
      columns.map((c) => ({
        id: c,
        accessorFn: (row) => row[c],
        header: c,
        cell: ({ getValue }) => renderCell(getValue()),
        filterFn: (row, id, val) => {
          if (typeof val !== "string" || val.length === 0) return true;
          const cell = row.getValue(id);
          return renderCell(cell).toLowerCase().includes(val.toLowerCase());
        },
      })),
    [columns],
  );

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const visibleRowsAll = table.getRowModel().rows.map((r) => r.original);

  // Plan 05 menu-driven export: listen for focused-block trigger.
  useEffect(() => {
    const handler = (e: Event) => {
      const fmt = (e as CustomEvent<string>).detail;
      if (fmt === "csv") onExportCsv?.(visibleRowsAll, columns);
      else if (fmt === "json") onExportJson?.(visibleRowsAll);
      else if (fmt === "markdown") onCopyMarkdown?.(visibleRowsAll, columns);
    };
    const evt = `structured:export-trigger:${blockId}`;
    window.addEventListener(evt, handler);
    return () => window.removeEventListener(evt, handler);
  }, [blockId, visibleRowsAll, columns, onExportCsv, onExportJson, onCopyMarkdown]);

  if (loading) {
    return (
      <div className="structured-tab" data-testid="structured-tab">
        <div className="structured-empty">Loading parsed output…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="structured-tab" data-testid="structured-tab">
        <div className="structured-empty error">Failed to load: {error}</div>
      </div>
    );
  }
  if (!parsed) {
    return (
      <div className="structured-tab" data-testid="structured-tab">
        <div className="structured-empty">
          <div className="structured-empty-title">No parser available</div>
          <div className="structured-empty-sub">
            Auto-parse did not produce structured data for this command on the
            current vendor/platform.
          </div>
        </div>
      </div>
    );
  }

  const visibleRows = visibleRowsAll;

  return (
    <div className="structured-tab" data-testid="structured-tab">
      <div className="structured-toolbar">
        <span className="structured-meta">
          parser:&nbsp;<strong>{parsed.parser}</strong>
          &nbsp;·&nbsp;{parsed.vendor}/{parsed.platform}
          &nbsp;·&nbsp;{rows.length} row{rows.length === 1 ? "" : "s"}
        </span>
        <div className="structured-toolbar-actions">
          <button
            type="button"
            className="structured-btn"
            onClick={() => onExportCsv?.(visibleRows, columns)}
            data-testid="structured-export-csv"
          >
            Export CSV
          </button>
          <button
            type="button"
            className="structured-btn"
            onClick={() => onExportJson?.(visibleRows)}
            data-testid="structured-export-json"
          >
            Export JSON
          </button>
          <button
            type="button"
            className="structured-btn"
            onClick={() => onCopyMarkdown?.(visibleRows, columns)}
            data-testid="structured-copy-md"
          >
            Copy as Markdown
          </button>
          <button
            type="button"
            className="structured-btn primary"
            onClick={() => onPinSnapshot?.()}
            data-testid="structured-pin-snapshot"
          >
            Pin Snapshot
          </button>
        </div>
      </div>

      {!isList && (
        <div className="structured-jsonpath">
          <label htmlFor={`jp-${blockId}`}>JSONPath</label>
          <input
            id={`jp-${blockId}`}
            type="text"
            value={jsonPath}
            onChange={(e) => setJsonPath(e.target.value)}
            placeholder="$.interfaces.Gi1.ip"
            data-testid="structured-jsonpath"
          />
          {jsonPathError && (
            <span className="structured-jsonpath-error">{jsonPathError}</span>
          )}
        </div>
      )}

      <div className="structured-table-wrap">
        <table className="structured-table" data-testid="structured-table">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const sorted = h.column.getIsSorted();
                  return (
                    <th
                      key={h.id}
                      onClick={h.column.getToggleSortingHandler()}
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : "none"
                      }
                    >
                      <span className="structured-th-label">
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        {sorted === "asc" && " ▲"}
                        {sorted === "desc" && " ▼"}
                      </span>
                    </th>
                  );
                })}
              </tr>
            ))}
            <tr className="structured-filter-row">
              {table.getHeaderGroups()[0].headers.map((h) => (
                <th key={h.id}>
                  <input
                    type="text"
                    aria-label={`Filter ${String(h.column.id)}`}
                    value={(h.column.getFilterValue() as string) ?? ""}
                    onChange={(e) => h.column.setFilterValue(e.target.value)}
                    placeholder="filter…"
                    data-testid={`structured-filter-${h.column.id}`}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td className="structured-empty-row" colSpan={columns.length}>
                  No rows match the active filters.
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>{renderCell(cell.getValue())}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
