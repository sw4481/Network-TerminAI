import { memo, useEffect, useMemo, useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';
import type { PcapPacket } from '../lib/pcap';

const FILTER_DEBOUNCE_MS = 300;

interface PcapPacketListProps {
  packets: PcapPacket[];
  totalCount: number;
  displayFilter: string;
  invalidFilter?: boolean;
  loading?: boolean;
  onSelectPacket: (no: number) => void;
  selectedPacketNo: number | null;
  onDisplayFilterChange: (filter: string) => void;
  onFollowStream?: (streamIndex: number) => void;
}

const columns: ColumnDef<PcapPacket>[] = [
  { accessorKey: 'no', header: 'No', size: 64 },
  {
    accessorKey: 'time',
    header: 'Time',
    cell: ({ row }) => row.original.time.toFixed(6),
    size: 130,
  },
  { accessorKey: 'src', header: 'Source', size: 160 },
  { accessorKey: 'dst', header: 'Destination', size: 160 },
  { accessorKey: 'protocol', header: 'Proto', size: 80 },
  { accessorKey: 'length', header: 'Length', size: 80 },
];

function PcapPacketListImpl({
  packets,
  totalCount,
  displayFilter,
  invalidFilter,
  loading,
  onSelectPacket,
  selectedPacketNo,
  onDisplayFilterChange,
  onFollowStream,
}: PcapPacketListProps) {
  const [draftFilter, setDraftFilter] = useState(displayFilter);
  useEffect(() => setDraftFilter(displayFilter), [displayFilter]);

  useEffect(() => {
    const id = setTimeout(() => {
      if (draftFilter !== displayFilter) onDisplayFilterChange(draftFilter);
    }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [draftFilter, displayFilter, onDisplayFilterChange]);

  const table = useReactTable({
    data: packets,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  // No virtualization: the summarizer caps results at ~200 packets, which a
  // plain table renders and scrolls without trouble. An earlier virtualized
  // implementation (@tanstack/react-virtual) failed to populate rows inside the
  // panel's grid/absolute layout (it measured the scroll container before it
  // settled and rendered only the initial estimate), so the list wouldn't
  // scroll. Plain rows in an `overflow:auto` wrapper are simpler and correct.
  const rowModel = table.getRowModel();

  const showing = packets.length;
  const summary = useMemo(
    () =>
      `Showing ${showing} of ${totalCount} packet${totalCount === 1 ? '' : 's'}`,
    [showing, totalCount],
  );

  return (
    <div className="pcap-packet-list" data-testid="pcap-packet-list">
      <div className="pcap-filter-bar">
        <input
          className={`pcap-filter-input${invalidFilter ? ' invalid' : ''}`}
          data-testid="pcap-filter-input"
          aria-label="Display filter"
          placeholder="Display filter (e.g. tcp.port == 443)"
          value={draftFilter}
          onChange={(e) => setDraftFilter(e.target.value)}
        />
        <span className="pcap-filter-summary" data-testid="pcap-filter-summary">
          {summary}
        </span>
        {loading && <span className="pcap-filter-loading">…</span>}
      </div>
      <div className="pcap-table-wrap">
        <table className="pcap-table" role="table">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th key={h.id} style={{ width: h.getSize() }}>
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {rowModel.rows.map((row) => {
              const selected = row.original.no === selectedPacketNo;
              return (
                <tr
                  key={row.id}
                  className={selected ? 'selected' : ''}
                  data-testid={`pcap-row-${row.original.no}`}
                  onClick={() => onSelectPacket(row.original.no)}
                  onDoubleClick={() => {
                    if (
                      onFollowStream &&
                      row.original.protocol.toLowerCase().includes('tcp')
                    ) {
                      // Stream index is unknown here without per-packet metadata;
                      // double-click is a hook for the modal until packet
                      // metadata grows a `tcp.stream` field.
                      onFollowStream(0);
                    }
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} style={{ width: cell.column.getSize() }}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const PcapPacketList = memo(PcapPacketListImpl);
