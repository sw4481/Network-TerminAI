import { createStore, useStore } from "zustand";
import { appPreflightGuards, registerAppShutdownTask, type AppFrozenOwner } from "../../lib/appShutdown";
import { telemetryApi, type TelemetryApi } from "./api";
import type {
  ConfigDraft,
  PreviewToken,
  SeriesQuery,
  StartRequest,
  TargetRef,
  TelemetryRead,
  TelemetrySnapshot,
  WidgetQuery,
  WidgetSummary,
} from "./types";

export interface TelemetryWorkspaceState {
  snapshot: TelemetrySnapshot | null;
  error: string | null;
  busy: boolean;
  closing: boolean;
  frozen?: boolean;
}
interface Owner {
  epoch: number;
  ready: Promise<void>;
  control: Promise<unknown>;
  close?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  failures: number;
  unregister: () => void;
  reads: Map<string, object>;
  refreshing: boolean;
  lease?: AppFrozenOwner & { approved: boolean };
}
interface DraftOwner { dirty(): boolean; identity(): object; freeze(value: boolean): void }
const message = (error: unknown) =>
  error &&
  typeof error === "object" &&
  "message" in error &&
  typeof error.message === "string"
    ? error.message
    : String(error);

export class TelemetryWorkspaceStore {
  readonly state = createStore<{
    workspaces: Record<string, TelemetryWorkspaceState>;
  }>(() => ({ workspaces: {} }));
  private readonly owners = new Map<string, Owner>();
  private readonly drafts = new Map<string, { draft: DraftOwner; confirm: (message: string) => boolean | Promise<boolean> }>();
  constructor(
    private readonly api: TelemetryApi,
    private readonly register = registerAppShutdownTask,
  ) {}

