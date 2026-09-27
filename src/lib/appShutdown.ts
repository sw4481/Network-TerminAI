import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const APP_SHUTDOWN_PREPARE_EVENT = "app://prepare-shutdown";

export type AppShutdownPrepare = {
  requestId: number;
  reason: string;
  timeoutMs: number;
};

export type AppShutdownTask = () => void | Promise<void>;

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

export function installAppShutdownResponder(): Promise<UnlistenFn> {
  const handle = createAppShutdownRequestHandler(
    appShutdownTasks,
    acknowledgeAppShutdown,
  );
  return listen<AppShutdownPrepare>(
    APP_SHUTDOWN_PREPARE_EVENT,
    (event) => {
      void handle(event.payload);
    },
  );
}
