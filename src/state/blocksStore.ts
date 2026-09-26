import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { ptyWrite } from '../lib/tauri';
import { autoParseBlock } from '../lib/structured';
import { useTabs } from './tabsStore';
import { aiAnalyzeError } from '../lib/ai';
import {
  splitStructuredPipe,
  StructuredPipeError,
  type StructuredFilter,
} from '../lib/structuredPipe';
import {
  isTopologyIngestEnabled,
  TOPOLOGY_TRIGGER_CMD_RE,
} from '../lib/topology';
import { useTopologyStore } from './topologyStore';

export interface Block {
  id: string;
  tabId: string;
  command: string;
  cwd: string;
  timestamp: number;
  durationMs?: number;
  exitCode?: number;
  output: string;
  outputLineCount: number;
  collapsed: boolean;
  bookmarked: boolean;
  aiAnalysis?: string;
  aiExplanation?: string | null; // NEW: cached command explanation (null = failed, undefined = not requested, string = success)
  errorAnalysis?: ErrorAnalysisData | null; // NEW: cached error analysis (null = failed, undefined = not requested, object = success)
  tags: string[];
  pinned: boolean;
  pinPosition?: number;
  shareId?: string;
  /** Plan 05 — pipe-filter expression captured from `| ↗structured.<expr>`. */
  structuredFilter?: StructuredFilter | null;
  /** Plan 16 Phase 1 — IaC execution ID for enriched rendering */
  iacExecutionId?: string;
}

export interface ErrorAnalysisData {
  errorType: string;
  explanation: string;
  suggestions: string[];
}

/** Raw row shape returned by the Rust `blocks_list` command (snake_case
 *  columns, except `iacExecutionId` which the backend renames via serde). */
interface RawBlockRow {
  id: string;
  tab_id: string;
  cmd: string;
  cwd: string | null;
  output: string;
  exit_code: number | null;
  started_at: number;
  ended_at: number | null;
  output_line_count: number | null;
  is_bookmarked: number;
  ai_analysis: string | null;
  ai_explanation: string | null;
  error_analysis: string | null;
  duration_ms: number | null;
  collapsed: number;
  iacExecutionId: string | null;
}

interface BlocksState {
  // Map of tabId -> Block[]
  blocksByTab: Map<string, Block[]>;

  // Currently active block (where user is typing)
  activeBlockId: string | null;

  // Tag filter (per-tab not yet — Phase 2 narrows scope; this state is global for now).
  filterTags: string[];

  // Actions
  addBlock: (tabId: string, command: string, cwd: string) => string;
  completeBlock: (blockId: string, exitCode: number, durationMs: number, output: string) => void;
  toggleCollapse: (blockId: string) => Promise<void>;
  toggleBookmark: (blockId: string) => void;
  deleteBlock: (blockId: string) => void;
  rerunBlock: (blockId: string) => void;
  explainBlock: (blockId: string) => Promise<void>;
  analyzeError: (blockId: string) => Promise<void>;

  // Tags / pins / shares
  addTag: (blockId: string, tag: string) => Promise<void>;
  removeTag: (blockId: string, tag: string) => Promise<void>;
  togglePin: (blockId: string) => Promise<void>;
  setPinPosition: (blockId: string, position: number) => Promise<void>;
  createShare: (blockId: string) => Promise<string>;
  importShare: (shareId: string) => Promise<Block>;
  revokeShare: (blockId: string) => Promise<void>;
  setFilterTags: (tags: string[]) => void;

  // Persistence
  loadBlocksForTab: (tabId: string) => Promise<void>;
  loadBlocks: (tabId: string, blocks: Block[]) => void;
  syncBlockToDb: (block: Block) => Promise<void>;
}

