import { memo, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { BlockHeader } from './BlockHeader';
import { BlockOutput } from './BlockOutput';
import { BlockActions } from './BlockActions';
import { BlockToolbar } from './BlockToolbar';
import { BlockSearch } from './BlockSearch';
import { BlockExplain } from './BlockExplain';
import { BlockNotebook } from './BlockNotebook';
import { BlockTabStrip, type BlockViewMode } from './BlockTabStrip';
import { StructuredTab } from './StructuredTab';
import { StructuredDiff } from './StructuredDiff';
import { SnapshotPinDialog } from './SnapshotPinDialog';
import { ErrorAnalysis } from './ErrorAnalysis';
import { InlineTopologyPanel } from './topology/InlineTopologyPanel';
import type { NeighborNodeT } from './topology/NeighborNode';
import { SaveNeighborModal } from './topology/SaveNeighborModal';
import { IaCCommandBlock } from './IaCCommandBlock';
import { useBlockHover } from '../hooks/useBlockHover';
import { useOutputSearch } from '../hooks/useOutputSearch';
import { useBlocksStore, type Block } from '../state/blocksStore';
import { useStructuredView } from '../state/structuredViewStore';
import { useTopologyStore } from '../state/topologyStore';
import { useTabs } from '../state/tabsStore';
import {
  TOPOLOGY_TRIGGER_CMD_RE,
  GLOBAL_GRAPH_ID,
  openNeighbor,
} from '../lib/topology';
import type {
  TopologyNode,
  TopologyEdge,
  OpenNeighborHandlers,
} from '../lib/topology';
import { ptyWrite } from '../lib/tauri';
import { exportBlocksToNotebook, importNotebookToBlocks, downloadNotebook } from '../lib/notebook';
import { toCsv, toJson, toMarkdownTable, downloadFile, copyToClipboard } from '../lib/export';
import './CommandBlock.css';

// Stable empty array references for non-topology blocks. Zustand only
// triggers a re-render when the selected slice's identity changes, so
// returning the SAME reference across calls means non-topology blocks
// don't re-render on every topologyStore ingest.
const EMPTY_NODES: TopologyNode[] = [];
const EMPTY_EDGES: TopologyEdge[] = [];

interface CommandBlockProps {
  block: Block;
  active: boolean;
  children?: React.ReactNode; // Active xterm terminal
}

export const CommandBlock = memo(function CommandBlock({
  block,
  active,
  children,
}: CommandBlockProps) {
  // Plan 16 Phase 1: If this block has IaC metadata, use enriched component.
  // (Render enriched regardless of focus — gating on `!active` made the block
  // flip back to the plain renderer the moment it was clicked/focused.)
  if (block.iacExecutionId) {
    return <IaCCommandBlock block={block} iacExecutionId={block.iacExecutionId} />;
  }

  const toggleCollapse = useBlocksStore((s) => s.toggleCollapse);
  const toggleBookmark = useBlocksStore((s) => s.toggleBookmark);
  const rerunBlock = useBlocksStore((s) => s.rerunBlock);
  const explainBlock = useBlocksStore((s) => s.explainBlock);
  const analyzeError = useBlocksStore((s) => s.analyzeError);
  const loadBlocks = useBlocksStore((s) => s.loadBlocks);
  const blocksByTab = useBlocksStore((s) => s.blocksByTab);
  const { isHovered, handleMouseEnter, handleMouseLeave } = useBlockHover();

  const [searchOpen, setSearchOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [notebookOpen, setNotebookOpen] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [analyzingError, setAnalyzingError] = useState(false);
  const globalViewMode = useStructuredView((s) => s.viewModeByBlock[block.id]);
  const setGlobalViewMode = useStructuredView((s) => s.setViewMode);
  const setFocusedBlock = useStructuredView((s) => s.setFocused);
  const viewMode: BlockViewMode = globalViewMode ?? 'raw';
  const setViewMode = useCallback(
    (mode: BlockViewMode) => setGlobalViewMode(block.id, mode),
    [block.id, setGlobalViewMode],
  );
  const [pinDialogOpen, setPinDialogOpen] = useState(false);
  const [unknownNeighbor, setUnknownNeighbor] = useState<TopologyNode | null>(null);
  const errorAnalysisTriggered = useRef(false);

  const isShowCommand = useMemo(
    () => block.command.trim().toLowerCase().startsWith('show '),
    [block.command],
  );
  // Only render the tab strip on completed `show *` blocks. "Live" means an
  // xterm is streaming into this block (children present) — NOT merely focused.
  // Gating on `!active` used to make the strip (and the block's output) vanish
  // the instant you clicked the block to focus it.
  const isLive = children != null;
  const showStructuredTabs = isShowCommand && !isLive;

  // Plan 13 Phase 2.4 — inline neighbor topology panel for completed
  // `show cdp|lldp neighbor*` blocks. Hydration is driven by
  // `topologyStore` (ingest hook lives in `blocksStore.completeBlock`,
  // Phase 1.4); this component just reads the latest snapshot and
  // slices it by the source device ref.
  const isCompleted = block.exitCode !== undefined;
  const isTopologyBlock = useMemo(
    () => TOPOLOGY_TRIGGER_CMD_RE.test(block.command),
    [block.command],
  );
  const showTopologyPanel = isCompleted && isTopologyBlock;
  const topologyNodes = useTopologyStore((s) => (showTopologyPanel ? s.nodes : EMPTY_NODES));
  const topologyEdges = useTopologyStore((s) => (showTopologyPanel ? s.edges : EMPTY_EDGES));
  const currentTab = useTabs((s) => s.tabs.find((t) => t.id === block.tabId));
  const sourceDeviceRef = useMemo(
    () => currentTab?.title || currentTab?.id || block.tabId,
    [currentTab, block.tabId],
  );
  const handleNeighborClick = useCallback(async (node: NeighborNodeT) => {
    // Bridge ReactFlow's NeighborNodeT.data shape back to the canonical
    // TopologyNode shape that openNeighbor expects. InlineTopologyPanel
    // currently uses the raw device_ref as the node id, but tests have
    // historically used a "device:<ref>" prefix; tolerate both.
    const deviceRef = node.id.startsWith('device:')
      ? node.id.slice('device:'.length)
      : node.id;
    const topologyNode: TopologyNode = {
      graph_id: GLOBAL_GRAPH_ID,
      device_ref: deviceRef,
      device_kind: 'discovered',
      label: node.data.label,
      vendor: node.data.vendor === 'unknown' ? undefined : node.data.vendor,
      platform: undefined,
      mgmt_ip: node.data.mgmtIp,
    };
    const handlers: OpenNeighborHandlers = {
      onOpenSshTab: async (ref) => {
        // Phase 4 will replace this stub with a real tab-spawn helper
        // once the global Topology tab + tab-spawn primitive land.
        console.info('[topology] openSshTab requested for', ref);
      },
      onOpenNetconfTab: async (ref) => {
        console.info('[topology] openNetconfTab requested for', ref);
      },
      onUnknownNeighbor: (n) => setUnknownNeighbor(n),
    };
    try {
      await openNeighbor(topologyNode, handlers);
    } catch (err) {
      console.error('[topology] openNeighbor failed:', err);
    }
  }, []);

  const handleSavedNeighbor = useCallback(
    (kind: 'ssh' | 'netconf', host: string) => {
      // Phase 4 may re-trigger openNeighbor here so the just-saved
      // connection opens immediately.
      console.info(`[topology] neighbor saved as ${kind}:`, host);
      setUnknownNeighbor(null);
    },
    [],
  );

  const handleExportCsv = useCallback(
    async (rows: Record<string, unknown>[], columns: string[]) => {
      const csv = toCsv(rows, columns);
      const safe = block.command.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
      try {
        await downloadFile(`${safe || 'structured'}.csv`, csv, 'text/csv;charset=utf-8');
      } catch (err) {
        console.error('CSV export failed:', err);
      }
    },
    [block.command],
  );
  const handleExportJson = useCallback(
    async (rows: Record<string, unknown>[]) => {
      const json = toJson(rows);
      const safe = block.command.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
      try {
        await downloadFile(`${safe || 'structured'}.json`, json, 'application/json');
      } catch (err) {
        console.error('JSON export failed:', err);
      }
    },
    [block.command],
  );
  const handleCopyMarkdown = useCallback(
    async (rows: Record<string, unknown>[], columns: string[]) => {
      const md = toMarkdownTable(rows, columns);
      try {
        await copyToClipboard(md);
      } catch (err) {
        console.error('clipboard write failed:', err);
      }
    },
    [],
  );
  const {
    searchQuery,
    setSearchQuery,
    matches,
    currentMatchIndex,
    nextMatch,
    prevMatch,
    clearSearch,
  } = useOutputSearch(block.output);

  const handleCopy = () => {
    navigator.clipboard.writeText(block.output).catch((err) => {
      console.error('Failed to copy:', err);
    });
  };

  const handleExplain = useCallback(async () => {
    if (block.aiExplanation) {
      // Already have explanation, just show it
      setExplainOpen(true);
      return;
    }

    // Don't start new request if already explaining
    if (explaining) {
      return;
    }

    // Generate explanation
    setExplaining(true);
    setExplainOpen(true);

    try {
      await explainBlock(block.id);
    } catch (error) {
      console.error('Failed to explain command:', error);
    } finally {
      // Ensure state is reset even on error
      setExplaining(false);
    }
  }, [block.aiExplanation, block.id, explainBlock, explaining]);

  const handleCloseExplain = () => {
    setExplainOpen(false);
  };

  const handleSearch = () => {
    setSearchOpen(true);
  };

  const handleSearchClose = () => {
    setSearchOpen(false);
    clearSearch();
  };

  const handleExport = () => {
    setNotebookOpen(true);
  };

  const handleSaveNotebook = async (name: string, description?: string) => {
    const blocks = blocksByTab.get(block.tabId) || [];
    const notebook = exportBlocksToNotebook(blocks, name, description);

    try {
      // Save to database
      const notebookId = await invoke<string>('notebooks_save', {
        name,
        description: description || null,
        blocksJson: JSON.stringify(notebook),
      });
      console.log('Notebook saved to database with ID:', notebookId);

      // Also download as file
      downloadNotebook(notebook);

      setNotebookOpen(false);
    } catch (error) {
      console.error('Failed to save notebook:', error);
      alert('Failed to save notebook to database');
    }
  };

  const handleLoadNotebook = (notebook: any) => {
    const blocks = importNotebookToBlocks(notebook, block.tabId);
    loadBlocks(block.tabId, blocks);
    setNotebookOpen(false);
  };

  const handleExecuteSuggestion = async (suggestion: string) => {
    // Execute the suggested command
    const command = suggestion + '\n';
    const cmdBytes = new TextEncoder().encode(command);

    try {
      await ptyWrite(block.tabId, cmdBytes);
    } catch (error) {
      console.error('Failed to execute suggestion:', error);
    }
  };

  // Auto-trigger error analysis 500ms after command fails (exit code != 0)
  useEffect(() => {
    // Only trigger once per block
    if (errorAnalysisTriggered.current) {
      return;
    }

    // Only analyze failed commands
    if (block.exitCode === undefined || block.exitCode === 0) {
      return;
    }

    // Skip if already have analysis or currently analyzing
    if (block.errorAnalysis !== undefined || analyzingError) {
      return;
    }

    // Trigger analysis after 500ms delay
    const timeoutId = setTimeout(async () => {
      errorAnalysisTriggered.current = true;
      setAnalyzingError(true);

      try {
        await analyzeError(block.id);
      } catch (error) {
        console.error('Failed to analyze error:', error);
      } finally {
        setAnalyzingError(false);
      }
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [block.exitCode, block.errorAnalysis, block.id, analyzeError, analyzingError]);

  return (
    <div
      className={`command-block ${active ? 'active' : ''}`}
      data-block-id={block.id}
      onMouseEnter={() => {
        handleMouseEnter();
        if (showStructuredTabs) setFocusedBlock(block.id);
      }}
      onMouseLeave={handleMouseLeave}
    >
      <BlockHeader
        blockId={block.id}
        command={block.command}
        exitCode={block.exitCode}
        duration={block.durationMs}
        timestamp={block.timestamp}
        bookmarked={block.bookmarked}
        pinned={block.pinned}
        tags={block.tags}
        collapsed={block.collapsed}
        onToggleCollapse={() => toggleCollapse(block.id)}
      >
        <BlockActions
          block={block}
          onRerun={() => rerunBlock(block.id)}
          onBookmark={() => toggleBookmark(block.id)}
          onCopy={handleCopy}
          bookmarked={block.bookmarked}
        />
        <BlockToolbar
          onRerun={() => rerunBlock(block.id)}
          onBookmark={() => toggleBookmark(block.id)}
          onCopy={handleCopy}
          onExplain={handleExplain}
          onSearch={handleSearch}
          onExport={handleExport}
          bookmarked={block.bookmarked}
          visible={isHovered && !active}
        />
      </BlockHeader>

      {searchOpen && (
        <BlockSearch
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          matchCount={matches.length}
          currentMatch={currentMatchIndex}
          onNext={nextMatch}
          onPrev={prevMatch}
          onClose={handleSearchClose}
        />
      )}

      {explainOpen && (
        <BlockExplain
          explanation={block.aiExplanation ?? null}
          loading={explaining}
          onClose={handleCloseExplain}
        />
      )}

      {notebookOpen && (
        <BlockNotebook
          onSave={handleSaveNotebook}
          onLoad={handleLoadNotebook}
          onClose={() => setNotebookOpen(false)}
        />
      )}

      {showStructuredTabs && (
        <BlockTabStrip viewMode={viewMode} onChange={setViewMode} />
      )}

      {(!showStructuredTabs || viewMode === 'raw') && (
        showTopologyPanel ? (
          <div className="cb-output-with-topology">
            <BlockOutput
              output={block.output}
              outputLineCount={block.outputLineCount}
              collapsed={block.collapsed}
              active={active}
              searchQuery={searchQuery}
              searchMatches={matches}
              currentMatchIndex={currentMatchIndex}
            >
              {children}
            </BlockOutput>
            <div className="cb-side-panel">
              <InlineTopologyPanel
                storeNodes={topologyNodes}
                storeEdges={topologyEdges}
                sourceDeviceRef={sourceDeviceRef}
                onNeighborClick={handleNeighborClick}
              />
            </div>
          </div>
        ) : (
          <BlockOutput
            output={block.output}
            outputLineCount={block.outputLineCount}
            collapsed={block.collapsed}
            active={active}
            searchQuery={searchQuery}
            searchMatches={matches}
            currentMatchIndex={currentMatchIndex}
          >
            {children}
          </BlockOutput>
        )
      )}

      {showStructuredTabs && viewMode === 'structured' && (
        <StructuredTab
          blockId={block.id}
          initialFilter={
            block.structuredFilter && block.structuredFilter.kind === 'eq'
              ? { column: block.structuredFilter.path, value: block.structuredFilter.value }
              : null
          }
          onPinSnapshot={() => setPinDialogOpen(true)}
          onExportCsv={handleExportCsv}
          onExportJson={handleExportJson}
          onCopyMarkdown={handleCopyMarkdown}
        />
      )}

      {showStructuredTabs && viewMode === 'diff' && (
        <StructuredDiff
          blockId={block.id}
          tabId={block.tabId}
          command={block.command.trim()}
        />
      )}

      {pinDialogOpen && (
        <SnapshotPinDialog
          blockId={block.id}
          defaultName={block.command.trim()}
          onClose={() => setPinDialogOpen(false)}
        />
      )}

      {/* Show error analysis for failed commands */}
      {block.exitCode !== undefined && block.exitCode !== 0 && (
        <ErrorAnalysis
          analysis={block.errorAnalysis ?? null}
          loading={analyzingError}
          onExecuteSuggestion={handleExecuteSuggestion}
        />
      )}

      {block.aiAnalysis && (
        <div className="ai-analysis">
          <div className="ai-analysis-header">🤖 AI Analysis</div>
          <div className="ai-analysis-content">
            {block.aiAnalysis}
          </div>
        </div>
      )}

      <SaveNeighborModal
        isOpen={unknownNeighbor !== null}
        neighbor={unknownNeighbor}
        onClose={() => setUnknownNeighbor(null)}
        onSaved={handleSavedNeighbor}
      />
    </div>
  );
});
