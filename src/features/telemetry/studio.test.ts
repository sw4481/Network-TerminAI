import { describe, expect, it, vi } from "vitest";
import { StudioDraft } from "./studio";
import { TelemetryApi } from "./api";
import { TelemetryWorkspaceStore } from "./store";
import type { AuthoringCatalog, PreviewReport, TelemetryRead } from "./types";
import { webcrypto } from "node:crypto";
import { appPreflightGuards } from "../../lib/appShutdown";

export const catalogFixture = (): AuthoringCatalog => ({
  effective: { revision: "effective", widgets: [], layouts: [], templates: {} },
  own: {
    scope: "local",
    widgets_yaml: "schema_version: 1\nwidgets: []\n",
    layouts_yaml: "schema_version: 1\nlayouts: []\n",
    templates: {},
    expected_revision: "base",
    reset_assets: [],
  },
  inherited: { widgets: {}, layouts: {}, templates: {} },
  builtin: { widgets: {}, layouts: {}, templates: {} },
  origins: { widgets: {}, layouts: {}, templates: {} },
});
export const envelope = <T>(value: T): TelemetryRead<T> => ({
  workspace_id: "studio",
  generation: 1,
  sequence: 1,
  revision: "base",
  value,
});
const emptyPreview = (): PreviewReport => ({
  token: {
    id: "native-token",
    draft_hash: "native-hash",
    base_revision: "base",
    sample_hashes: {},
    expires_at_ms: Date.now() + 10000,
  },
  frames: [],
  diagnostics: [],
  captures: [],
  local_samples: [],
  interpretations: [],
  frame_sources: [],
});
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  return {
    promise: new Promise<T>((r) => {
      resolve = r;
    }),
    resolve,
  };
};
export async function studioFixture() {
  const api = new TelemetryApi();
  vi.spyOn(api, "establish").mockResolvedValue({
    workspace_id: "studio",
    generation: 1,
    sequence: 1,
    running: false,
    targets: [],
    widgets: [],
    series: [],
    diagnostics: [],
  });
  vi.spyOn(api, "captureSample");
  vi.spyOn(api, "validate").mockResolvedValue(
    envelope({
      valid: true,
      draft_hash: "native-hash",
      diagnostics: [],
      affected_targets: ["a"],
      masked_device_overrides: ["b"],
    }),
  );
  vi.spyOn(api, "preview").mockResolvedValue(envelope(emptyPreview()));
  const owner = new TelemetryWorkspaceStore(api, () => () => {});
  await owner.establish("studio");
  const studio = new StudioDraft("studio", api, owner, catalogFixture());
  return { api, owner, studio };
}

