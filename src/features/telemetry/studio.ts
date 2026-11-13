import { createStore } from "zustand";
import yaml from "js-yaml";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { TelemetryApi } from "./api";
import type { TelemetryWorkspaceStore } from "./store";
import type {
  AuthoringCatalog,
  Capture,
  ConfigDraft,
  ConfigScope,
  Diagnostic,
  ParsedInterpretation,
  PreviewReport,
  ResetAsset,
  TargetRef,
  TemplateAsset,
  ValidationReport,
  WidgetDefinition,
  LayoutDefinition,
} from "./types";

export type StudioMode = "widgets" | "layouts" | "templates";
export class StudioFiles {
  async read(): Promise<string | null> {
    const path = await open({
      multiple: false,
      filters: [
        {
          name: "Telemetry YAML or TextFSM",
          extensions: ["yaml", "yml", "textfsm"],
        },
      ],
    });
    return typeof path === "string" ? readTextFile(path) : null;
  }
  async write(text: string, name: string): Promise<boolean> {
    const path = await save({
      defaultPath: name,
      filters: [
        {
          name: "Telemetry source",
          extensions: [name.endsWith("textfsm") ? "textfsm" : "yaml"],
        },
      ],
    });
    if (!path) return false;
    await writeTextFile(path, text);
    return true;
  }
}
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : String((error as { message?: unknown })?.message ?? error);
export interface StudioState {
  catalog: AuthoringCatalog;
  draft: ConfigDraft;
  dirty: boolean;
  frozen: boolean;
  busy: boolean;
  validation: ValidationReport | null;
  preview: PreviewReport | null;
  previewDraft: ConfigDraft | null;
  previewGeneration: number | null;
  diagnostics: Diagnostic[];
  error: string | null;
  notice: string;
  templateResult: ParsedInterpretation | null;
  samples: Capture[];
}

