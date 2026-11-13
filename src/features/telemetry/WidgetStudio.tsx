import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import yaml from "js-yaml";
import type * as Monaco from "monaco-editor";
import {
  MonacoEditor,
  DEFAULT_EDITOR_SETTINGS,
} from "../../components/editor/MonacoEditor";
import { yamlSchemaRegistry } from "../../components/editor/yamlSchemaRegistry";
import { telemetryWorkspaces, useTelemetryStore } from "./store";
import type { TelemetryApi } from "./api";
import { StudioDraft, StudioFiles, type StudioMode } from "./studio";
import { TemplateEditor } from "./TemplateEditor";
import { WidgetPanel, sampleTime } from "./WidgetPanel";
import { DashboardReader } from "./dashboard";
import type {
  AuthoringCatalog,
  AssetOrigin,
  ConfigScope,
  LayoutDefinition,
  TemplateAsset,
  WidgetDefinition,
  WidgetPage,
} from "./types";
import schema from "./widget-schema.json";

function documentAssets<T>(text: string, key: string): T[] {
  try {
    const doc = yaml.load(text) as Record<string, unknown>;
    const identity = key === "widgets" ? "widget" : "layout";
    return Array.isArray(doc?.[key])
      ? (doc[key] as unknown[]).filter(
          (entry): entry is T =>
            !!entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            typeof (entry as Record<string, unknown>)[identity] === "string" &&
            (key !== "widgets" ||
              typeof (entry as Record<string, unknown>).title === "string"),
        )
      : [];
  } catch {
    return [];
  }
}
const scopeValue = (scope: ConfigScope) =>
  typeof scope === "string"
    ? scope
    : "profile" in scope
      ? `profile:${scope.profile}`
      : `device:${scope.device}`;
const scopeFrom = (value: string): ConfigScope =>
  value === "local"
    ? "local"
    : value.startsWith("profile:")
      ? { profile: value.slice(8) as "ios" | "iosxe" }
      : { device: value.slice(7) };
const originLabel = (origin: AssetOrigin | undefined) =>
  !origin
    ? "New draft"
    : typeof origin === "string"
      ? origin === "builtin"
        ? "Bundled"
        : "Local override"
      : "profile" in origin
        ? `${origin.profile.toUpperCase()} profile override`
        : "Device override";

