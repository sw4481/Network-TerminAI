import yaml from "js-yaml";
import type { Workflow, ParamType, Vendor } from "./workflows";
import { DEVICE_VENDORS } from "./deviceProfiles";

const PARAM_TYPES: ParamType[] = [
  "string",
  "enum",
  "ip",
  "int",
  "interface",
];

const SCHEMA = "ccie-workflow/v1";

export function workflowToYaml(wf: Workflow): string {
  const doc = {
    schema: SCHEMA,
    id: wf.id || undefined,
    name: wf.name,
    description: wf.description,
    vendor: wf.vendor,
    platform: wf.platform,
    tags: wf.tags,
    params: wf.params.map((p) => ({
      name: p.name,
      type: p.type,
      default_value: p.default_value,
      required: p.required,
      description: p.description,
      enum_values: p.enum_values ?? undefined,
    })),
    steps: wf.steps.map((s) => ({
      idx: s.idx,
      command_template: s.command_template,
    })),
  };
  return yaml.dump(doc, { lineWidth: 120, noRefs: true });
}

export function yamlToWorkflow(src: string): Workflow {
  const doc = yaml.load(src) as Record<string, unknown> | undefined;
  if (!doc || typeof doc !== "object") {
    throw new Error("invalid YAML: expected a mapping");
  }
  if (doc.schema !== SCHEMA) {
    throw new Error(`unknown schema (expected ${SCHEMA})`);
  }
  const vendor = String(doc.vendor);
  if (!(DEVICE_VENDORS as readonly string[]).includes(vendor)) {
    throw new Error(`invalid vendor: ${vendor}`);
  }
  const rawSteps = (doc.steps as unknown[]) || [];
  const rawParams = (doc.params as unknown[]) || [];
  const params = rawParams.map((pu) => {
    const p = pu as Record<string, unknown>;
    const type = String(p.type);
    if (!PARAM_TYPES.includes(type as ParamType)) {
      throw new Error(`invalid param type: ${type}`);
    }
    return {
      name: String(p.name),
      type: type as ParamType,
      default_value:
        (p.default_value as string | null | undefined) ?? null,
      required: p.required === false ? false : true,
      description: String(p.description ?? ""),
      enum_values: (p.enum_values as string[] | undefined) ?? null,
    };
  });
  const steps = rawSteps.map((su, i) => {
    const s = su as Record<string, unknown>;
    const idx = Number(s.idx ?? i);
    const command_template = String(s.command_template);
    if (!command_template) {
      throw new Error(`step ${i}: empty command_template`);
    }
    return { idx, command_template };
  });
  return {
    id: String(doc.id ?? ""),
    name: String(doc.name ?? ""),
    description: String(doc.description ?? ""),
    vendor: vendor as Vendor,
    platform: String(doc.platform ?? ""),
    tags: (doc.tags as string[] | undefined) ?? [],
    steps,
    params,
    created_at: 0,
    updated_at: 0,
  };
}
