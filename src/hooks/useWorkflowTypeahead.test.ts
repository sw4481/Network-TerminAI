import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWorkflowTypeahead } from "./useWorkflowTypeahead";

describe("useWorkflowTypeahead", () => {
  it("renders template with current values, leaving unfilled placeholders as {{name}}", () => {
    const { result, rerender } = renderHook(
      ({ values }: { values: Record<string, string> }) =>
        useWorkflowTypeahead({
          template: "show interface {{ intf }} counters",
          values,
        }),
      { initialProps: { values: {} } },
    );
    expect(result.current.rendered).toBe("show interface {{intf}} counters");
    expect(result.current.unfilled).toEqual(["intf"]);
    rerender({ values: { intf: "Gi0/0" } });
    expect(result.current.rendered).toBe("show interface Gi0/0 counters");
    expect(result.current.unfilled).toEqual([]);
  });

  it("reports caret position after the last filled placeholder", () => {
    const { result } = renderHook(() =>
      useWorkflowTypeahead({
        template: "show ip route {{ vrf }} {{ prefix }}",
        values: { vrf: "MGMT" },
      }),
    );
    expect(result.current.caret).toBe("show ip route MGMT".length);
    expect(result.current.unfilled).toEqual(["prefix"]);
  });

  it("caret is at end of rendered string when all placeholders filled", () => {
    const { result } = renderHook(() =>
      useWorkflowTypeahead({
        template: "ping {{ host }}",
        values: { host: "1.1.1.1" },
      }),
    );
    expect(result.current.rendered).toBe("ping 1.1.1.1");
    expect(result.current.caret).toBe("ping 1.1.1.1".length);
  });

  it("handles repeated placeholder", () => {
    const { result } = renderHook(() =>
      useWorkflowTypeahead({
        template: "ping {{h}} && tracert {{ h }}",
        values: { h: "host1" },
      }),
    );
    expect(result.current.rendered).toBe("ping host1 && tracert host1");
  });

  it("template with no placeholders is identity", () => {
    const { result } = renderHook(() =>
      useWorkflowTypeahead({
        template: "show version",
        values: {},
      }),
    );
    expect(result.current.rendered).toBe("show version");
    expect(result.current.unfilled).toEqual([]);
    expect(result.current.caret).toBe("show version".length);
  });
});