function StudioYaml({
  id,
  value,
  readOnly,
  onChange,
  editorRef,
}: {
  id: string;
  value: string;
  readOnly: boolean;
  onChange(value: string): void;
  editorRef: React.RefObject<Monaco.editor.IStandaloneCodeEditor | null>;
}) {
  const lease = useRef<{ release(): void } | null>(null);
  const mounted = useCallback(
    (editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => {
      // shortcut: Monaco 0.52.2 rejects a pending word-highlight delay on disposal; remove after a verified upgrade.
      editor.updateOptions({ occurrencesHighlight: "off" });
      lease.current?.release();
      editorRef.current = editor;
      const model = editor.getModel();
      if (model)
        lease.current = yamlSchemaRegistry.acquire(
          monaco,
          model.uri.toString(),
          schema,
        );
    },
    [editorRef],
  );
  useEffect(
    () => () => {
      lease.current?.release();
      lease.current = null;
      editorRef.current = null;
    },
    [editorRef],
  );
  return (
    <div className="telemetry-source-editor">
      <MonacoEditor
        bufferId={id}
        value={value}
        language="yaml"
        onChange={onChange}
        readOnly={readOnly}
        enableLsp={false}
        onEditorReady={mounted}
        settings={{ ...DEFAULT_EDITOR_SETTINGS, fontSize: 12, minimap: false }}
      />
    </div>
  );
}

function AppliedWidget({
  workspaceId,
  api,
  targetId,
  widgetId,
}: {
  workspaceId: string;
  api: TelemetryApi;
  targetId: string;
  widgetId: string;
}) {
  const lifecycle = useTelemetryStore(workspaceId),
    snapshot = lifecycle?.snapshot;
  const reader = useMemo(() => new DashboardReader(api), [api]);
  const [loaded, setLoaded] = useState<{
    definition: WidgetDefinition;
    page: WidgetPage;
  } | null>(null);
  const [error, setError] = useState("");
  const cache = useRef(new Map<string, WidgetDefinition>());
  useEffect(() => {
    let current = true;
    const summary = snapshot?.widgets.find(
      (entry) => entry.target_id === targetId && entry.widget_id === widgetId,
    );
    if (!summary || lifecycle?.busy || lifecycle?.closing || lifecycle?.frozen)
      return;
    void reader
      .catalog(workspaceId, targetId, "studio-applied")
      .then(async ({ value }) => {
        const definition = value.effective.widgets.find(
          (entry) => entry.widget === widgetId,
        );
        if (!definition) return;
        cache.current.set(
          `${value.effective.revision}:${widgetId}`,
          definition,
        );
        const page = await reader.widget(
          workspaceId,
          targetId,
          widgetId,
          value.effective.revision,
        );
        const original = cache.current.get(
          `${page.metadata.revision}:${widgetId}`,
        );
        if (current) {
          setLoaded(original ? { definition: original, page } : null);
          setError(
            original
              ? ""
              : "Retained data uses a previous definition unavailable in this Studio session.",
          );
        }
      })
      .catch((reason) => {
        if (current) setError(String(reason.message ?? reason));
      });
    return () => {
      current = false;
    };
  }, [
    reader,
    workspaceId,
    targetId,
    widgetId,
    snapshot?.generation,
    snapshot?.sequence,
    lifecycle?.busy,
    lifecycle?.closing,
    lifecycle?.frozen,
  ]);
  const actual =
    loaded?.page.metadata.target_id === targetId &&
    loaded.page.metadata.widget_id === widgetId
      ? loaded
      : null;
  return (
    <section className="telemetry-studio-card" aria-label="Last applied widget">
      <h3>Last applied widget</h3>
      {error && <p>{error}</p>}
      {actual ? (
        <WidgetPanel
          definition={actual.definition}
          page={actual.page}
          series={{ points: [], next_after_ms: null }}
        />
      ) : (
        <p>
          No retained observation for this selection. Editing never collects
          samples.
        </p>
      )}
    </section>
  );
}

export function WidgetStudio({
  workspaceId,
  api,
  catalog,
}: {
  workspaceId: string;
  api: TelemetryApi;
  catalog: AuthoringCatalog | null;
}) {
  const lifecycle = useTelemetryStore(workspaceId);
  const [initial, setInitial] = useState(catalog),
    [error, setError] = useState("");
  const key = useRef(`studio-bootstrap:${crypto.randomUUID()}`);
  useEffect(() => {
    let active = true;
    if (
      initial ||
      lifecycle?.busy ||
      lifecycle?.closing ||
      lifecycle?.frozen ||
      !lifecycle?.snapshot
    )
      return;
    void telemetryWorkspaces
      .read(workspaceId, key.current, () => api.catalog(workspaceId, "local"))
      .then(({ value }) => {
        if (active) {
          setInitial(value);
          setError("");
        }
      })
      .catch((reason) => {
        if (active) setError(String(reason.message ?? reason));
      });
    return () => {
      active = false;
    };
  }, [
    initial,
    workspaceId,
    api,
    lifecycle?.busy,
    lifecycle?.closing,
    lifecycle?.frozen,
    lifecycle?.snapshot?.generation,
  ]);
  if (!initial)
    return (
      <section aria-label="Widget studio">
        <h2>Widget studio</h2>
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <p>Loading authoring catalog…</p>
        )}
      </section>
    );
  return (
    <StudioWorkspace workspaceId={workspaceId} api={api} catalog={initial} />
  );
}

