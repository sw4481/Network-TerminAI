import { expect, it } from "vitest";
import {
  DashboardReader,
  compatibleDefinition,
  processorPool,
  repeatedTotal,
  interfaceMember,
} from "./dashboard";
import { definition, page, row, snapshot } from "./dashboard.test-support";
import { TelemetryWorkspaceStore } from "./store";
import type { TelemetryApi } from "./api";
it("accepts presentation overrides but refuses changed semantic sources and inconsistent device totals", () => {
  const d = definition();
  const config = {
    widgets: [d],
    layouts: [],
    templates: {
      cpu: {
        id: "cpu",
        platform: "iosxe" as const,
        command: "show processes cpu",
        text: "x",
        sha256: "hash",
      },
    },
  };
  expect(
    compatibleDefinition(
      { ...d, title: "Renamed CPU" },
      d,
      config.templates,
      config.templates,
    ),
  ).toBe(true);
  expect(
    compatibleDefinition(
      { ...d, fields: { cpu_5s_percent: ["other"] } },
      d,
      config.templates,
      config.templates,
    ),
  ).toBe(false);
  expect(
    compatibleDefinition(
      d,
      d,
      {
        ...config.templates,
        cpu: { ...config.templates.cpu, sha256: "changed" },
      },
      config.templates,
    ),
  ).toBe(false);
  expect(
    repeatedTotal(
      [row("1", { cpu_5s_percent: 4 }), row("2", { cpu_5s_percent: 4 })],
      "cpu_5s_percent",
    ),
  ).toBe(4);
  expect(
    repeatedTotal(
      [row("1", { cpu_5s_percent: 4 }), row("2", { cpu_5s_percent: 5 })],
      "cpu_5s_percent",
    ),
  ).toBe(null);
  expect(processorPool([row("pool", { used_bytes: 20, total_bytes: 0 })])).toBe(
    null,
  );
  expect(
    processorPool([row("pool", { used_bytes: 20, total_bytes: 100 })]),
  ).toBe(20);
});
it("filters MAC interface lists by exact member without substring or remote-port joins", () => {
  expect(
    interfaceMember({ kind: "text", value: '["Gi0/1", "Gi0/2"]' }, "Gi0/1"),
  ).toBe(true);
  expect(interfaceMember({ kind: "text", value: '["Gi0/10"]' }, "Gi0/1")).toBe(
    false,
  );
  expect(interfaceMember({ kind: "text", value: "Gi0/1" }, "Gi0/1")).toBe(
    false,
  );
});
it("reads every page including selections after page1 and rejects mixed observations", async () => {
  const snap = snapshot();
  const p = page("cpu", [row("one", { interface: "Gi0/1" })]);
  p.next_offset = 1;
  p.metadata.row_count = 2;
  snap.widgets = [p.metadata];
  let mixed = false;
  const api = {
    establish: async () => snap,
    close: async () => {},
    catalog: async () => ({
      workspace_id: "test",
      generation: 1,
      sequence: 1,
      revision: "global",
      value: {
        effective: {
          revision: "source",
          widgets: [],
          layouts: [],
          templates: {},
        },
      },
    }),
    widget: async (q: { offset: number }) => ({
      workspace_id: "test",
      generation: 1,
      sequence: 1,
      revision: "source",
      value: q.offset
        ? {
            ...p,
            metadata: {
              ...p.metadata,
              observed_at_ms: p.metadata.observed_at_ms + (mixed ? 1 : 0),
            },
            rows: [row("two", { interface: "Gi0/2" })],
            next_offset: null,
          }
        : p,
    }),
  } as unknown as TelemetryApi;
  const owner = new TelemetryWorkspaceStore(api, () => () => {});
  await owner.establish("test");
  const reader = new DashboardReader(api, owner);
  expect(
    (await reader.widget("test", "device-0", "cpu", "source")).rows,
  ).toHaveLength(2);
  mixed = true;
  await expect(
    reader.widget("test", "device-0", "cpu", "source"),
  ).rejects.toThrow(/changed/);
  await owner.close("test");
});
