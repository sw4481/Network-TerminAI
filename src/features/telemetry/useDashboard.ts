import { useEffect, useMemo, useRef, useState } from "react";
import type { TelemetryApi } from "./api";
import { DashboardReader, semanticWidget } from "./dashboard";
import { useTelemetryStore } from "./store";
import type {
  AuthoringCatalog,
  EffectiveConfig,
  SeriesPage,
  SeriesSummary,
  TelemetrySnapshot,
  WidgetDefinition,
  WidgetPage,
} from "./types";

export interface DashboardProps {
  snapshot: TelemetrySnapshot;
  api: TelemetryApi;
  workspaceId: string;
}
export interface LoadedWidget {
  definition: WidgetDefinition;
  page: WidgetPage;
  previousSource: boolean;
}
export interface LoadedSeries {
  summary: SeriesSummary;
  series: SeriesPage;
  unit: string;
}
export function useDashboard(
  { snapshot, api, workspaceId }: DashboardProps,
  targetId: string,
  mode: "fleet" | "detail" | "traffic" | "local-summary",
  sectionId?: string,
  selectedKey?: string,
  historyRows: Record<string, string> = {},
) {
  const reader = useMemo(() => new DashboardReader(api), [api]);
  const lifecycle = useTelemetryStore(workspaceId);
  const busy = !!lifecycle?.busy,
    closing = !!lifecycle?.closing;
  const cache = useRef(new Map<string, EffectiveConfig>());
  const [catalogFailure, setCatalogFailure] = useState<{ key: string; error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [catalog, setCatalog] = useState<{
    key: string;
    value: AuthoringCatalog;
  } | null>(null);
  const [loaded, setLoaded] = useState<{
    key: string;
    scope: string;
    widgets: LoadedWidget[];
    errors: string[];
  } | null>(null);
  const [histories, setHistories] = useState<{
    key: string;
    tableKey: string;
    scope: string;
    series: LoadedSeries[];
    errors: string[];
  } | null>(null);
  const scope = `${workspaceId}:${targetId}:${snapshot.generation}`;
  const current = catalog?.key === scope ? catalog.value : null;
  const summaries = snapshot.widgets.filter((w) => w.target_id === targetId);
  const observation = JSON.stringify(
    summaries.map((w) => [
      w.widget_id,
      w.revision,
      w.generation,
      w.observed_at_ms,
      w.state,
    ]),
  );
  useEffect(() => {
    let active = true;
    setCatalog(null);
    setCatalogFailure(null);
    if (!targetId || busy || closing) return;
    void reader
      .catalog(
        workspaceId,
        targetId,
        `dashboard:${mode}:catalog:${mode === "fleet" ? targetId : "selection"}`,
      )
      .then((r) => {
        if (active) {
          cache.current.set(r.value.effective.revision, r.value.effective);
          setCatalog({ key: scope, value: r.value });
        }
      })
      .catch((e) => {
        if (active) setCatalogFailure({ key: scope, error: String(e.message ?? e) });
      });
    return () => {
      active = false;
    };
  }, [reader, workspaceId, targetId, scope, mode, busy, closing, attempt]);
  const definitions = current?.effective.widgets ?? [];
  const sections = current?.effective.layouts.flatMap((l) => l.sections) ?? [];
  const section = sections.find((s) => s.id === sectionId) ?? sections[0];
  const semanticIds = (ids: string[]) =>
    ids
      .map((id) => current && semanticWidget(current, id)?.widget)
      .filter((id): id is string => !!id);
  const interfaceIds = current
    ? [
        (
          semanticWidget(current, "interfaces") ??
          semanticWidget(current, "port_status")
        )?.widget,
        semanticWidget(current, "interface_traffic")?.widget,
      ].filter((id): id is string => !!id)
    : [];
  const ids =
    mode === "fleet"
      ? semanticIds([
          "cpu",
          "memory",
          "port_status",
          "interfaces",
          "bgp_peers",
          "bgp_vrf_peers",
          "ospf_neighbors",
          "eigrp_neighbors",
        ])
      : mode === "traffic"
        ? interfaceIds
        : mode === "local-summary"
          ? semanticIds(["local_cpu", "local_memory"])
          : section
            ? section.rows.flatMap((r) => r.map((e) => e.widget))
            : definitions.map((d) => d.widget);
  if (mode === "detail" && (selectedKey || section?.id === "overview"))
    ids.push(...interfaceIds);
  const tableScope = `${scope}:${current?.effective.revision ?? ""}:${JSON.stringify([...new Set(ids)])}`;
  const key = `${tableScope}:${observation}`;
  useEffect(() => {
    let active = true;
    if (!current) return;
    void (async () => {
      const widgets: LoadedWidget[] = [],
        errors: string[] = [];
      await Promise.all(
        [...new Set(ids)].map(async (id) => {
          const summary = summaries.find((w) => w.widget_id === id);
          if (!summary) return;
          const config = cache.current.get(summary.revision);
          const definition = config?.widgets.find((d) => d.widget === id);
          if (!definition) {
            errors.push(
              `${definitions.find((d) => d.widget === id)?.title ?? "Widget"}: previous source unavailable; waiting for a compatible observation.`,
            );
            return;
          }
          try {
            const page = await reader.widget(
              workspaceId,
              targetId,
              id,
              current.effective.revision,
            );
            widgets.push({
              definition,
              page,
              previousSource: summary.revision !== current.effective.revision,
            });
          } catch (e) {
            errors.push(
              `${definition.title}: ${String((e as Error).message ?? e)}`,
            );
          }
        }),
      );
      if (active) setLoaded({ key, scope: tableScope, widgets, errors });
    })();
    return () => {
      active = false;
    };
    // Every retained table identity and requested definition is part of key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, key, current]);
  const visible = loaded?.key === key ? loaded : null;
  const seriesSummaries = snapshot.series.filter(
    (s) => s.target_id === targetId && ids.includes(s.widget_id),
  );
  const historyKey = `${key}:${JSON.stringify(seriesSummaries)}:${selectedKey ?? ""}:${JSON.stringify(historyRows)}`;
  const historyScope = `${tableScope}:${selectedKey ?? ""}:${JSON.stringify(historyRows)}`;
  useEffect(() => {
    let active = true;
    if (!current || !visible) return;
    void (async () => {
      const series: LoadedSeries[] = [],
        errors: string[] = [];
      if (mode === "detail" || mode === "traffic")
        await Promise.all(
          visible.widgets
            .filter((w) => !w.previousSource)
            .map(async ({ definition, page }) => {
              const id = definition.widget;
              const candidates =
                selectedKey && definition.fields.interface
                  ? page.rows.filter(
                      (r) =>
                        r.fields.interface?.kind === "text" &&
                        r.fields.interface.value === selectedKey,
                    )
                  : page.rows;
              const chosen = historyRows[id]
                ? page.rows.find((r) => r.key === historyRows[id])
                : selectedKey && definition.fields.interface
                  ? candidates.length === 1
                    ? candidates[0]
                    : undefined
                  : (candidates.find(
                      (r) =>
                        r.fields.core?.kind === "text" &&
                        r.fields.core.value === "total",
                    ) ?? candidates[0]);
              await Promise.all(
                seriesSummaries
                  .filter(
                    (s) =>
                      definition.history?.fields.includes(s.field) &&
                      s.widget_id === id &&
                      s.row_key === chosen?.key,
                  )
                  .map(async (summary) => {
                    try {
                      const retained =
                        histories?.tableKey === key &&
                        histories.series.find(
                          (s) =>
                            JSON.stringify(s.summary) ===
                            JSON.stringify(summary),
                        );
                      if (retained) {
                        series.push(retained);
                        return;
                      }
                      const view = definition.view;
                      const fields =
                        view.type === "chart"
                          ? view.series
                          : view.type === "table" || view.type === "kv"
                            ? view.columns
                            : [];
                      const unit =
                        summary.unit ??
                        definition.rates?.[summary.field]?.unit ??
                        definition.deltas?.[summary.field]?.unit ??
                        fields.find((f) => f.field === summary.field)?.unit ??
                        "";
                      series.push({
                        summary,
                        unit,
                        series: await reader.series(
                          workspaceId,
                          summary,
                          current.effective.revision,
                        ),
                      });
                    } catch (e) {
                      errors.push(
                        `${definition.title}: ${String((e as Error).message ?? e)}`,
                      );
                    }
                  }),
              );
            }),
        );
      if (active)
        setHistories({
          key: historyKey,
          tableKey: key,
          scope: historyScope,
          series,
          errors,
        });
    })();
    return () => {
      active = false;
    };
    // Native series availability can expire independently of the retained latest table.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, current, visible, historyKey]);
  const currentHistories = histories?.key === historyKey ? histories : null;
  // Retain the same panels during refresh so their height, scroll and filters survive.
  const displayedWidgets =
    visible?.widgets ??
    (loaded?.scope === tableScope
      ? loaded.widgets
          .filter((w) =>
            summaries.some(
              (s) =>
                s.widget_id === w.page.metadata.widget_id &&
                s.revision === w.page.metadata.revision &&
                s.generation === w.page.metadata.generation,
            ),
          )
          .map((w) => ({
            ...w,
            page: {
              ...w.page,
              metadata: {
                ...w.page.metadata,
                state:
                  w.page.metadata.state === "fresh"
                    ? ("stale" as const)
                    : w.page.metadata.state,
              },
            },
          }))
      : []);
  const displayedSeries =
    currentHistories?.series ??
    (histories?.scope === historyScope
      ? histories.series.filter(
          (s) =>
            seriesSummaries.some(
              (current) =>
                current.widget_id === s.summary.widget_id &&
                current.row_key === s.summary.row_key &&
                current.field === s.summary.field &&
                current.unit === s.summary.unit &&
                current.point_count >= s.summary.point_count,
            ) &&
            displayedWidgets.some(
              (w) =>
                w.definition.widget === s.summary.widget_id &&
                !w.previousSource &&
                w.page.rows.some((r) => r.key === s.summary.row_key),
            ),
        )
      : []);
  const catalogError = catalogFailure?.key === scope ? catalogFailure.error : null;
  return {
    catalog: current,
    widgets: displayedWidgets,
    series: displayedSeries,
    errors: [
      ...(catalogError ? [catalogError] : []),
      ...(visible?.errors ?? (loaded?.key === scope ? loaded.errors : [])),
      ...(currentHistories?.errors ?? []),
    ],
    loading: !catalogError && (!visible || !currentHistories),
    catalogError,
    reload: () => setAttempt((previous) => previous + 1),
  };
}
