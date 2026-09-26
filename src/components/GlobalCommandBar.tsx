import { useCallback, useEffect, useMemo, useState } from "react";
import {
  globalCommandBarGet,
  globalCommandBarSet,
  workflowList,
  type Vendor,
  type Workflow,
} from "../lib/workflows";
import { runWorkflowOnTerminal } from "../lib/workflowDispatcher";
import { WorkflowParamForm } from "./WorkflowParamForm";
import { WorkflowPicker } from "./WorkflowPicker";
import { usePanesStore } from "../state/panesStore";
import { useTerminalConnectionStore } from "../state/terminalConnectionStore";
import "./GlobalCommandBar.css";

export interface GlobalCommandBarProps {
  tabId: string;
  vendor: Vendor;
  platform: string;
}

export function workflowMatchesDevice(
  workflow: Workflow,
  vendor: Vendor,
  platform: string,
): boolean {
  if (workflow.vendor === "generic") return true;
  if (workflow.vendor !== vendor) return false;
  return (
    !workflow.platform ||
    workflow.platform === "generic" ||
    workflow.platform === "*" ||
    workflow.platform === platform
  );
}

export function GlobalCommandBar({ tabId, vendor, platform }: GlobalCommandBarProps) {
  const focusedTerminalId = usePanesStore((state) => state.resolveRecordingTerminalId(tabId));
  const connectedDevice = useTerminalConnectionStore(
    (state) => state.byTerminalId[focusedTerminalId] ?? null,
  );
  const effectiveVendor = connectedDevice?.vendor ?? vendor;
  const effectivePlatform = connectedDevice?.platform ?? platform;
  const [workflowIds, setWorkflowIds] = useState<string[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [parameterWorkflow, setParameterWorkflow] = useState<Workflow | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([globalCommandBarGet(), workflowList()])
      .then(([settings, available]) => {
        if (cancelled) return;
        setWorkflowIds(settings.workflow_ids);
        setWorkflows(available);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const byId = useMemo(
    () => new Map(workflows.map((workflow) => [workflow.id, workflow])),
    [workflows],
  );
  const pinned = useMemo(
    () => workflowIds.map((id) => byId.get(id)).filter((item): item is Workflow => !!item),
    [workflowIds, byId],
  );

  const save = useCallback(async (next: string[]) => {
    setError(null);
    await globalCommandBarSet({ schema_version: 1, workflow_ids: next });
    setWorkflowIds(next);
  }, []);

  const run = useCallback(async (workflow: Workflow, values: Record<string, string>) => {
    setRunningId(workflow.id);
    setError(null);
    try {
      await runWorkflowOnTerminal(workflow, tabId, values);
      setParameterWorkflow(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setRunningId(null);
    }
  }, [tabId]);

  const move = (index: number, delta: -1 | 1) => {
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= pinned.length) return;
    const next = pinned.map((workflow) => workflow.id);
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    void save(next).catch((cause) => setError(String(cause)));
  };

  return (
    <>
      <div className="global-command-bar" aria-label="Global workflow command bar">
        <div className="global-command-bar__scroll">
          {pinned.map((workflow, index) => {
            const compatible = workflowMatchesDevice(workflow, effectiveVendor, effectivePlatform);
            const mismatch = compatible
              ? workflow.description || workflow.name
              : `${workflow.name} is for ${workflow.vendor}/${workflow.platform || "generic"}; focused device is ${effectiveVendor}/${effectivePlatform || "generic"}`;
            return (
              <div
                className="global-command-bar__item"
                key={workflow.id}
                title={compatible ? undefined : mismatch}
              >
                <button
                  type="button"
                  className="global-command-bar__run"
                  disabled={!compatible || runningId !== null}
                  title={mismatch}
                  onClick={() => {
                    if (workflow.params.length > 0) setParameterWorkflow(workflow);
                    else void run(workflow, {});
                  }}
                >
                  {runningId === workflow.id ? "Running…" : workflow.name}
                </button>
                {!compatible && (
                  <span className="global-command-bar__scope" title={mismatch}>
                    {workflow.vendor}/{workflow.platform || "generic"} only
                  </span>
                )}
                <button
                  type="button"
                  className="global-command-bar__move"
                  aria-label={`Move ${workflow.name} left`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="global-command-bar__move"
                  aria-label={`Move ${workflow.name} right`}
                  disabled={index === pinned.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ›
                </button>
                <button
                  type="button"
                  className="global-command-bar__remove"
                  aria-label={`Unpin ${workflow.name}`}
                  onClick={() => {
                    void save(pinned.filter((item) => item.id !== workflow.id).map((item) => item.id))
                      .catch((cause) => setError(String(cause)));
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="global-command-bar__add"
            aria-label="Pin workflow"
            onClick={() => setPickerOpen(true)}
          >
            + Workflow
          </button>
        </div>
        {error && <div className="global-command-bar__error" role="alert">{error}</div>}
      </div>
      {pickerOpen && (
        <WorkflowPicker
          vendor={vendor}
          platform={platform}
          initialAllVendors
          onSelect={(workflow) => {
            setPickerOpen(false);
            if (pinned.some((item) => item.id === workflow.id)) return;
            void save([...pinned.map((item) => item.id), workflow.id])
              .catch((cause) => setError(String(cause)));
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {parameterWorkflow && (
        <WorkflowParamForm
          workflow={parameterWorkflow}
          onSubmit={(values) => void run(parameterWorkflow, values)}
          onCancel={() => setParameterWorkflow(null)}
        />
      )}
    </>
  );
}
