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
  mode: "fleet" | "detail",
  sectionId?: string,
  selectedKey?: string,
  historyRows: Record<string, string> = {},
) {
  const reader = useMemo(() => new DashboardReader(api), [api]);
  const lifecycle = useTelemetryStore(workspaceId);
  const busy = !!lifecycle?.busy,
    closing = !!lifecycle?.closing;
  const cache = useRef(new Map<string, EffectiveConfig>());
  const [catalog, setCatalog] = useState<{
    key: string;
    value: AuthoringCatalog;
  } | null>(null);
  const [loaded, setLoaded] = useState<{
    key: string;
    widgets: LoadedWidget[];
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
        if (active)
          setLoaded({
            key: scope,
            widgets: [],
            series: [],
            errors: [String(e.message ?? e)],
          });
      });
    return () => {
      active = false;
    };
  }, [reader, workspaceId, targetId, scope, mode, busy, closing]);
  const key = `${scope}:${current?.effective.revision ?? ""}:${observation}:${sectionId ?? ""}:${selectedKey ?? ""}:${JSON.stringify(historyRows)}`;
  useEffect(() => {
    let active = true;
    if (!current) return;
    const definitions = current.effective.widgets;
    const sections = current.effective.layouts.flatMap((l) => l.sections);
    const section = sections.find((s) => s.id === sectionId) ?? sections[0];
    const ids =
      mode === "fleet"
        ? [
            "cpu",
            "memory",
            "port_status",
            "interfaces",
            "bgp_peers",
            "bgp_vrf_peers",
            "ospf_neighbors",
            "eigrp_neighbors",
          ]
            .map((id) => semanticWidget(current, id)?.widget)
            .filter((id): id is string => !!id)
        : section
          ? section.rows.flatMap((r) => r.map((e) => e.widget))
          : definitions.map((d) => d.widget);
    if (mode === "detail" && selectedKey) {
      const source =
        semanticWidget(current, "interfaces") ??
        semanticWidget(current, "port_status");
      if (source && !ids.includes(source.widget)) ids.push(source.widget);
    }
    void (async () => {
      const widgets: LoadedWidget[] = [],
        series: LoadedSeries[] = [],
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
            if (
              mode === "detail" &&
              summary.revision === current.effective.revision
            ) {
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
                snapshot.series
                  .filter(
                    (s) =>
                      s.target_id === targetId &&
                      s.widget_id === id &&
                      definition.history?.fields.includes(s.field) &&
                      s.row_key === chosen?.key,
                  )
                  .map(async (summary) => {
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
                  }),
              );
            }
          } catch (e) {
            errors.push(
              `${definition.title}: ${String((e as Error).message ?? e)}`,
            );
          }
        }),
      );
      if (active) setLoaded({ key, widgets, series, errors });
    })();
    return () => {
      active = false;
    };
    // The observation key includes every retained identity; a newer snapshot cancels the whole read set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, key, current]);
  const visible = loaded?.key === key ? loaded : null;
  return {
    catalog: current,
    widgets: visible?.widgets ?? [],
    series: visible?.series ?? [],
    errors: visible?.errors ?? (loaded?.key === scope ? loaded.errors : []),
    loading: !visible,
  };
}
