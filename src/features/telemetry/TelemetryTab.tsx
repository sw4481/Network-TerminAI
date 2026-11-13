import { useEffect, useRef, useState } from "react";
import { telemetryWorkspaces, useTelemetryStore } from "./store";
import { telemetryApi } from "./api";
import { sshListConnections } from "../../lib/sshConnections";
import type { Platform, TargetRef } from "./types";
import { FleetView } from "./FleetView";
import { DeviceView } from "./DeviceView";
import { LocalPcView } from "./LocalPcView";
import { WidgetStudio } from "./WidgetStudio";
import "./telemetry.css";

type SavedTarget = { id: string; name: string; platform: string };
export function TelemetryTab({ tabId }: { tabId: string }) {
  const [genericProfiles, setGenericProfiles] = useState<
    Record<string, Platform>
  >({});
  const state = useTelemetryStore(tabId),
    snapshot = state?.snapshot;
  const [view, setView] = useState("fleet"),
    [targetId, setTarget] = useState("");
  const [studioOpened, setStudioOpened] = useState(false);
  const [connections, setConnections] = useState<SavedTarget[]>([]),
    [connectionError, setConnectionError] = useState("");
  const [picker, setPicker] = useState(false),
    [pending, setPending] = useState<TargetRef[] | null>(null),
    [local, setLocal] = useState(true);
  const [draft, setDraft] = useState<TargetRef[]>([]),
    [draftLocal, setDraftLocal] = useState(true);
  const dialog = useRef<HTMLDialogElement>(null),
    manage = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    void telemetryWorkspaces.establish(tabId);
  }, [tabId]);
  useEffect(() => {
    let active = true;
    void sshListConnections()
      .then((rows) => {
        if (active)
          setConnections(
            rows.map(({ id, name, platform }) => ({ id, name, platform })),
          );
      })
      .catch((e) => {
        if (active) setConnectionError(String(e.message ?? e));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (picker) dialog.current?.showModal();
  }, [picker]);
  const targets =
    pending ??
    snapshot?.targets
      .filter((t) => t.monitoring_selected && t.platform)
      .map((t) => ({ connection_id: t.target_id, platform: t.platform! })) ??
    [];
  const closePicker = () => {
    dialog.current?.close();
    setPicker(false);
    manage.current?.focus();
  };
  const start = (interfaces: Record<string, string[]> = {}) =>
    void telemetryWorkspaces
      .start({
        workspace_id: tabId,
        targets,
        local_enabled: local,
        monitored_interfaces: { ...telemetryWorkspaces.monitoredInterfaces(tabId, targets), ...interfaces },
      })
      .catch(() => {});
  const choose = (id: string) => {
    setTarget(id);
    setView("device");
  };
  const chooseSaved = (id: string) => {
    const saved = connections.find((c) => c.id === id);
    if (!saved) return;
    const platform =
      saved.platform === "ios" || saved.platform === "iosxe"
        ? saved.platform
        : pending?.find((t) => t.connection_id === id)?.platform;
    if (!platform) return;
    void telemetryWorkspaces
      .select(tabId, { connection_id: id, platform })
      .then(() => choose(id))
      .catch(() => {});
  };
  const disabled = !snapshot || state?.busy || state?.closing || state?.frozen;
  return (
    <section className="telemetry-workspace" aria-label="Telemetry workspace">
      <header className="telemetry-heading">
        <div>
          <h2>Telemetry</h2>
          <p>Your network and this computer, in one workspace.</p>
        </div>
        <div className="telemetry-toolbar">
          <button
            ref={manage}
            disabled={disabled}
            onClick={() => {
              setDraft(targets);
              setDraftLocal(local);
              setPicker(true);
            }}
          >
            Manage targets
          </button>
          <button
            className="telemetry-primary"
            disabled={
              disabled || snapshot?.running || (!targets.length && !local)
            }
            onClick={() => start()}
          >
            Start
          </button>
          <button
            disabled={!snapshot?.running || state?.busy || state?.closing || state?.frozen}
            onClick={() => void telemetryWorkspaces.stop(tabId).catch(() => {})}
          >
            Stop
          </button>
        </div>
      </header>
      <nav className="telemetry-nav" aria-label="Telemetry views">
        {[
          ["fleet", "Fleet"],
          ["device", "Device"],
          ["local", "Local PC"],
          ["widgets", "Widgets"],
        ].map(([id, label]) => (
          <button
            key={id}
            disabled={state?.frozen}
            aria-pressed={view === id}
            onClick={() => { if (id === "widgets") setStudioOpened(true); setView(id); }}
          >
            {label}
          </button>
        ))}
        <div className="telemetry-context">
          <span role="status">
            {state?.closing
              ? "Closing…"
              : state?.error
                ? "Telemetry status unavailable"
                : !snapshot
                  ? "Establishing workspace…"
                  : snapshot.running
                    ? "Monitoring"
                    : "Stopped"}
          </span>{" "}
          · History: rolling hour · Read-only
        </div>
      </nav>
      {state?.error && <p role="alert">{state.error}</p>}
      {connectionError && (
        <p>Saved target list unavailable: {connectionError}</p>
      )}
      {snapshot && !snapshot.running && snapshot.widgets.length > 0 && (
        <p className="telemetry-notice">
          Monitoring stopped. Retained observations show their original sample
          time.
        </p>
      )}
      {snapshot && (
        <>
          {view === "fleet" ? (
            <FleetView
              snapshot={snapshot}
              api={telemetryApi}
              workspaceId={tabId}
              onSelectTarget={choose}
            />
          ) : view === "device" ? (
            <>
              <label className="telemetry-filter">
                Device target
                <select
                  value={targetId}
                  disabled={disabled}
                  onChange={(e) => chooseSaved(e.target.value)}
                >
                  <option value="">Select a saved target</option>
                  {connections
                    .filter(
                      (c) =>
                        ["ios", "iosxe"].includes(c.platform) ||
                        targets.some((t) => t.connection_id === c.id),
                    )
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </label>
              <DeviceView
                key={targetId}
                snapshot={snapshot}
                api={telemetryApi}
                workspaceId={tabId}
                targetId={targetId}
                onMonitorInterfaces={
                  targets.some((t) => t.connection_id === targetId)
                    ? (id, interfaces) => start({ [id]: interfaces })
                    : undefined
                }
              />
            </>
          ) : view === "local" ? (
            <LocalPcView
              snapshot={snapshot}
              api={telemetryApi}
              workspaceId={tabId}
            />
          ) : null}
        </>
      )}
      {snapshot && studioOpened && <div hidden={view !== "widgets"}><WidgetStudio workspaceId={tabId} api={telemetryApi} catalog={null} /></div>}
      {picker && (
        <dialog
          ref={dialog}
          className="telemetry-targets"
          aria-labelledby="telemetry-target-title"
          onCancel={(e) => {
            e.preventDefault();
            closePicker();
          }}
        >
          <h2 id="telemetry-target-title">Monitoring targets</h2>
          <p>
            Choose up to ten saved IOS or IOS-XE connections. Collection begins
            with Start.
          </p>
          <div className="telemetry-target-list">
            {connections.map((c) => {
              const selected = draft.find((t) => t.connection_id === c.id),
                supported = ["ios", "iosxe", "generic"].includes(c.platform),
                profile = selected?.platform ?? genericProfiles[c.id];
              return (
                <div key={c.id}>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={c.name}
                      checked={!!selected}
                      disabled={
                        !supported ||
                        (c.platform === "generic" && !profile) ||
                        (!selected && draft.length >= 10)
                      }
                      onChange={(e) =>
                        setDraft(
                          e.target.checked
                            ? [
                                ...draft,
                                {
                                  connection_id: c.id,
                                  platform:
                                    c.platform === "generic"
                                      ? profile
                                      : c.platform === "ios"
                                        ? "ios"
                                        : "iosxe",
                                },
                              ]
                            : draft.filter((t) => t.connection_id !== c.id),
                        )
                      }
                    />
                    {c.name}
                    {c.platform === "generic" && (
                      <select
                        aria-label={`Platform for ${c.name}`}
                        value={profile ?? ""}
                        onChange={(e) => {
                          setGenericProfiles({
                            ...genericProfiles,
                            [c.id]: e.target.value as Platform,
                          });
                          setDraft(
                            draft.map((t) =>
                              t.connection_id === c.id
                                ? { ...t, platform: e.target.value as Platform }
                                : t,
                            ),
                          );
                        }}
                      >
                        <option value="" disabled>
                          Select IOS profile
                        </option>
                        <option value="ios">IOS</option>
                        <option value="iosxe">IOS-XE</option>
                      </select>
                    )}
                  </label>
                  {!supported && (
                    <p className="telemetry-muted">
                      Unsupported saved platform: {c.platform || "unavailable"}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          {draft
            .filter((t) => !connections.some((c) => c.id === t.connection_id))
            .map((t) => (
              <p key={t.connection_id}>
                A selected saved identity is unavailable.{" "}
                <button onClick={() => setDraft(draft.filter((d) => d !== t))}>
                  Remove unavailable identity
                </button>
              </p>
            ))}
          <label>
            <input
              type="checkbox"
              checked={draftLocal}
              onChange={(e) => setDraftLocal(e.target.checked)}
            />{" "}
            Monitor this computer
          </label>
          <p>{draft.length} / 10 network targets selected</p>
          <div className="telemetry-toolbar">
            <button
              disabled={disabled}
              onClick={async () => {
                if (snapshot?.running) {
                  try {
                    await telemetryWorkspaces.start({ workspace_id: tabId, targets: draft, local_enabled: draftLocal, monitored_interfaces: telemetryWorkspaces.monitoredInterfaces(tabId, draft) });
                  } catch { return; }
                }
                setPending(draft);
                setLocal(draftLocal);
                closePicker();
              }}
            >
              Use selection
            </button>
            <button onClick={closePicker}>Cancel</button>
          </div>
        </dialog>
      )}
    </section>
  );
}
