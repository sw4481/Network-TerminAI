import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const APP_SHUTDOWN_PREPARE_EVENT = "app://prepare-shutdown";
export const APP_PREFLIGHT_EVENT = "app://shutdown-preflight";
export const APP_PREFLIGHT_CANCEL_EVENT = "app://shutdown-preflight-canceled";

export type AppShutdownPrepare = {
  requestId: number;
  reason: string;
  timeoutMs: number;
};

export type AppShutdownTask = () => void | Promise<void>;

export interface AppCloseLease {
  release(): void;
  prepareUpdate(): Promise<void>;
}
export interface AppFrozenOwner extends AppCloseLease {
  confirm(): Promise<boolean>;
}
export type AppPreflightPurpose = "quit" | "update";
export class AppPreflightRegistry {
  private readonly guards = new Map<
    string,
    (purpose: AppPreflightPurpose) => AppFrozenOwner
  >();
  private active: object | null = null;
  private version = 0;
  isActive() {
    return this.active !== null;
  }
  register(
    id: string,
    freeze: (purpose: AppPreflightPurpose) => AppFrozenOwner,
  ) {
    this.guards.set(id, freeze);
    this.version++;
    return () => {
      if (this.guards.get(id) === freeze) {
        this.guards.delete(id);
        this.version++;
      }
    };
  }
  async acquire(
    signal?: AbortSignal,
    purpose: AppPreflightPurpose = "update",
  ): Promise<AppCloseLease | null> {
    if (this.active)
      throw new Error("An application close decision is already in progress");
    if (signal?.aborted) return null;
    const attempt = {},
      owners: AppFrozenOwner[] = [],
      version = this.version;
    this.active = attempt;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const owner of owners) owner.release();
      if (this.active === attempt) this.active = null;
      signal?.removeEventListener("abort", release);
    };
    signal?.addEventListener("abort", release, { once: true });
    try {
      for (const freeze of this.guards.values()) owners.push(freeze(purpose));
      for (const owner of owners) {
        if (released || !(await owner.confirm())) {
          release();
          return null;
        }
      }
      if (released || version !== this.version) {
        release();
        return null;
      }
      return {
        release,
        prepareUpdate: async () => {
          if (released || purpose !== "update")
            throw new Error("Application update approval unavailable");
          for (const owner of owners) {
            await owner.prepareUpdate();
            if (released) throw new Error("Application close approval expired");
          }
        },
      };
    } catch (error) {
      release();
      throw error;
    }
  }
}
export const appPreflightGuards = new AppPreflightRegistry();

export function createAppPreflightHandler(
  registry: AppPreflightRegistry,
  decide: (id: number, approved: boolean, failed: boolean) => Promise<boolean>,
) {
  const requests = new Map<
    number,
    { controller: AbortController; pending: Promise<void> }
  >();
  return {
    prepare(request: AppShutdownPrepare): Promise<void> {
      const existing = requests.get(request.requestId);
      if (existing) return existing.pending;
      const controller = new AbortController();
      const pending = (async () => {
        let lease: AppCloseLease | null = null;
        try {
          lease = await registry.acquire(controller.signal, "quit");
          if (controller.signal.aborted) {
            lease?.release();
            return;
          }
          if (!(await decide(request.requestId, lease !== null, false)))
            lease?.release();
        } catch {
          lease?.release();
          if (!controller.signal.aborted) {
            try {
              await decide(request.requestId, false, true);
            } catch {
              /* native timeout also releases the lease */
            }
          }
        } finally {
          if (!lease || controller.signal.aborted)
            requests.delete(request.requestId);
        }
      })();
      requests.set(request.requestId, { controller, pending });
      return pending;
    },
    cancel(id: number) {
      requests.get(id)?.controller.abort();
      requests.delete(id);
    },
    dispose() {
      for (const request of requests.values()) request.controller.abort();
      requests.clear();
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AppShutdownTaskRegistry {
  private readonly tasks = new Map<string, AppShutdownTask>();

  register(id: string, task: AppShutdownTask): () => void {
    this.tasks.set(id, task);
    return () => {
      if (this.tasks.get(id) === task) this.tasks.delete(id);
    };
  }

  async prepareAll(): Promise<string[]> {
    const results = await Promise.all(
      [...this.tasks.entries()].map(async ([id, task]) => {
        try {
          await task();
          return null;
        } catch (error) {
          return `${id}: ${errorMessage(error)}`;
        }
      }),
    );
    return results.filter((failure): failure is string => failure !== null);
  }
}

export const appShutdownTasks = new AppShutdownTaskRegistry();

export function registerAppShutdownTask(
  id: string,
  task: AppShutdownTask,
): () => void {
  return appShutdownTasks.register(id, task);
}

type ShutdownAcknowledger = (
  requestId: number,
  failures: string[],
) => Promise<void>;

const acknowledgeAppShutdown: ShutdownAcknowledger = (requestId, failures) =>
  invoke<void>("app_shutdown_acknowledge", { requestId, failures });

export function createAppShutdownRequestHandler(
  tasks: AppShutdownTaskRegistry,
  acknowledge: ShutdownAcknowledger,
): (request: AppShutdownPrepare) => Promise<void> {
  const requests = new Map<number, Promise<void>>();
  return (request) => {
    const existing = requests.get(request.requestId);
    if (existing) return existing;

    const preparation = tasks
      .prepareAll()
      .then((failures) => acknowledge(request.requestId, failures));
    requests.set(request.requestId, preparation);
    return preparation;
  };
}

export async function installAppShutdownResponder(): Promise<UnlistenFn> {
  const handle = createAppShutdownRequestHandler(
    appShutdownTasks,
    acknowledgeAppShutdown,
  );
  const preflight = createAppPreflightHandler(
    appPreflightGuards,
    (requestId, approved, failed) =>
      invoke<boolean>("app_shutdown_preflight_decide", {
        requestId,
        approved,
        failed,
      }),
  );
  const listeners: UnlistenFn[] = [];
  const dispose = () => {
    for (const unlisten of listeners) unlisten();
    preflight.dispose();
  };
  try {
    listeners.push(
      await listen<AppShutdownPrepare>(APP_PREFLIGHT_EVENT, (event) => {
        void preflight.prepare(event.payload);
      }),
    );
    listeners.push(
      await listen<{ requestId: number }>(APP_PREFLIGHT_CANCEL_EVENT, (event) =>
        preflight.cancel(event.payload.requestId),
      ),
    );
    listeners.push(
      await listen<AppShutdownPrepare>(APP_SHUTDOWN_PREPARE_EVENT, (event) => {
        void handle(event.payload);
      }),
    );
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
