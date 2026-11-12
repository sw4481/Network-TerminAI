import { invoke } from "@tauri-apps/api/core";
import type {
  ApplyResult,
  AuthoringCatalog,
  Capture,
  CaptureSampleRequest,
  ConfigDraft,
  ConfigScope,
  ImportReport,
  ParsedInterpretation,
  PreviewReport,
  PreviewToken,
  ResetAsset,
  SeriesPage,
  SeriesQuery,
  StartRequest,
  TargetRef,
  TelemetryRead,
  TelemetrySnapshot,
  TemplateAsset,
  ValidationReport,
  WidgetPage,
  WidgetQuery,
} from "./types";

export class TelemetryApi {
  establish(workspaceId: string): Promise<TelemetrySnapshot> {
    return invoke("telemetry_establish", { workspaceId });
  }
  start(request: StartRequest): Promise<TelemetrySnapshot> {
    return invoke("telemetry_start", { request });
  }
  stop(workspaceId: string): Promise<void> {
    return invoke("telemetry_stop", { workspaceId });
  }
  close(workspaceId: string): Promise<void> {
    return invoke("telemetry_close", { workspaceId });
  }
  snapshot(workspaceId: string): Promise<TelemetrySnapshot> {
    return invoke("telemetry_snapshot", { workspaceId });
  }
  select(workspaceId: string, target: TargetRef): Promise<TelemetrySnapshot> {
    return invoke("telemetry_select", { workspaceId, target });
  }
  catalog(
    workspaceId: string,
    scope: ConfigScope,
  ): Promise<TelemetryRead<AuthoringCatalog>> {
    return invoke("telemetry_catalog", { workspaceId, scope });
  }
  validate(
    workspaceId: string,
    draft: ConfigDraft,
  ): Promise<TelemetryRead<ValidationReport>> {
    return invoke("telemetry_validate", { workspaceId, draft });
  }
  preview(
    workspaceId: string,
    draft: ConfigDraft,
  ): Promise<TelemetryRead<PreviewReport>> {
    return invoke("telemetry_preview", { workspaceId, draft });
  }
  apply(
    workspaceId: string,
    draft: ConfigDraft,
    token: PreviewToken,
  ): Promise<TelemetryRead<ApplyResult>> {
    return invoke("telemetry_apply", { workspaceId, draft, token });
  }
  series(query: SeriesQuery): Promise<TelemetryRead<SeriesPage>> {
    return invoke("telemetry_series", { query });
  }
  widget(query: WidgetQuery): Promise<TelemetryRead<WidgetPage>> {
    return invoke("telemetry_widget", { query });
  }
  captureSample(
    workspaceId: string,
    request: CaptureSampleRequest,
  ): Promise<TelemetryRead<Capture>> {
    return invoke("telemetry_capture_sample", { workspaceId, request });
  }
  testTemplate(
    workspaceId: string,
    captureId: string,
    template: TemplateAsset,
  ): Promise<TelemetryRead<ParsedInterpretation>> {
    return invoke("telemetry_test_template", {
      workspaceId,
      captureId,
      template,
    });
  }
  import(
    workspaceId: string,
    scope: ConfigScope,
    yaml: string,
  ): Promise<TelemetryRead<ImportReport>> {
    return invoke("telemetry_import", { workspaceId, scope, yaml });
  }
  reset(
    workspaceId: string,
    scope: ConfigScope,
    asset: ResetAsset,
  ): Promise<TelemetryRead<ConfigDraft>> {
    return invoke("telemetry_reset", { workspaceId, scope, asset });
  }
}
export const telemetryApi = new TelemetryApi();
