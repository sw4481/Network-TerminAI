import { describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import { YamlSchemaRegistry } from "./yamlSchemaRegistry";

describe("scoped YAML schemas", () => {
  it.each([false, true])(
    "playbook_and_widget_schemas_are_isolated_in_both_mount_orders (%s)",
    async (widgetFirst) => {
      const update = vi.fn().mockResolvedValue(undefined),
        dispose = vi.fn();
      const configure = vi.fn(() => ({ update, dispose }));
      const registry = new YamlSchemaRegistry(configure);
      const clear = vi.fn();
      const monaco = {
        Uri: { parse: (v: string) => v },
        editor: { getModel: vi.fn(() => ({})), setModelMarkers: clear },
      } as unknown as typeof Monaco;
      const entries = [
        ["inmemory://playbook/one.yaml", { title: "Playbook" }],
        ["inmemory://telemetry/one.yaml", { title: "Widget" }],
      ] as const;
      const order = widgetFirst ? [...entries].reverse() : entries;
      const first = registry.acquire(monaco, order[0][0], order[0][1]);
      const second = registry.acquire(monaco, order[1][0], order[1][1]);
      await registry.settled();
      expect(configure).toHaveBeenCalledOnce();
      const schemas = update.mock.calls.at(-1)![0].schemas;
      expect(
        schemas.map((s: { fileMatch: string[] }) => s.fileMatch[0]).sort(),
      ).toEqual(entries.map(([uri]) => uri).sort());
      expect(
        schemas.every(
          (s: { fileMatch: string[] }) =>
            s.fileMatch.length === 1 && !s.fileMatch[0].includes("*"),
        ),
      ).toBe(true);
      first.release();
      await registry.settled();
      expect(dispose).not.toHaveBeenCalled();
      expect(update.mock.calls.at(-1)![0].schemas).toHaveLength(1);
      second.release();
      await registry.settled();
      expect(dispose).toHaveBeenCalledOnce();
      expect(clear).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps an exact URI registered until its last owner releases", async () => {
    const dispose = vi.fn(),
      update = vi.fn().mockResolvedValue(undefined);
    const registry = new YamlSchemaRegistry(() => ({ update, dispose }));
    const monaco = {
      Uri: { parse: (v: string) => v },
      editor: { getModel: () => null },
    } as unknown as typeof Monaco;
    const a = registry.acquire(monaco, "inmemory://telemetry/a.yaml", {});
    const b = registry.acquire(monaco, "inmemory://telemetry/a.yaml", {});
    a.release();
    a.release();
    await registry.settled();
    expect(dispose).not.toHaveBeenCalled();
    b.release();
    await registry.settled();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("reuses the service when a StrictMode remount races queued final disposal", async () => {
    const dispose = vi.fn(),
      update = vi.fn().mockResolvedValue(undefined),
      configure = vi.fn(() => ({ update, dispose }));
    const registry = new YamlSchemaRegistry(configure),
      monaco = {
        Uri: { parse: (v: string) => v },
        editor: { getModel: () => null },
      } as unknown as typeof Monaco;
    const first = registry.acquire(
      monaco,
      "inmemory://telemetry/remount.yaml",
      {},
    );
    first.release();
    const second = registry.acquire(
      monaco,
      "inmemory://telemetry/remount.yaml",
      { title: "Updated" },
    );
    await registry.settled();
    expect(configure).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    expect(update.mock.calls.at(-1)![0].schemas[0].schema.title).toBe(
      "Updated",
    );
    second.release();
    await registry.settled();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