  private patch(id: string, value: Partial<TelemetryWorkspaceState>) {
    this.state.setState((state) => ({
      workspaces: {
        ...state.workspaces,
        [id]: { ...state.workspaces[id], ...value },
      },
    }));
  }
  establish(id: string): Promise<void> {
    const existing = this.owners.get(id);
    if (existing) return existing.ready;
    if (appPreflightGuards.isActive()) return Promise.reject(new Error("Application close decision in progress"));
    this.patch(id, { snapshot: null, busy: true, error: null, closing: false });
    const owner: Owner = {
      epoch: 0,
      ready: Promise.resolve(),
      control: Promise.resolve(),
      failures: 0,
      refreshing: false,
      reads: new Map(),
      unregister: this.register(`telemetry:${id}`, () => this.close(id)),
    };
    this.owners.set(id, owner);
    const unregisterShutdown = owner.unregister;
    const unregisterPreflight = appPreflightGuards.register(`telemetry:${id}`, () => this.freezeOwner(id));
    owner.unregister = () => { unregisterShutdown(); unregisterPreflight(); this.drafts.delete(id); };
    owner.ready = this.api
      .establish(id)
      .then((snapshot) => {
        if (owner.epoch === 0) this.accept(id, snapshot);
      })
      .catch((error) => {
        if (owner.epoch === 0) this.patch(id, { error: message(error) });
      })
      .finally(() => {
        if (!this.state.getState().workspaces[id]?.closing) {
          this.patch(id, { busy: false });
          this.schedule(id, owner);
        }
      });
    return owner.ready;
  }
  private accept(id: string, snapshot: TelemetrySnapshot) {
    const current = this.state.getState().workspaces[id]?.snapshot;
    if (
      this.state.getState().workspaces[id]?.closing ||
      snapshot.workspace_id !== id ||
      (current &&
        (snapshot.generation < current.generation ||
          (snapshot.generation === current.generation &&
            snapshot.sequence < current.sequence)))
    )
      return;
    this.patch(id, { snapshot, error: null });
  }
  private schedule(id: string, owner: Owner) {
    clearTimeout(owner.timer);
    if (
      this.owners.get(id) !== owner ||
      owner.refreshing ||
      this.state.getState().workspaces[id]?.frozen ||
      this.state.getState().workspaces[id]?.closing
    )
      return;
    owner.timer = setTimeout(
      () => {
        void this.refresh(id, owner);
      },
      Math.min(30_000, 1000 * 2 ** owner.failures),
    );
  }
  private async refresh(id: string, owner: Owner) {
    owner.refreshing = true;
    const epoch = owner.epoch;
    try {
      const snapshot = await this.api.snapshot(id);
      if (this.owners.get(id) === owner && epoch === owner.epoch) {
        this.accept(id, snapshot);
        owner.failures = 0;
      }
    } catch (error) {
      if (this.owners.get(id) === owner && epoch === owner.epoch) {
        owner.failures = Math.min(5, owner.failures + 1);
        this.patch(id, { error: message(error) });
      }
    } finally {
      owner.refreshing = false;
      this.schedule(id, owner);
    }
  }
  private async control<T>(id: string, action: () => Promise<T>, approved = false): Promise<T> {
    const owner = this.owners.get(id);
    if (!owner || this.state.getState().workspaces[id].closing || (this.state.getState().workspaces[id].frozen && !approved))
      throw new Error("Telemetry workspace is unavailable");
    owner.epoch++;
    owner.reads.clear();
    clearTimeout(owner.timer);
    this.patch(id, { busy: true, error: null });
    const run = owner.control
      .catch(() => {})
      .then(() => owner.ready)
      .then(() => {
        if (this.state.getState().workspaces[id]?.closing || (this.state.getState().workspaces[id]?.frozen && !approved))
          throw new Error("Telemetry workspace is closing");
        return action();
      });
    owner.control = run;
    try {
      return await run;
    } catch (error) {
      if (owner.control === run) this.patch(id, { error: message(error) });
      throw error;
    } finally {
      if (
        owner.control === run &&
        !this.state.getState().workspaces[id]?.closing
      ) {
        this.patch(id, { busy: false });
        this.schedule(id, owner);
      }
    }
  }
  registerDraft(id: string, draft: DraftOwner, confirm = (message: string): boolean | Promise<boolean> => window.confirm(message)) {
    if (this.owners.get(id)?.lease) throw new Error("Telemetry close decision in progress");
    const entry = { draft, confirm };
    this.drafts.set(id, entry);
    return () => { if (this.drafts.get(id) === entry) this.drafts.delete(id); };
  }
  private freezeOwner(id: string): AppFrozenOwner & { approved: boolean } {
    const owner = this.owners.get(id);
    if (!owner || owner.lease || owner.close) throw new Error("Telemetry close decision already in progress");
    const entry = this.drafts.get(id), identity = entry?.draft.identity();
    owner.epoch++; owner.reads.clear();
    clearTimeout(owner.timer);
    this.patch(id, { frozen: true }); entry?.draft.freeze(true);
    let released = false;
    const lease = {
      approved: false,
      confirm: async () => {
        const accepted = !entry?.draft.dirty() || await entry.confirm("Close Telemetry without saving the YAML, layout and template drafts?");
        if (released || this.drafts.get(id) !== entry || entry?.draft.identity() !== identity) return false;
        lease.approved = accepted; return accepted;
      },
      release: () => {
        if (released) return;
        released = true;
        if (owner.lease === lease) { owner.lease = undefined; entry?.draft.freeze(false); this.patch(id, { frozen: false }); this.schedule(id, owner); }
      },
      prepareUpdate: async () => {
        if (!lease.approved || released) throw new Error("Telemetry close approval expired");
        await this.control(id, async () => { await this.api.stop(id); this.accept(id, await this.api.snapshot(id)); }, true);
      },
    };
    owner.lease = lease;
    return lease;
  }
  start(request: StartRequest) {
    return this.control(request.workspace_id, async () =>
      this.accept(request.workspace_id, await this.api.start(request)),
    );
  }
  stop(id: string) {
    return this.control(id, async () => {
      await this.api.stop(id);
      this.accept(id, await this.api.snapshot(id));
    });
  }
  select(id: string, target: TargetRef) {
    return this.control(id, async () =>
      this.accept(id, await this.api.select(id, target)),
    );
  }
  apply(id: string, draft: ConfigDraft, token: PreviewToken) {
    return this.control(id, async () => {
      const applied = await this.api.apply(id, draft, token);
      if (
        applied.workspace_id !== id ||
        applied.generation <
          (this.state.getState().workspaces[id]?.snapshot?.generation ??
            Infinity) ||
        applied.revision !== applied.value.revision
      )
        throw new Error(
          "Telemetry Apply reply is obsolete; reload configuration",
        );
      const snapshot = await this.api.snapshot(id);
      if (
        this.state.getState().workspaces[id]?.closing ||
        snapshot.workspace_id !== id ||
        snapshot.generation < applied.generation
      )
        throw new Error(
          "Telemetry Apply reply is obsolete; reload configuration",
        );
      this.accept(id, snapshot);
      return applied;
    });
  }
  async read<T>(
    id: string,
    key: string,
    request: () => Promise<TelemetryRead<T>>,
    revision?: string,
  ): Promise<TelemetryRead<T>> {
    const owner = this.owners.get(id);
    const state = this.state.getState().workspaces[id];
    if (!owner || !state?.snapshot || state.closing || state.busy || state.frozen)
      throw new Error("Telemetry workspace is unavailable");
    const epoch = owner.epoch,
      generation = state.snapshot.generation,
      sequence = state.snapshot.sequence;
    const operation = {};
    owner.reads.set(key, operation);
    try {
      const response = await request();
      const current = this.state.getState().workspaces[id];
      if (
        this.owners.get(id) !== owner ||
        owner.epoch !== epoch ||
        owner.reads.get(key) !== operation ||
        current?.closing ||
        current?.frozen ||
        current?.snapshot?.generation !== generation ||
        response.workspace_id !== id ||
        response.generation !== generation ||
        response.sequence < sequence ||
        (revision !== undefined && response.revision !== revision)
      )
        throw new Error("Telemetry reply is obsolete; retry");
      return response;
    } finally {
      if (owner.reads.get(key) === operation) owner.reads.delete(key);
    }
  }
  async widget(
    query: WidgetQuery,
    sourceRevision: string,
    previous?: WidgetSummary,
    callerScope = "",
  ) {
    let summary = this.state
      .getState()
      .workspaces[
        query.workspace_id
      ]?.snapshot?.widgets.find((widget) => widget.target_id === query.target_id && widget.widget_id === query.widget_id);
    if (!summary || (query.offset > 0 && !previous))
      throw new Error("Telemetry table needs a first page");
    const response = await this.read(
      query.workspace_id,
      `widget:${query.target_id}:${query.widget_id}:${callerScope}`,
      () => this.api.widget(query),
      sourceRevision,
    );
    summary = this.state
      .getState()
      .workspaces[
        query.workspace_id
      ]?.snapshot?.widgets.find((widget) => widget.target_id === query.target_id && widget.widget_id === query.widget_id);
    const metadata = response.value.metadata;
    if (
      !summary ||
      metadata.workspace_id !== query.workspace_id ||
      metadata.target_id !== query.target_id ||
      metadata.widget_id !== query.widget_id ||
      metadata.generation !== summary.generation ||
      metadata.revision !== summary.revision ||
      metadata.observed_at_ms !== summary.observed_at_ms ||
      (previous &&
        (metadata.observed_at_ms !== previous.observed_at_ms ||
          metadata.generation !== previous.generation ||
          metadata.revision !== previous.revision))
    )
      throw new Error("Telemetry table changed; reload its first page");
    return response;
  }
  series(query: SeriesQuery, sourceRevision: string, callerScope = "") {
    const summary = this.state
      .getState()
      .workspaces[
        query.workspace_id
      ]?.snapshot?.widgets.find((widget) => widget.target_id === query.target_id && widget.widget_id === query.widget_id);
    if (!summary)
      return Promise.reject(new Error("Telemetry series has no sample"));
    return this.read(
      query.workspace_id,
      `series:${query.target_id}:${query.widget_id}:${query.row_key}:${query.field}:${callerScope}`,
      () => this.api.series(query),
      sourceRevision,
    );
  }
  close(id: string): Promise<void> {
    const owner = this.owners.get(id);
    if (!owner)
      return Promise.reject(new Error("Telemetry workspace is unavailable"));
    if (owner.close) return owner.close;
    const existingLease = owner.lease;
    if (existingLease && !existingLease.approved) return Promise.reject(new Error("Telemetry close decision in progress"));
    if (!existingLease) {
      const lease = this.freezeOwner(id);
      return lease.confirm().then((approved) => {
        if (!approved) { lease.release(); throw new Error("Telemetry close canceled"); }
        return this.close(id);
      }).catch((error) => { lease.release(); throw error; });
    }
    owner.epoch++;
    owner.reads.clear();
    clearTimeout(owner.timer);
    this.patch(id, { closing: true, busy: true });
    owner.close = owner.control
      .catch(() => {})
      .then(() => owner.ready)
      .then(() => this.api.close(id))
      .then(() => {
        owner.unregister();
        this.owners.delete(id);
        this.state.setState((state) => {
          const workspaces = { ...state.workspaces };
          delete workspaces[id];
          return { workspaces };
        });
      })
      .catch((error) => {
        owner.close = undefined;
        this.patch(id, { busy: false, error: message(error) });
        existingLease.release();
        throw error;
      });
    return owner.close;
  }
}
export const telemetryWorkspaces = new TelemetryWorkspaceStore(telemetryApi);
export const useTelemetryStore = (id: string) =>
  useStore(telemetryWorkspaces.state, (state) => state.workspaces[id]);