describe("complete Studio draft authority", () => {
  it("revokes Apply when current workspace generation changes or native controls are busy", async () => {
    const { owner, studio } = await studioFixture();
    await studio.validate();
    await studio.preview();
    expect(studio.canApply()).toBe(true);
    const current = owner.state.getState().workspaces.studio;
    owner.state.setState({
      workspaces: { studio: { ...current, busy: true } },
    });
    expect(studio.canApply()).toBe(false);
    owner.state.setState({
      workspaces: {
        studio: {
          ...current,
          snapshot: { ...current.snapshot!, generation: 2 },
        },
      },
    });
    expect(studio.canApply()).toBe(false);
  });
  it("updater Stop and failed-install release keep raw drafts but revoke all prior native grants", async () => {
    const { api, owner, studio } = await studioFixture();
    studio.edit({
      widgets_yaml: "# exact dirty YAML\nschema_version: 1\nwidgets: []\n",
      templates: { candidate: "invalid exact template" },
    });
    const raw = structuredClone(studio.state.getState().draft);
    await studio.validate();
    await studio.preview();
    expect(studio.canApply()).toBe(true);
    vi.spyOn(api, "stop").mockResolvedValue(undefined);
    vi.spyOn(api, "snapshot").mockResolvedValue({
      workspace_id: "studio",
      generation: 2,
      sequence: 2,
      running: false,
      targets: [],
      widgets: [],
      series: [],
      diagnostics: [],
    });
    const unregister = owner.registerDraft(
      "studio",
      {
        dirty: () => studio.state.getState().dirty,
        identity: () => studio.state.getState().draft,
        freeze: (value) => studio.freeze(value),
      },
      () => true,
    );
    const approval = await appPreflightGuards.acquire();
    expect(studio.canApply()).toBe(false);
    await approval!.prepareUpdate();
    approval!.release();
    expect(api.stop).toHaveBeenCalledOnce();
    expect(studio.state.getState().draft).toEqual(raw);
    expect(studio.state.getState().catalog.effective.revision).toBe(
      "effective",
    );
    expect(studio.state.getState().frozen).toBe(false);
    expect(studio.state.getState().validation).toBeNull();
    expect(studio.state.getState().preview).toBeNull();
    expect(studio.canApply()).toBe(false);
    unregister();
  });
  it("studio_draft_change_invalidates_preview_and_apply", async () => {
    const { api, studio } = await studioFixture();
    await studio.validate();
    await studio.preview();
    expect(studio.canApply()).toBe(true);
    studio.edit({ layouts_yaml: "invalid layout draft" });
    expect(studio.canApply()).toBe(false);
    expect(studio.state.getState().preview).toBeNull();
    expect(api.captureSample).not.toHaveBeenCalled();
  });
  it("stale_validate_and_preview_replies_are_ignored", async () => {
    const { api, studio } = await studioFixture();
    const old = deferred<TelemetryRead<PreviewReport>>();
    vi.mocked(api.preview).mockReturnValueOnce(old.promise);
    await studio.validate();
    const pending = studio.preview();
    studio.edit({ templates: { custom: "invalid template" } });
    old.resolve(envelope(emptyPreview()));
    await pending;
    expect(studio.canApply()).toBe(false);
    expect(studio.state.getState().preview).toBeNull();
    const validation =
      deferred<Awaited<ReturnType<TelemetryApi["validate"]>>>();
    vi.mocked(api.validate).mockReturnValueOnce(validation.promise);
    const next = studio.validate();
    studio.invalidate();
    validation.resolve(
      envelope({
        valid: true,
        draft_hash: "old",
        diagnostics: [],
        affected_targets: [],
        masked_device_overrides: [],
      }),
    );
    await next;
    expect(studio.state.getState().validation).toBeNull();
  });
  it("import_export_preserves_yaml_and_reports_unsupported", async () => {
    const { api, studio } = await studioFixture();
    const raw =
      "# exact invalid imported text\nwidget: old\nunsupported: true\n";
    vi.spyOn(api, "import").mockResolvedValue(
      envelope({
        draft: null,
        diagnostics: [
          {
            code: "unsupported",
            message: "Unsupported field",
            path: "unsupported",
            line: 3,
            column: 1,
          },
        ],
      }),
    );
    await studio.importYaml(raw, "widgets");
    expect(studio.state.getState().draft.widgets_yaml).toBe(raw);
    expect(studio.exportText("widgets")).toBe(raw);
    expect(studio.state.getState().diagnostics[0].code).toBe("unsupported");
  });
  it("reset_and_disk_failure_keep_effective_widget", async () => {
    const { api, studio } = await studioFixture();
    studio.edit({ widgets_yaml: "dirty exact text" });
    vi.spyOn(api, "reset").mockRejectedValue(new Error("disk unavailable"));
    await studio.reset({ widget: "cpu" });
    expect(studio.state.getState().draft.widgets_yaml).toBe("dirty exact text");
    expect(studio.state.getState().catalog.effective.revision).toBe(
      "effective",
    );
    expect(studio.state.getState().error).toBe("disk unavailable");
  });
  it("keeps exact unsupported input when native import returns its blocking sentinel draft", async () => {
    const { api, studio } = await studioFixture();
    const text = "# unchanged imported text\nwidget: upstream\n";
    vi.spyOn(api, "import").mockResolvedValue(
      envelope({
        draft: {
          ...catalogFixture().own,
          widgets_yaml: `${text}\n__unsupported_upstream_import__: true\n`,
        },
        diagnostics: [
          {
            code: "import_unsupported",
            message: "Unsupported behavior",
            path: "view",
            line: 2,
            column: 1,
          },
        ],
      }),
    );
    await studio.importYaml(text, "widgets");
    expect(studio.exportText("widgets")).toBe(text);
    expect(studio.state.getState().diagnostics[0].code).toBe(
      "import_unsupported",
    );
  });
  it("ignores a late file read after any draft edit and preserves draft on write failure", async () => {
    const { studio } = await studioFixture(),
      read = deferred<string | null>();
    const files = {
      read: () => read.promise,
      write: async () => {
        throw new Error("disk read-only");
      },
    };
    const pending = studio.importFile(files, "widgets");
    studio.edit({ widgets_yaml: "new exact dirty YAML" });
    read.resolve("old file text");
    await pending;
    expect(studio.exportText("widgets")).toBe("new exact dirty YAML");
    await studio.exportFile(files, "widgets", "widgets.yaml");
    expect(studio.state.getState().error).toBe("disk read-only");
    expect(studio.exportText("widgets")).toBe("new exact dirty YAML");
  });
  it("template Test binds the retained capture and exact candidate template hash without acquisition", async () => {
    const { api, studio } = await studioFixture();
    const original = globalThis.crypto;
    vi.stubGlobal("crypto", webcrypto);
    const test = vi
      .spyOn(api, "testTemplate")
      .mockImplementation(async (_id, captureId, template) =>
        envelope({
          capture_id: captureId,
          parser_id: template.id,
          template_sha256: template.sha256,
          rows: [],
        }),
      );
    await studio.testTemplate("retained-capture", {
      id: "custom",
      platform: "iosxe",
      command: "show version",
      text: "Value VALUE (.*)\n\nStart\n ^${VALUE} -> Record\n",
      sha256: "old-hash",
    });
    expect(test.mock.calls[0][1]).toBe("retained-capture");
    expect(test.mock.calls[0][2].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(studio.state.getState().templateResult?.capture_id).toBe(
      "retained-capture",
    );
    expect(api.captureSample).not.toHaveBeenCalled();
    vi.stubGlobal("crypto", original);
  });
  it("native v1 export imports verbatim through native validation instead of the upstream translator", async () => {
    const { api, studio } = await studioFixture(),
      imported = vi.spyOn(api, "import");
    const text = "# native exact comments\nschema_version: 1\nwidgets: []\n";
    await studio.importYaml(text, "widgets");
    expect(studio.exportText("widgets")).toBe(text);
    expect(imported).not.toHaveBeenCalled();
    expect(api.validate).toHaveBeenCalledOnce();
    expect(studio.state.getState().validation).toBeNull();
    expect(studio.state.getState().diagnostics).toEqual([]);
    expect(api.captureSample).not.toHaveBeenCalled();
  });
});
