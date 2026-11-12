import { useEffect } from "react";
import { telemetryWorkspaces, useTelemetryStore } from "./store";

export function TelemetryTab({ tabId }: { tabId: string }) {
  const state = useTelemetryStore(tabId);
  useEffect(() => {
    void telemetryWorkspaces.establish(tabId);
  }, [tabId]);
  return (
    <section aria-label="Telemetry workspace">
      <h2>Telemetry</h2>
      <p role="status">
        {state?.closing
          ? "Closing…"
          : state?.error
            ? "Telemetry status unavailable"
            : !state?.snapshot
              ? "Establishing workspace…"
              : state.snapshot.running
                ? "Monitoring"
                : "Stopped"}
      </p>
      {state?.error && <p role="alert">{state.error}</p>}
      <button
        disabled={
          !state?.snapshot ||
          state.busy ||
          state.closing ||
          state.snapshot.running
        }
        onClick={() => {
          void telemetryWorkspaces
            .start({
              workspace_id: tabId,
              targets: [],
              local_enabled: true,
              monitored_interfaces: {},
            })
            .catch(() => {});
        }}
      >
        Start
      </button>
      <button
        disabled={!state?.snapshot?.running || state.busy || state.closing}
        onClick={() => {
          void telemetryWorkspaces.stop(tabId).catch(() => {});
        }}
      >
        Stop
      </button>
    </section>
  );
}