export const useBlocksStore = create<BlocksState>((set, get) => ({
  blocksByTab: new Map(),
  activeBlockId: null,
  filterTags: [],

  // TODO: Consider optimizing linear scans in mutation methods with a Map<blockId, {tabId, index}>
  addBlock: (tabId: string, command: string, cwd: string) => {
    const blockId = `block-${crypto.randomUUID()}`;
    const timestamp = Date.now();

    // Plan 05 — strip an inline `| ↗structured.<expr>` pipe filter from the
    // recorded command and stash the parsed filter on the block.
    let recordedCommand = command;
    let structuredFilter: StructuredFilter | null = null;
    try {
      const split = splitStructuredPipe(command);
      recordedCommand = split.command;
      structuredFilter = split.filter;
    } catch (err) {
      if (err instanceof StructuredPipeError) {
        console.warn('structured pipe filter parse error:', err.message);
      } else {
        throw err;
      }
    }

    const newBlock: Block = {
      id: blockId,
      tabId,
      command: recordedCommand,
      cwd,
      timestamp,
      output: '',
      outputLineCount: 0,
      collapsed: false,
      bookmarked: false,
      tags: [],
      pinned: false,
      structuredFilter,
    };

    set((state) => {
      const blocks = state.blocksByTab.get(tabId) || [];
      const newMap = new Map(state.blocksByTab);
      newMap.set(tabId, [...blocks, newBlock]);

      return {
        blocksByTab: newMap,
        activeBlockId: blockId,
      };
    });

    // Async: persist to DB (don't await)
    get().syncBlockToDb(newBlock);

    return blockId;
  },

  completeBlock: (blockId: string, exitCode: number, durationMs: number, output: string) => {
    let updatedBlock: Block | null = null;

    set((state) => {
      const newMap = new Map(state.blocksByTab);

      for (const [tabId, blocks] of newMap.entries()) {
        const index = blocks.findIndex(b => b.id === blockId);
        if (index !== -1) {
          const updatedBlocks = [...blocks];
          const outputLines = output.split('\n').length;

          updatedBlocks[index] = {
            ...updatedBlocks[index],
            exitCode,
            durationMs,
            output,
            outputLineCount: outputLines,
            collapsed: outputLines > 50, // Auto-collapse large outputs
          };

          newMap.set(tabId, updatedBlocks);
          updatedBlock = updatedBlocks[index];

          break;
        }
      }

      return { blocksByTab: newMap, activeBlockId: null };
    });

    // Async: persist to DB (outside set callback)
    if (updatedBlock) {
      get().syncBlockToDb(updatedBlock);

      // Plan 05: auto-parse `show *` commands once the block completes.
      // Vendor/platform live in tabsStore (in-memory, set via setTabVendor).
      const block = updatedBlock as Block;
      const cmd = block.command.trim().toLowerCase();
      if (cmd.startsWith('show ')) {
        const tab = useTabs.getState().tabs.find((t) => t.id === block.tabId);
        const vendor = tab?.vendor ?? '';
        const platform = tab?.platform ?? '';
        if (vendor && platform) {
          autoParseBlock(block.id, vendor, platform).catch((err) => {
            console.warn('auto-parse failed:', err);
          });
        }
      }

      // Plan 13: topology auto-ingest for `show cdp|lldp neighbor*` commands.
      // Re-uses the same vendor/platform lookup as the Plan 05 hook above
      // but is gated by its own regex so non-CDP/LLDP `show *` commands
      // still flow through structured parsing only.
      if (isTopologyIngestEnabled() && TOPOLOGY_TRIGGER_CMD_RE.test(block.command)) {
        const tab = useTabs.getState().tabs.find((t) => t.id === block.tabId);
        const vendor = tab?.vendor ?? '';
        const platform = tab?.platform ?? '';
        if (tab && vendor && platform) {
          // PTY tabs don't carry a hostname/IP today; fall back to the
          // tab title (or id) as the source device_ref. For Phase 1 the
          // source node mostly matters in the Global graph view; Phase 2
          // / Phase 3 will refine the source identity.
          const deviceRef = tab.title || tab.id;
          const deviceKind = 'ssh'; // PTY-backed tabs are ssh by default; netconf tabs use a different completion path.
          useTopologyStore
            .getState()
            .ingestFromBlock(block.id, vendor, platform, deviceRef, deviceKind)
            .catch((err) => console.warn('topology ingest failed:', err));
        }
      }

      // Plan 16 Phase 1: IaC auto-detection for mutating terraform/ansible commands
      // Backend iac_process_block will filter to only mutating operations
      const iacPattern = /^(terraform|tf|ansible-playbook|ansible\s+.+\s+-m\s+)/;
      if (iacPattern.test(block.command.trim())) {
        invoke<string | null>('iac_process_block', { blockId: block.id })
          .then((executionId) => {
            if (executionId) {
              console.log('[IaC] Execution stored:', executionId);
              // Emit event to update block with iacExecutionId
              set((state) => {
                const newMap = new Map(state.blocksByTab);
                for (const [tabId, blocks] of newMap.entries()) {
                  const index = blocks.findIndex((b) => b.id === block.id);
                  if (index !== -1) {
                    const updatedBlocks = [...blocks];
                    updatedBlocks[index] = {
                      ...updatedBlocks[index],
                      iacExecutionId: executionId,
                    };
                    newMap.set(tabId, updatedBlocks);
                    break;
                  }
                }
                return { blocksByTab: newMap };
              });
            }
          })
          .catch((err) => {
            console.warn('[IaC] Failed to process block:', err);
          });
      }
    }
  },

  toggleCollapse: async (blockId: string) => {
    let nextCollapsed: boolean | null = null;

    set((state) => {
      const newMap = new Map(state.blocksByTab);

      for (const [tabId, blocks] of newMap.entries()) {
        const index = blocks.findIndex(b => b.id === blockId);
        if (index !== -1) {
          const updatedBlocks = [...blocks];
          const collapsed = !updatedBlocks[index].collapsed;
          updatedBlocks[index] = {
            ...updatedBlocks[index],
            collapsed,
          };
          newMap.set(tabId, updatedBlocks);
          nextCollapsed = collapsed;
          break;
        }
      }

      return { blocksByTab: newMap };
    });

    if (nextCollapsed !== null) {
      try {
        await invoke('block_set_collapsed', { blockId, collapsed: nextCollapsed });
      } catch (error) {
        console.error('Failed to persist collapsed state:', error);
      }
    }
  },

  toggleBookmark: (blockId: string) => {
    let updatedBlock: Block | null = null;

    set((state) => {
      const newMap = new Map(state.blocksByTab);

      for (const [tabId, blocks] of newMap.entries()) {
        const index = blocks.findIndex(b => b.id === blockId);
        if (index !== -1) {
          const updatedBlocks = [...blocks];
          updatedBlocks[index] = {
            ...updatedBlocks[index],
            bookmarked: !updatedBlocks[index].bookmarked,
          };
          newMap.set(tabId, updatedBlocks);
          updatedBlock = updatedBlocks[index];

          break;
        }
      }

      return { blocksByTab: newMap };
    });

    // Async: persist to DB (outside set callback)
    if (updatedBlock) {
      get().syncBlockToDb(updatedBlock);
    }
  },

  deleteBlock: (blockId: string) => {
    let shouldDelete = false;

    set((state) => {
      const newMap = new Map(state.blocksByTab);

      for (const [tabId, blocks] of newMap.entries()) {
        const filtered = blocks.filter(b => b.id !== blockId);
        if (filtered.length !== blocks.length) {
          newMap.set(tabId, filtered);
          shouldDelete = true;

          break;
        }
      }

      return { blocksByTab: newMap };
    });

    // Async: delete from DB (outside set callback)
    if (shouldDelete) {
      invoke('blocks_delete', { blockId }).catch(console.error);
    }
  },

  rerunBlock: async (blockId: string) => {
    const state = get();

    // Find the block
    for (const blocks of state.blocksByTab.values()) {
      const block = blocks.find(b => b.id === blockId);
      if (block) {
        // Send command directly to PTY
        const command = block.command + '\n';
        const cmdBytes = new TextEncoder().encode(command);

        try {
          await ptyWrite(block.tabId, cmdBytes);
        } catch (error) {
          console.error('Failed to rerun command:', error);
        }

        break;
      }
    }
  },

  explainBlock: async (blockId: string) => {
    const state = get();
    let targetBlock: Block | null = null;

    // Find the block
    for (const blocks of state.blocksByTab.values()) {
      const block = blocks.find(b => b.id === blockId);
      if (block) {
        targetBlock = block;
        break;
      }
    }

    if (!targetBlock) {
      console.error('Block not found:', blockId);
      return;
    }

    try {
      // Call sidecar to explain command
      const explanation = await invoke<string>('agent_explain_command', {
        command: targetBlock.command,
        cwd: targetBlock.cwd,
      });

      // Update block with explanation - re-verify block exists
      set((state) => {
        const newMap = new Map(state.blocksByTab);
        let blockFound = false;

        for (const [tabId, blocks] of newMap.entries()) {
          const index = blocks.findIndex(b => b.id === blockId);
          if (index !== -1) {
            blockFound = true;
            const updatedBlocks = [...blocks];
            updatedBlocks[index] = {
              ...updatedBlocks[index],
              aiExplanation: explanation,
            };
            newMap.set(tabId, updatedBlocks);

            // Persist to DB
            get().syncBlockToDb(updatedBlocks[index]);
            break;
          }
        }

        // Log if block was deleted before explanation could be saved
        if (!blockFound) {
          console.warn(`Block ${blockId} was deleted before explanation could be saved`);
        }

        return { blocksByTab: newMap };
      });
    } catch (error) {
      console.error('Failed to explain command:', error);

      // Set error state so UI can show failure
      set((state) => {
        const newMap = new Map(state.blocksByTab);

        for (const [tabId, blocks] of newMap.entries()) {
          const index = blocks.findIndex(b => b.id === blockId);
          if (index !== -1) {
            const updatedBlocks = [...blocks];
            updatedBlocks[index] = {
              ...updatedBlocks[index],
              aiExplanation: null, // Explicitly mark as failed
            };
            newMap.set(tabId, updatedBlocks);
            break;
          }
        }

        return { blocksByTab: newMap };
      });
    }
  },

  analyzeError: async (blockId: string) => {
    const state = get();
    let targetBlock: Block | null = null;

    // Find the block
    for (const blocks of state.blocksByTab.values()) {
      const block = blocks.find(b => b.id === blockId);
      if (block) {
        targetBlock = block;
        break;
      }
    }

    if (!targetBlock) {
      console.error('Block not found:', blockId);
      return;
    }

    // Only analyze failed commands
    if (targetBlock.exitCode === undefined || targetBlock.exitCode === 0) {
      console.warn('Block has not failed, skipping error analysis');
      return;
    }

    try {
      // Call Rust command to analyze error
      // Note: paneId is not available in blocksStore context, so we pass undefined
      // The backend will still get tab context which is the most important
      const analysis = await aiAnalyzeError(
        targetBlock.command,
        targetBlock.output,
        targetBlock.exitCode ?? 0,
        targetBlock.cwd,
        targetBlock.tabId,
        undefined // paneId not available in this context
      );

      // Update block with error analysis - re-verify block exists
      set((state) => {
        const newMap = new Map(state.blocksByTab);
        let blockFound = false;

        for (const [tabId, blocks] of newMap.entries()) {
          const index = blocks.findIndex(b => b.id === blockId);
          if (index !== -1) {
            blockFound = true;
            const updatedBlocks = [...blocks];
            updatedBlocks[index] = {
              ...updatedBlocks[index],
              errorAnalysis: analysis,
            };
            newMap.set(tabId, updatedBlocks);

            // Persist to DB
            get().syncBlockToDb(updatedBlocks[index]);
            break;
          }
        }

        // Log if block was deleted before analysis could be saved
        if (!blockFound) {
          console.warn(`Block ${blockId} was deleted before error analysis could be saved`);
        }

        return { blocksByTab: newMap };
      });
    } catch (error) {
      console.error('Failed to analyze error:', error);

      // Set error state so UI can show failure
      set((state) => {
        const newMap = new Map(state.blocksByTab);

        for (const [tabId, blocks] of newMap.entries()) {
          const index = blocks.findIndex(b => b.id === blockId);
          if (index !== -1) {
            const updatedBlocks = [...blocks];
            updatedBlocks[index] = {
              ...updatedBlocks[index],
              errorAnalysis: null, // Explicitly mark as failed
            };
            newMap.set(tabId, updatedBlocks);
            break;
          }
        }

        return { blocksByTab: newMap };
      });
    }
  },

  addTag: async (blockId: string, tag: string) => {
    try {
      await invoke('block_tag_add', { blockId, tag });
    } catch (error) {
      console.error('Failed to add tag:', error);
      return;
    }
    set((state) => {
      const newMap = new Map(state.blocksByTab);
      for (const [tabId, blocks] of newMap.entries()) {
        const index = blocks.findIndex(b => b.id === blockId);
        if (index !== -1) {
          const updated = [...blocks];
          const existing = updated[index].tags ?? [];
          if (!existing.includes(tag)) {
            updated[index] = { ...updated[index], tags: [...existing, tag].sort() };
            newMap.set(tabId, updated);
          }
          break;
        }
      }
      return { blocksByTab: newMap };
    });
  },

  removeTag: async (blockId: string, tag: string) => {
    try {
      await invoke('block_tag_remove', { blockId, tag });
    } catch (error) {
      console.error('Failed to remove tag:', error);
      return;
    }
    set((state) => {
      const newMap = new Map(state.blocksByTab);
      for (const [tabId, blocks] of newMap.entries()) {
        const index = blocks.findIndex(b => b.id === blockId);
        if (index !== -1) {
          const updated = [...blocks];
          updated[index] = {
            ...updated[index],
            tags: (updated[index].tags ?? []).filter(t => t !== tag),
          };
          newMap.set(tabId, updated);
          break;
        }
      }
      return { blocksByTab: newMap };
    });
  },

  togglePin: async (blockId: string) => {
    const state = get();
    let target: Block | null = null;
    for (const blocks of state.blocksByTab.values()) {
      const found = blocks.find(b => b.id === blockId);
      if (found) {
        target = found;
        break;
      }
    }
    if (!target) {
      console.warn('togglePin: block not found', blockId);
      return;
    }

    const willPin = !target.pinned;
    try {
      if (willPin) {
        await invoke('block_pin', { blockId, position: target.pinPosition ?? 0 });
      } else {
        await invoke('block_unpin', { blockId });
      }
    } catch (error) {
      console.error('Failed to toggle pin:', error);
      return;
    }

    set((s) => {
      const newMap = new Map(s.blocksByTab);
      for (const [tabId, blocks] of newMap.entries()) {
        const index = blocks.findIndex(b => b.id === blockId);
        if (index !== -1) {
          const updated = [...blocks];
          updated[index] = {
            ...updated[index],
            pinned: willPin,
            pinPosition: willPin ? (updated[index].pinPosition ?? 0) : undefined,
          };
          newMap.set(tabId, updated);
          break;
        }
      }
      return { blocksByTab: newMap };
    });
  },

  setPinPosition: async (blockId: string, position: number) => {
    try {
      await invoke('block_pin', { blockId, position });
    } catch (error) {
      console.error('Failed to set pin position:', error);
      return;
    }
    set((s) => {
      const newMap = new Map(s.blocksByTab);
      for (const [tabId, blocks] of newMap.entries()) {
        const index = blocks.findIndex(b => b.id === blockId);
        if (index !== -1) {
          const updated = [...blocks];
          updated[index] = {
            ...updated[index],
            pinned: true,
            pinPosition: position,
          };
          newMap.set(tabId, updated);
          break;
        }
      }
      return { blocksByTab: newMap };
    });
  },

  createShare: async (blockId: string) => {
    const shareId = await invoke<string>('block_share_create', { blockId });
    set((s) => {
      const newMap = new Map(s.blocksByTab);
      for (const [tabId, blocks] of newMap.entries()) {
        const index = blocks.findIndex(b => b.id === blockId);
        if (index !== -1) {
          const updated = [...blocks];
          updated[index] = { ...updated[index], shareId };
          newMap.set(tabId, updated);
          break;
        }
      }
      return { blocksByTab: newMap };
    });
    return shareId;
  },

  revokeShare: async (blockId: string) => {
    const state = get();
    let target: Block | null = null;
    for (const blocks of state.blocksByTab.values()) {
      const found = blocks.find(b => b.id === blockId);
      if (found) {
        target = found;
        break;
      }
    }
    if (!target || !target.shareId) {
      // Nothing to revoke; treat as no-op so callers don't have to special-case.
      return;
    }

    const shareId = target.shareId;
    try {
      await invoke('block_share_revoke', { shareId });
    } catch (error) {
      console.error('Failed to revoke share:', error);
      throw error;
    }

    set((s) => {
      const newMap = new Map(s.blocksByTab);
      for (const [tabId, blocks] of newMap.entries()) {
        const index = blocks.findIndex(b => b.id === blockId);
        if (index !== -1) {
          const updated = [...blocks];
          // Strip shareId so the popover's "Revoke" affordance becomes disabled
          // and "Copy link" knows to create a fresh share next time.
          const { shareId: _drop, ...rest } = updated[index];
          void _drop;
          updated[index] = { ...rest, shareId: undefined };
          newMap.set(tabId, updated);
          break;
        }
      }
      return { blocksByTab: newMap };
    });
  },

  importShare: async (shareId: string) => {
    // The Rust command returns a snake_case BlockDto; map to the store shape.
    const dto = await invoke<{
      id: string;
      tab_id: string;
      cmd: string;
      output: string;
      exit_code: number | null;
      started_at: number;
      ended_at: number | null;
    }>('block_share_fetch', { shareId });

    const block: Block = {
      id: dto.id,
      tabId: dto.tab_id,
      command: dto.cmd,
      cwd: '/',
      timestamp: dto.started_at * 1000,
      output: dto.output,
      outputLineCount: dto.output ? dto.output.split('\n').length : 0,
      exitCode: dto.exit_code ?? undefined,
      durationMs: dto.ended_at && dto.started_at ? (dto.ended_at - dto.started_at) * 1000 : undefined,
      collapsed: false,
      bookmarked: false,
      tags: [],
      pinned: false,
      shareId,
    };
    return block;
  },

  setFilterTags: (tags: string[]) => {
    set({ filterTags: tags });
  },

  loadBlocksForTab: async (tabId: string) => {
    try {
      // The Rust `blocks_list` command returns rows with snake_case column
      // names; map them to the camelCase store shape (same pattern as
      // importShare). The only field already camelCased on the backend is
      // `iacExecutionId` (via serde rename).
      const rows = await invoke<RawBlockRow[]>('blocks_list', { tabId, limit: 100 });

      const mapped: Block[] = rows.map((r) => ({
        id: r.id,
        tabId: r.tab_id,
        command: r.cmd,
        cwd: r.cwd ?? '/',
        timestamp: r.started_at * 1000,
        durationMs: r.duration_ms ?? undefined,
        exitCode: r.exit_code ?? undefined,
        output: r.output ?? '',
        outputLineCount: r.output_line_count ?? (r.output ? r.output.split('\n').length : 0),
        collapsed: Number(r.collapsed) === 1,
        bookmarked: Number(r.is_bookmarked) === 1,
        aiAnalysis: r.ai_analysis ?? undefined,
        aiExplanation: r.ai_explanation ?? undefined,
        errorAnalysis: r.error_analysis ? JSON.parse(r.error_analysis) : undefined,
        tags: [],
        pinned: false,
        iacExecutionId: r.iacExecutionId ?? undefined,
      }));

      set((state) => {
        const newMap = new Map(state.blocksByTab);
        newMap.set(tabId, mapped);
        return { blocksByTab: newMap };
      });
    } catch (error) {
      console.error('Failed to load blocks:', error);
    }
  },

  loadBlocks: (tabId: string, blocks: Block[]) => {
    set((state) => {
      const newMap = new Map(state.blocksByTab);

      // Append to existing blocks to preserve current session
      const existing = newMap.get(tabId) || [];
      newMap.set(tabId, [...existing, ...blocks]);

      return { blocksByTab: newMap };
    });

    // Persist all blocks to DB
    blocks.forEach(block => {
      get().syncBlockToDb(block);
    });
  },

  syncBlockToDb: async (block: Block) => {
    try {
      await invoke('blocks_upsert', {
        block: {
          id: block.id,
          tab_id: block.tabId,
          cmd: block.command,
          cwd: block.cwd,
          output: block.output,
          exit_code: block.exitCode ?? null,
          started_at: Math.floor(block.timestamp / 1000),
          ended_at: block.exitCode !== undefined ? Math.floor(Date.now() / 1000) : null,
          output_line_count: block.outputLineCount,
          is_bookmarked: block.bookmarked ? 1 : 0,
          ai_analysis: block.aiAnalysis ?? null,
          ai_explanation: block.aiExplanation ?? null,
          error_analysis: block.errorAnalysis ? JSON.stringify(block.errorAnalysis) : null,
          duration_ms: block.durationMs ?? null,
          collapsed: block.collapsed ? 1 : 0,
        }
      });
    } catch (error) {
      console.error('Failed to sync block to DB:', error);
    }
  },
}));