export class StudioDraft {
  readonly state;
  private baseline: string;
  private version = 0;
  private readonly scope = crypto.randomUUID();
  constructor(
    readonly workspaceId: string,
    private readonly api: TelemetryApi,
    private readonly owner: TelemetryWorkspaceStore,
    catalog: AuthoringCatalog,
  ) {
    this.baseline = JSON.stringify(catalog.own);
    this.state = createStore<StudioState>(() => ({
      catalog,
      draft: structuredClone(catalog.own),
      dirty: false,
      frozen: false,
      busy: false,
      validation: null,
      preview: null,
      previewDraft: null,
      previewGeneration: null,
      diagnostics: [],
      error: null,
      notice:
        "Edit the complete owned layer. Inherited definitions stay unchanged until Apply.",
      templateResult: null,
      samples: [],
    }));
  }
  invalidate() {
    this.version++;
    this.state.setState({
      validation: null,
      preview: null,
      previewDraft: null,
      previewGeneration: null,
      templateResult: null,
      diagnostics: [],
      busy: false,
      error: null,
      notice: "Preview invalidated. Validate the current bundle before applying.",
    });
  }
  edit(patch: Partial<ConfigDraft>) {
    if (this.state.getState().frozen) return;
    const draft = { ...this.state.getState().draft, ...patch };
    this.invalidate();
    this.state.setState({
      draft,
      dirty: JSON.stringify(draft) !== this.baseline,
    });
  }
  freeze(frozen: boolean) {
    if (frozen) this.invalidate();
    this.state.setState({ frozen });
  }
  private async run<T>(request: () => Promise<T>, accept: (value: T) => void) {
    if (this.state.getState().frozen) return;
    const version = this.version;
    this.state.setState({ busy: true, error: null });
    try {
      const value = await request();
      if (version === this.version && !this.state.getState().frozen)
        accept(value);
    } catch (error) {
      if (version === this.version)
        this.state.setState({ error: errorText(error) });
    } finally {
      if (version === this.version) this.state.setState({ busy: false });
    }
  }
  private read<T>(
    request: () => Promise<import("./types").TelemetryRead<T>>,
    revision = this.state.getState().draft.expected_revision,
  ) {
    return this.owner.read(
      this.workspaceId,
      `studio:${this.scope}`,
      request,
      revision,
    );
  }
  async load(scope: ConfigScope) {
    this.invalidate();
    await this.run(
      () =>
        this.owner.read(this.workspaceId, `studio:${this.scope}`, () =>
          this.api.catalog(this.workspaceId, scope),
        ),
      (reply) => {
        this.baseline = JSON.stringify(reply.value.own);
        this.state.setState({
          catalog: reply.value,
          draft: structuredClone(reply.value.own),
          dirty: false,
          samples: [],
          notice: "Loaded the canonical owned layer.",
        });
      },
    );
  }
  async validate() {
    const draft = this.state.getState().draft;
    this.state.setState({
      preview: null,
      previewDraft: null,
      validation: null,
    });
    await this.run(
      () => this.read(() => this.api.validate(this.workspaceId, draft)),
      ({ value }) =>
        this.state.setState({
          validation: value,
          diagnostics: value.diagnostics,
          notice: value.valid
            ? "Validated. Preview the exact draft before Apply."
            : "Validation failed; last applied definitions remain active.",
        }),
    );
  }
  async preview() {
    const { draft, validation } = this.state.getState();
    if (!validation?.valid) return;
    this.state.setState({ preview: null, previewDraft: null });
    await this.run(
      () => this.read(() => this.api.preview(this.workspaceId, draft)),
      ({ value, generation }) => {
        const token = value.token;
        if (
          token &&
          (token.draft_hash !== validation.draft_hash ||
            token.base_revision !== draft.expected_revision)
        )
          throw new Error(
            "Preview does not match the validated draft; validate again",
          );
        this.state.setState({
          preview: value,
          previewDraft: draft,
          previewGeneration: generation,
          samples: value.captures,
          diagnostics: value.diagnostics,
          notice: token
            ? "Preview ready. Review affected targets before Apply."
            : "Preview incompatible; matching retained samples are required.",
        });
      },
    );
  }
  canApply() {
    const { validation, preview, previewGeneration, draft, frozen, busy } =
        this.state.getState(),
      token = preview?.token;
    const current = this.owner.state.getState().workspaces[this.workspaceId];
    return !!(
      !frozen &&
      !busy &&
      current?.snapshot?.generation === previewGeneration &&
      !current.busy &&
      !current.closing &&
      !current.frozen &&
      validation?.valid &&
      token &&
      token.id &&
      token.draft_hash === validation.draft_hash &&
      token.base_revision === draft.expected_revision &&
      token.expires_at_ms > Date.now()
    );
  }
  async apply() {
    if (!this.canApply()) return;
    const { draft, preview } = this.state.getState();
    await this.run(
      () => this.owner.apply(this.workspaceId, draft, preview!.token!),
      ({ value }) => {
        this.baseline = JSON.stringify(draft);
        this.state.setState({
          dirty: false,
          notice: `Applied to ${value.affected_targets.length} targets; ${value.masked_device_overrides.length} masked device overrides.`,
        });
      },
    );
    if (!this.state.getState().error && !this.state.getState().dirty)
      await this.load(draft.scope);
  }
  async importYaml(text: string, mode: StudioMode, templateId = "") {
    if (mode === "templates") {
      this.edit({
        templates: {
          ...this.state.getState().draft.templates,
          [templateId]: text,
        },
      });
      return;
    }
    this.edit(
      mode === "widgets" ? { widgets_yaml: text } : { layouts_yaml: text },
    );
    const current = this.state.getState().draft;
    let document: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = yaml.load(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        document = parsed as Record<string, unknown>;
    } catch {
      /* native validation supplies source diagnostics */
    }
    if (document?.schema_version === 1) {
      await this.run(
        () => this.read(() => this.api.validate(this.workspaceId, current)),
        ({ value }) =>
          this.state.setState({
            diagnostics: value.diagnostics,
            notice:
              "Imported native YAML verbatim. Validate, Preview, then Apply the complete bundle.",
          }),
      );
      return;
    }
    if (
      document &&
      ((mode === "widgets" &&
        "layout" in document &&
        !("widget" in document)) ||
        (mode === "layouts" && "widget" in document))
    ) {
      this.state.setState({
        error: `This file contains ${mode === "widgets" ? "a layout; import it in Layouts" : "a widget; import it in Widgets"}. The exact text remains editable.`,
      });
      return;
    }
    await this.run(
      () =>
        this.read(() => this.api.import(this.workspaceId, current.scope, text)),
      ({ value }) => {
        if (value.draft && !value.diagnostics.length) {
          const imported = value.draft;
          // The importer translates upstream documents; native v1 input stays verbatim.
          this.edit(
            mode === "widgets"
              ? {
                  widgets_yaml: imported.widgets_yaml,
                  templates: { ...current.templates, ...imported.templates },
                }
              : { layouts_yaml: imported.layouts_yaml },
          );
        }
        this.state.setState({
          diagnostics: value.diagnostics,
          notice:
            value.draft && !value.diagnostics.length
              ? "Imported draft. Validate, Preview, then Apply."
              : "Unsupported import remains editable; no effective definitions changed.",
        });
      },
    );
  }
  exportText(mode: StudioMode, templateId = "") {
    const { draft } = this.state.getState();
    return mode === "templates"
      ? (draft.templates[templateId] ?? "")
      : mode === "widgets"
        ? draft.widgets_yaml
        : draft.layouts_yaml;
  }
  async importFile(
    files: Pick<StudioFiles, "read">,
    mode: StudioMode,
    templateId = "",
  ) {
    const version = this.version;
    if (this.state.getState().frozen) return;
    try {
      const text = await files.read();
      if (
        version === this.version &&
        !this.state.getState().frozen &&
        text !== null
      )
        await this.importYaml(text, mode, templateId);
    } catch (error) {
      if (version === this.version)
        this.state.setState({ error: errorText(error) });
    }
  }
  async exportFile(
    files: Pick<StudioFiles, "write">,
    mode: StudioMode,
    name: string,
    templateId = "",
  ) {
    const version = this.version;
    if (this.state.getState().frozen) return;
    try {
      const saved = await files.write(this.exportText(mode, templateId), name);
      if (saved && version === this.version && !this.state.getState().frozen)
        this.state.setState({
          notice:
            "Exported editable source. Raw captures and credentials are excluded.",
        });
    } catch (error) {
      if (version === this.version)
        this.state.setState({ error: errorText(error) });
    }
  }
  async reset(asset: ResetAsset) {
    const { draft } = this.state.getState();
    await this.run(
      () =>
        this.read(() => this.api.reset(this.workspaceId, draft.scope, asset)),
      ({ value }) => {
        const patch: Partial<ConfigDraft> = {
          reset_assets: [
            ...(draft.reset_assets ?? []).filter(
              (a) => JSON.stringify(a) !== JSON.stringify(asset),
            ),
            asset,
          ],
        };
        if ("template" in asset)
          patch.templates = { ...draft.templates, ...value.templates };
        else if ("widget" in asset)
          patch.widgets_yaml = this.mergeDocument(
            draft.widgets_yaml,
            value.widgets_yaml,
            "widgets",
            "widget",
            asset.widget,
          );
        else
          patch.layouts_yaml = this.mergeDocument(
            draft.layouts_yaml,
            value.layouts_yaml,
            "layouts",
            "layout",
            asset.layout,
          );
        this.edit(patch);
        this.state.setState({
          notice:
            "Inherited definition staged for explicit reset. Other overrides are retained.",
        });
      },
    );
  }
  private mergeDocument(
    current: string,
    incoming: string,
    kind: "widgets" | "layouts",
    key: "widget" | "layout",
    id: string,
  ) {
    const old = yaml.load(current) as Record<string, Record<string, unknown>[]>,
      next = yaml.load(incoming) as Record<string, Record<string, unknown>[]>;
    if (
      !old ||
      !Array.isArray(old[kind]) ||
      !next ||
      !Array.isArray(next[kind])
    )
      throw new Error(
        "Fix the current YAML before changing one asset; draft retained",
      );
    return yaml.dump(
      {
        ...old,
        [kind]: [
          ...old[kind].filter((entry) => entry[key] !== id),
          ...next[kind],
        ],
      },
      { lineWidth: -1 },
    );
  }
  putAsset(
    mode: "widgets" | "layouts",
    asset: WidgetDefinition | LayoutDefinition,
  ) {
    const kind = mode === "widgets" ? "widget" : "layout",
      id =
        kind === "widget"
          ? (asset as WidgetDefinition).widget
          : (asset as LayoutDefinition).layout;
    try {
      const text = this.exportText(mode);
      const merged = this.mergeDocument(
        text,
        yaml.dump({ schema_version: 1, [mode]: [asset] }),
        mode,
        kind,
        id,
      );
      this.edit(
        mode === "widgets"
          ? { widgets_yaml: merged }
          : { layouts_yaml: merged },
      );
    } catch (error) {
      this.state.setState({ error: errorText(error) });
    }
  }
  async capture(target: TargetRef, parserId: string) {
    this.invalidate();
    const draft = this.state.getState().draft;
    await this.run(
      () =>
        this.read(() =>
          this.api.captureSample(this.workspaceId, {
            kind: "draft",
            target,
            draft,
            parser_id: parserId,
          }),
        ),
      ({ value }) =>
        this.state.setState({
          samples: [
            value,
            ...this.state
              .getState()
              .samples.filter(
                (capture) => capture.capture_id !== value.capture_id,
              ),
          ],
          notice:
            "Sample captured. Validate and Preview to inspect its actual interpretation.",
        }),
    );
  }
  async testTemplate(captureId: string, template: TemplateAsset) {
    this.state.setState({ templateResult: null });
    let hash = "";
    await this.run(
      () =>
        this.read(async () => {
          hash = Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(template.text),
              ),
            ),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("");
          return this.api.testTemplate(this.workspaceId, captureId, {
            ...template,
            sha256: hash,
          });
        }),
      ({ value }) => {
        if (
          value.capture_id !== captureId ||
          value.parser_id !== template.id ||
          value.template_sha256 !== hash
        )
          throw new Error(
            "Template result does not match the selected capture",
          );
        this.state.setState({ templateResult: value });
      },
    );
  }
}