function StudioWorkspace({
  workspaceId,
  api,
  catalog,
}: {
  workspaceId: string;
  api: TelemetryApi;
  catalog: AuthoringCatalog;
}) {
  const studio = useMemo(
    () => new StudioDraft(workspaceId, api, telemetryWorkspaces, catalog),
    [workspaceId, api],
  );
  const state = useStore(studio.state),
    lifecycle = useTelemetryStore(workspaceId),
    snapshot = lifecycle?.snapshot;
  const [mode, setMode] = useState<StudioMode>("widgets"),
    [selected, setSelected] = useState(
      catalog.effective.widgets[0]?.widget ?? "",
    ),
    [newId, setNewId] = useState("new_widget"),
    [sampleId, setSampleId] = useState(""),
    [frameIndex, setFrameIndex] = useState(0),
    [captureTarget, setCaptureTarget] = useState("");
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null),
    identity = useRef(`telemetry-studio:${workspaceId}:${crypto.randomUUID()}`);
  const files = useMemo(() => new StudioFiles(), []);
  useEffect(
    () =>
      telemetryWorkspaces.registerDraft(workspaceId, {
        dirty: () => studio.state.getState().dirty,
        identity: () => studio.state.getState().draft,
        freeze: (value) => studio.freeze(value),
      }),
    [studio, workspaceId],
  );
  const ownWidgets = documentAssets<WidgetDefinition>(
      state.draft.widgets_yaml,
      "widgets",
    ),
    ownLayouts = documentAssets<LayoutDefinition>(
      state.draft.layouts_yaml,
      "layouts",
    );
  const widgets = [
    ...new Map(
      [...state.catalog.effective.widgets, ...ownWidgets].map((asset) => [
        asset.widget,
        asset,
      ]),
    ).values(),
  ];
  const layouts = [
    ...new Map(
      [...state.catalog.effective.layouts, ...ownLayouts].map((asset) => [
        asset.layout,
        asset,
      ]),
    ).values(),
  ];
  const templateIds = [
    ...new Set([
      ...Object.keys(state.catalog.effective.templates),
      ...Object.keys(state.draft.templates),
    ]),
  ];
  const items =
    mode === "widgets"
      ? widgets.map((asset) => ({ id: asset.widget, title: asset.title }))
      : mode === "layouts"
        ? layouts.map((asset) => ({ id: asset.layout, title: asset.layout }))
        : templateIds.map((id) => ({ id, title: id }));
  const selectedId = items.some((item) => item.id === selected)
    ? selected
    : (items[0]?.id ?? "");
  const widget = widgets.find((asset) => asset.widget === selectedId),
    layout = layouts.find((asset) => asset.layout === selectedId);
  const template = (id: string): TemplateAsset | null => {
    const original = state.catalog.effective.templates[id];
    const binding = widgets
      .flatMap((asset) =>
        asset.source?.kind === "ssh"
          ? Object.entries(asset.source.templates ?? {}).map(
              ([platform, parser]) => ({
                platform,
                parser,
                command:
                  asset.source.kind === "ssh"
                    ? asset.source.commands?.[platform as "ios" | "iosxe"]
                    : undefined,
              }),
            )
          : [],
      )
      .find((entry) => entry.parser === id && entry.command);
    const platform =
        (binding?.platform as "ios" | "iosxe" | undefined) ??
        original?.platform,
      command = binding?.command ?? original?.command;
    return platform && command
      ? {
          id,
          platform,
          command,
          text: state.draft.templates[id] ?? original?.text ?? "",
          sha256: original?.sha256 ?? "",
        }
      : null;
  };
  const activeTemplate = mode === "templates" ? template(selectedId) : null;
  const scope = state.draft.scope,
    scopedPlatform =
      typeof scope !== "string" && "profile" in scope
        ? scope.profile
        : snapshot?.targets.find(
            (target) =>
              typeof scope !== "string" &&
              "device" in scope &&
              target.target_id === scope.device,
          )?.platform;
  const targets =
    snapshot?.targets.filter(
      (target) =>
        target.platform &&
        (!scopedPlatform || target.platform === scopedPlatform),
    ) ?? [];
  const targetId = targets.some((target) => target.target_id === captureTarget)
    ? captureTarget
    : (targets[0]?.target_id ?? "");
  const parserId =
    activeTemplate?.id ??
    (widget?.source?.kind === "ssh"
      ? widget.source.templates?.[
          targets.find((target) => target.target_id === targetId)?.platform ??
            "iosxe"
        ]
      : undefined);
  const sample =
    state.samples.find((capture) => capture.capture_id === sampleId) ??
    state.samples.find(
      (capture) =>
        !activeTemplate ||
        (capture.platform === activeTemplate.platform &&
          capture.command === activeTemplate.command),
    ) ??
    null;
  const frozen = state.frozen || !!lifecycle?.frozen || !!lifecycle?.closing;
  const choose = (nextMode: StudioMode, id: string) => {
    if (frozen) return;
    studio.invalidate();
    setMode(nextMode);
    setSelected(id);
    setNewId(
      nextMode === "templates"
        ? "new_template"
        : nextMode === "layouts"
          ? "new_layout"
          : "new_widget",
    );
  };
  const confirmReplacement = () =>
    !state.dirty ||
    window.confirm(
      "Discard unsaved Telemetry YAML, layout and template drafts for this scope?",
    );
  const create = (duplicate: boolean) => {
    if (frozen) return;
    const id = newId.trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(id) || items.some((item) => item.id === id)) {
      studio.state.setState({
        error:
          "Choose a new unique asset ID using letters, numbers, dots, underscores or hyphens.",
      });
      return;
    }
    if (mode === "widgets") {
      const source = widget ?? widgets[0];
      if (!source) {
        studio.state.setState({
          error: "Import a widget source before creating a new widget.",
        });
        return;
      }
      studio.putAsset("widgets", {
        ...structuredClone(source),
        widget: id,
        title: duplicate ? `${source.title} copy` : "New widget",
      });
    } else if (mode === "layouts")
      studio.putAsset(
        "layouts",
        duplicate && layout
          ? { ...structuredClone(layout), layout: id }
          : {
              layout: id,
              platforms: scopedPlatform ? [scopedPlatform] : [],
              sections: [{ id: "overview", title: "Overview", rows: [] }],
            },
      );
    else
      studio.edit({
        templates: {
          ...state.draft.templates,
          [id]:
            duplicate && activeTemplate
              ? activeTemplate.text
              : "Value VALUE (.*)\n\nStart\n  ^${VALUE} -> Record\n",
        },
      });
    setSelected(id);
  };
  const fileAction = async (action: "import" | "export") => {
    if (frozen) return;
    if (action === "import")
      await studio.importFile(files, mode, selectedId || newId);
    else
      await studio.exportFile(
        files,
        mode,
        mode === "templates"
          ? `${selectedId || "template"}.textfsm`
          : `${mode}.yaml`,
        selectedId,
      );
  };
  const report = state.preview,
    frame = report?.frames[frameIndex],
    link = report?.frame_sources.find(
      (entry) => entry.frame_index === frameIndex,
    )?.source;
  const raw =
    report && link && "capture" in link
      ? report.captures.find(
          (capture) => capture.capture_id === link.capture.capture_id,
        )
      : null;
  const parsed =
    report && link && "capture" in link
      ? report.interpretations.find(
          (entry) =>
            entry.capture_id === link.capture.capture_id &&
            entry.parser_id === link.capture.parser_id,
        )
      : null;
  const local =
    report && link && "local" in link
      ? report.local_samples[link.local.sample_index]
      : null;
  const renderedDefinitions = state.previewDraft
    ? [
        ...state.catalog.effective.widgets,
        ...documentAssets<WidgetDefinition>(
          state.previewDraft.widgets_yaml,
          "widgets",
        ),
      ]
    : [];
  const rendered = [...renderedDefinitions]
    .reverse()
    .find((asset) => asset.widget === frame?.widget_id);
  const appliedTarget =
    typeof scope === "string"
      ? "local"
      : "device" in scope
        ? scope.device
        : targetId;
  return (
    <section className="telemetry-studio" aria-label="Widget studio">
      <header className="telemetry-studio-heading">
        <div>
          <h2>Widget studio</h2>
          <p>Define the collection, shape the data, choose the presentation.</p>
        </div>
        <span>{state.dirty ? "Unsaved draft" : "Owned layer loaded"}</span>
      </header>
      <div className="telemetry-toolbar">
        <label>
          Editing scope{" "}
          <select
            disabled={frozen || state.busy}
            value={scopeValue(scope)}
            onChange={(event) => {
              if (confirmReplacement()) {
                setSampleId("");
                setFrameIndex(0);
                void studio.load(scopeFrom(event.target.value));
              }
            }}
          >
            <option value="local">Local PC</option>
            <option value="profile:ios">IOS profile</option>
            <option value="profile:iosxe">IOS-XE profile</option>
            {snapshot?.targets
              .filter((target) => target.platform)
              .map((target) => (
                <option
                  key={target.target_id}
                  value={`device:${target.target_id}`}
                >
                  {target.display_name} device override
                </option>
              ))}
          </select>
        </label>
        <button
          disabled={frozen || state.busy}
          onClick={() => {
            if (confirmReplacement()) void studio.load(scope);
          }}
        >
          Reload owned layer
        </button>
      </div>
      <p className="telemetry-muted">
        Profile changes affect matching devices; explicit device overrides can
        mask them. Select saved devices in Device view before editing their
        overrides.
      </p>
      <div className="telemetry-studio-grid">
        <aside className="telemetry-studio-card telemetry-library">
          <h3>Library</h3>
          <nav aria-label="Studio asset types">
            {(["widgets", "layouts", "templates"] as const).map((kind) => (
              <button
                disabled={frozen}
                aria-pressed={mode === kind}
                key={kind}
                onClick={() => choose(kind, "")}
              >
                {kind === "widgets"
                  ? "Widgets"
                  : kind === "layouts"
                    ? "Layouts"
                    : "TextFSM"}
              </button>
            ))}
          </nav>
          <div className="telemetry-library-list">
            {items.map((item) => (
              <button
                key={item.id}
                disabled={frozen}
                aria-pressed={selectedId === item.id}
                onClick={() => choose(mode, item.id)}
              >
                <strong>{item.title}</strong>
                <small>
                  {originLabel(state.catalog.origins[mode][item.id])}
                </small>
              </button>
            ))}
          </div>
          <label>
            New asset ID
            <input
              value={newId}
              disabled={frozen}
              onChange={(event) => setNewId(event.target.value)}
            />
          </label>
          <div className="telemetry-toolbar">
            <button disabled={frozen} onClick={() => create(false)}>
              New{" "}
              {mode === "widgets"
                ? "widget"
                : mode === "layouts"
                  ? "layout"
                  : "template"}
            </button>
            <button
              disabled={frozen || !selectedId}
              onClick={() => create(true)}
            >
              Duplicate
            </button>
          </div>
          <p>
            Bundled definitions stay intact. Edits become explicit overrides.
            Omitting an asset does not delete an override.
          </p>
        </aside>
        <section
          className="telemetry-studio-card telemetry-studio-editor"
          aria-label="Draft editor"
        >
          <header>
            <div>
              <h3>
                {mode === "templates"
                  ? `${selectedId || "template"}.textfsm`
                  : `Owned ${mode}.yaml`}
              </h3>
              <small>
                Complete editable scope bundle ·{" "}
                {state.dirty ? "Unsaved changes" : "Canonical owned assets"}
              </small>
            </div>
            <div className="telemetry-toolbar">
              <button
                disabled={frozen}
                onClick={() => void fileAction("import")}
              >
                Import
              </button>
              <button
                disabled={frozen}
                onClick={() => void fileAction("export")}
              >
                Export
              </button>
              <button
                disabled={frozen || state.busy || !selectedId}
                onClick={() =>
                  void studio.reset(
                    mode === "widgets"
                      ? { widget: selectedId }
                      : mode === "layouts"
                        ? { layout: selectedId }
                        : { template: selectedId },
                  )
                }
              >
                Reset to inherited
              </button>
            </div>
          </header>
          {mode !== "templates" && (
            <>
              <p>
                All owned {mode} are shown. Library selection does not replace
                your YAML.
              </p>
              <button
                disabled={frozen || !(mode === "widgets" ? widget : layout)}
                onClick={() => {
                  if (mode === "widgets" && widget)
                    studio.putAsset("widgets", structuredClone(widget));
                  if (mode === "layouts" && layout)
                    studio.putAsset("layouts", structuredClone(layout));
                }}
              >
                Edit selected override
              </button>
              <StudioYaml
                key={mode}
                id={`${identity.current}:${mode}.yaml`}
                value={studio.exportText(mode)}
                readOnly={frozen}
                onChange={(text) =>
                  studio.edit(
                    mode === "widgets"
                      ? { widgets_yaml: text }
                      : { layouts_yaml: text },
                  )
                }
                editorRef={editor}
              />
            </>
          )}
          {mode === "templates" &&
            (activeTemplate ? (
              <TemplateEditor
                key={selectedId}
                draft={activeTemplate}
                sample={sample}
                onChange={(text) =>
                  studio.edit({
                    templates: {
                      ...studio.state.getState().draft.templates,
                      [selectedId]: text,
                    },
                  })
                }
                onTest={(id, asset) => void studio.testTemplate(id, asset)}
                result={state.templateResult}
                readOnly={frozen}
                busy={state.busy}
              />
            ) : (
              <>
                <p>
                  Add this template ID to an SSH widget's source
                  command/template binding, then return here to test it.
                </p>
                <div className="telemetry-source-editor">
                  <MonacoEditor
                    bufferId={`${identity.current}:unbound-template:${selectedId}`}
                    onEditorReady={(editor) =>
                      editor.updateOptions({ occurrencesHighlight: "off" })
                    }
                    value={studio.exportText("templates", selectedId)}
                    language="plaintext"
                    onChange={(text) =>
                      studio.edit({
                        templates: {
                          ...state.draft.templates,
                          [selectedId]: text,
                        },
                      })
                    }
                    readOnly={frozen}
                    enableLsp={false}
                  />
                </div>
              </>
            ))}
          <footer>
            <p role="status">{state.notice}</p>
            {state.error && <p role="alert">{state.error}</p>}
            <ul className="telemetry-diagnostics">
              {state.diagnostics.map((diagnostic, index) => (
                <li key={`${index}:${diagnostic.code}`}>
                  <button
                    disabled={!diagnostic.line}
                    onClick={() => {
                      if (diagnostic.line && editor.current) {
                        editor.current.revealLineInCenter(diagnostic.line);
                        editor.current.setPosition({
                          lineNumber: diagnostic.line,
                          column: diagnostic.column ?? 1,
                        });
                        editor.current.focus();
                      }
                    }}
                  >
                    {diagnostic.line ? `Line ${diagnostic.line}: ` : ""}
                    {diagnostic.path}: {diagnostic.message}
                  </button>
                </li>
              ))}
            </ul>
            <div className="telemetry-toolbar">
              <button
                disabled={frozen || state.busy}
                onClick={() => void studio.validate()}
              >
                Validate
              </button>
              <button
                disabled={frozen || state.busy || !state.validation?.valid}
                onClick={() => {
                  setFrameIndex(0);
                  void studio.preview();
                }}
              >
                Preview
              </button>
              <button
                className="telemetry-primary"
                disabled={!studio.canApply()}
                onClick={() => void studio.apply()}
              >
                Apply
              </button>
            </div>
            <p>
              Validate → Preview → Apply covers widgets, layouts and templates
              together. Editing and testing never acquire samples.
            </p>
          </footer>
        </section>
        <div className="telemetry-studio-preview">
          <section className="telemetry-studio-card">
            <h3>Preview review</h3>
            {state.validation && (
              <>
                <p>
                  Affected targets:{" "}
                  {state.validation.affected_targets
                    .map(
                      (id) =>
                        snapshot?.targets.find(
                          (target) => target.target_id === id,
                        )?.display_name ?? id,
                    )
                    .join(", ") || "None"}
                </p>
                <p>
                  Masked device overrides:{" "}
                  {state.validation.masked_device_overrides
                    .map(
                      (id) =>
                        snapshot?.targets.find(
                          (target) => target.target_id === id,
                        )?.display_name ?? id,
                    )
                    .join(", ") || "None"}
                </p>
              </>
            )}
            {report?.frames.length ? (
              <>
                <label>
                  Preview frame
                  <select
                    disabled={frozen}
                    value={frameIndex}
                    onChange={(event) =>
                      setFrameIndex(Number(event.target.value))
                    }
                  >
                    {report.frames.map((entry, index) => (
                      <option key={index} value={index}>
                        {entry.widget_id} ·{" "}
                        {snapshot?.targets.find(
                          (target) => target.target_id === entry.target_id,
                        )?.display_name ?? entry.target_id}
                      </option>
                    ))}
                  </select>
                </label>
                {frame && rendered && link ? (
                  <>
                    <WidgetPanel
                      definition={rendered}
                      page={{
                        metadata: { ...frame, row_count: frame.rows.length },
                        rows: frame.rows,
                        next_offset: null,
                      }}
                      series={{ points: [], next_after_ms: null }}
                    />
                    <details open>
                      <summary>Raw → Parsed → Rendered evidence</summary>
                      {raw && (
                        <>
                          <p>
                            {raw.command} · {sampleTime(raw.observed_at_ms)} ·
                            physical parser {raw.parser_id}
                          </p>
                          <pre>{raw.raw}</pre>
                        </>
                      )}
                      {parsed && (
                        <>
                          <p>
                            Actual interpretation: {parsed.parser_id} ·{" "}
                            {parsed.rows.length} records
                          </p>
                          <pre>{JSON.stringify(parsed.rows, null, 2)}</pre>
                        </>
                      )}
                      {local && link && "local" in link && (
                        <>
                          <p>
                            Structured Local source: {link.local.collector} ·{" "}
                            {sampleTime(local.observed_at_ms)}. No CLI capture.
                          </p>
                          <pre>
                            {JSON.stringify(
                              local.sources[link.local.collector],
                              null,
                              2,
                            )}
                          </pre>
                        </>
                      )}
                    </details>
                  </>
                ) : (
                  <p>
                    Preview frame has no matching source or definition; Apply
                    remains subject to native validation.
                  </p>
                )}
              </>
            ) : (
              <p>
                No current preview. Validate the draft and Preview retained
                matching samples.
              </p>
            )}
          </section>
          <section className="telemetry-studio-card">
            <h3>Samples</h3>
            <label>
              Capture target
              <select
                disabled={frozen}
                value={targetId}
                onChange={(event) => {
                  studio.invalidate();
                  setCaptureTarget(event.target.value);
                }}
              >
                <option value="">Select target</option>
                {targets.map((target) => (
                  <option key={target.target_id} value={target.target_id}>
                    {target.display_name}
                  </option>
                ))}
              </select>
            </label>
            <p>
              {parserId
                ? `Parser: ${parserId}`
                : "Select an SSH widget or bound template to acquire a sample."}
            </p>
            <button
              disabled={frozen || state.busy || !parserId || !targetId}
              onClick={() => {
                const target = targets.find(
                  (entry) => entry.target_id === targetId,
                );
                if (target?.platform && parserId)
                  void studio.capture(
                    { connection_id: targetId, platform: target.platform },
                    parserId,
                  );
              }}
            >
              Capture sample
            </button>
            <label>
              Retained capture
              <select
                disabled={frozen}
                value={sample?.capture_id ?? ""}
                onChange={(event) => {
                  studio.invalidate();
                  setSampleId(event.target.value);
                }}
              >
                <option value="">No capture selected</option>
                {state.samples.map((capture) => (
                  <option value={capture.capture_id} key={capture.capture_id}>
                    {snapshot?.targets.find(
                      (target) => target.target_id === capture.target_id,
                    )?.display_name ?? capture.target_id}{" "}
                    · {capture.command} · {sampleTime(capture.observed_at_ms)}
                  </option>
                ))}
              </select>
            </label>
            <p>
              Capture is an explicit admitted read-only command. Preview and
              TextFSM Test replay retained samples.
            </p>
          </section>
          {mode === "widgets" && (
            <AppliedWidget
              workspaceId={workspaceId}
              api={api}
              targetId={appliedTarget}
              widgetId={selectedId}
            />
          )}
          <details className="telemetry-studio-card">
            <summary>Current effective definition</summary>
            <pre>
              {yaml.dump(
                mode === "widgets"
                  ? (state.catalog.effective.widgets.find(
                      (asset) => asset.widget === selectedId,
                    ) ?? {})
                  : mode === "layouts"
                    ? (state.catalog.effective.layouts.find(
                        (asset) => asset.layout === selectedId,
                      ) ?? {})
                    : (state.catalog.effective.templates[selectedId] ?? {}),
                { lineWidth: -1 },
              )}
            </pre>
          </details>
        </div>
      </div>
    </section>
  );
}
