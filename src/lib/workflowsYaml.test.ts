import { describe, it, expect } from "vitest";
import { workflowToYaml, yamlToWorkflow } from "./workflowsYaml";
import type { Workflow } from "./workflows";

const wf: Workflow = {
  id: "x-1",
  name: "Test",
  description: "d",
  vendor: "cisco",
  platform: "iosxe",
  tags: ["t"],
  created_at: 0,
  updated_at: 0,
  steps: [{ idx: 0, command_template: "show ver" }],
  params: [
    {
      name: "n",
      type: "string",
      default_value: null,
      required: true,
      description: "",
      enum_values: null,
    },
  ],
};

describe("workflowsYaml", () => {
  it("round-trips a workflow", () => {
    const yamlStr = workflowToYaml(wf);
    const back = yamlToWorkflow(yamlStr);
    expect(back.name).toBe("Test");
    expect(back.steps).toEqual(wf.steps);
    expect(back.params).toEqual(wf.params);
    expect(back.vendor).toBe("cisco");
    expect(back.tags).toEqual(["t"]);
  });

  it("rejects unknown vendor", () => {
    const bad = workflowToYaml({ ...wf, vendor: "cisco" }).replace(
      "cisco",
      "acme",
    );
    expect(() => yamlToWorkflow(bad)).toThrow(/vendor/);
  });

  it("rejects unknown param type", () => {
    const bad = workflowToYaml(wf).replace("type: string", "type: regex");
    expect(() => yamlToWorkflow(bad)).toThrow(/type/);
  });

  it("rejects unknown schema version", () => {
    const bad = workflowToYaml(wf).replace(
      "schema: ccie-workflow/v1",
      "schema: ccie-workflow/v2",
    );
    expect(() => yamlToWorkflow(bad)).toThrow(/schema/);
  });

  it("rejects non-mapping YAML", () => {
    expect(() => yamlToWorkflow("- 1\n- 2\n")).toThrow();
  });

  it("rejects step with empty command_template", () => {
    const bad = `schema: ccie-workflow/v1
name: T
description: ""
vendor: cisco
platform: iosxe
tags: []
params: []
steps:
  - idx: 0
    command_template: ""
`;
    expect(() => yamlToWorkflow(bad)).toThrow(/command_template/);
  });

  it("preserves enum_values", () => {
    const enumWf: Workflow = {
      ...wf,
      params: [
        {
          name: "level",
          type: "enum",
          default_value: "info",
          required: true,
          description: "Log level",
          enum_values: ["info", "warn", "error"],
        },
      ],
    };
    const back = yamlToWorkflow(workflowToYaml(enumWf));
    expect(back.params[0].enum_values).toEqual(["info", "warn", "error"]);
  });
});
