import { describe, it, expect } from "vitest";
import { computePipelineAnchors, toCoachSteps } from "./coachMarkAnchors";

const GITHUB_TF = `# Terraform CI pipeline
name: Terraform
on:
  pull_request:
  push:
    branches: [main]

jobs:
  terraform-plan:
    runs-on: ubuntu-latest
    steps:
      - run: terraform plan
  terraform-apply:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: terraform apply -auto-approve
`;

const GITHUB_PLAN_ONLY = `name: Terraform
on:
  pull_request:

jobs:
  terraform-plan:
    runs-on: ubuntu-latest
    steps:
      - run: terraform plan
`;

const GITLAB_TF = `stages:
  - plan
  - apply

terraform-plan:
  stage: plan
  rules:
    - if: $CI_MERGE_REQUEST_ID
  script:
    - terraform plan

terraform-apply:
  stage: apply
  script:
    - terraform apply -auto-approve
`;

describe("computePipelineAnchors", () => {
  it("finds triggers, plan and apply in a GitHub Actions Terraform pipeline", () => {
    const anchors = computePipelineAnchors(GITHUB_TF, "github");
    const sections = anchors.map((a) => a.section);
    expect(sections).toEqual(["triggers", "plan", "apply"]);

    const triggers = anchors.find((a) => a.section === "triggers")!;
    expect(triggers.startLine).toBe(3); // the `on:` line (1-based)
    expect(triggers.endLine).toBeGreaterThan(triggers.startLine); // spans the block

    const plan = anchors.find((a) => a.section === "plan")!;
    const apply = anchors.find((a) => a.section === "apply")!;
    expect(plan.startLine).toBeLessThan(apply.startLine);
  });

  it("omits the apply step for a plan-only pipeline", () => {
    const anchors = computePipelineAnchors(GITHUB_PLAN_ONLY, "github");
    const sections = anchors.map((a) => a.section);
    expect(sections).toContain("triggers");
    expect(sections).toContain("plan");
    expect(sections).not.toContain("apply");
  });

  it("finds sections in a GitLab CI pipeline", () => {
    const anchors = computePipelineAnchors(GITLAB_TF, "gitlab");
    const sections = anchors.map((a) => a.section);
    expect(sections).toContain("triggers");
    expect(sections).toContain("plan");
    expect(sections).toContain("apply");
  });

  it("returns anchors sorted by line number", () => {
    const anchors = computePipelineAnchors(GITHUB_TF, "github");
    const lines = anchors.map((a) => a.startLine);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });

  it("returns an empty array for empty or garbage input", () => {
    expect(computePipelineAnchors("", "github")).toEqual([]);
    expect(computePipelineAnchors("   \n  \n", "github")).toEqual([]);
    // No recognizable keys → no false anchors.
    expect(computePipelineAnchors("foo: bar\nbaz: qux\n", "github")).toEqual([]);
  });

  it("does not match keywords that only appear inside comments", () => {
    // 'apply' appears only in a comment; there's no real apply job.
    const yaml = `on:\n  pull_request:\njobs:\n  plan:\n    steps:\n      - run: terraform plan  # do not apply here\n`;
    const anchors = computePipelineAnchors(yaml, "github");
    expect(anchors.map((a) => a.section)).not.toContain("apply");
  });
});

const GITHUB_ANSIBLE = `name: Ansible
on:
  pull_request:
  push:
    branches: [main]

jobs:
  check:
    runs-on: self-hosted
    steps:
      - run: ansible-playbook site.yml --check
  deploy:
    runs-on: self-hosted
    steps:
      - run: ansible-playbook site.yml
`;

describe("computePipelineAnchors — Ansible pipelines", () => {
  it("treats --check as the plan step and a bare ansible-playbook as apply", () => {
    const anchors = computePipelineAnchors(GITHUB_ANSIBLE, "github");
    const sections = anchors.map((a) => a.section);
    expect(sections).toContain("triggers");
    expect(sections).toContain("plan");
    expect(sections).toContain("apply");
    const plan = anchors.find((a) => a.section === "plan")!;
    const apply = anchors.find((a) => a.section === "apply")!;
    // --check line comes before the bare run line
    expect(plan.startLine).toBeLessThan(apply.startLine);
  });
});

describe("toCoachSteps", () => {
  it("attaches title/body copy to each anchor", () => {
    const steps = toCoachSteps(computePipelineAnchors(GITHUB_TF, "github"));
    expect(steps).toHaveLength(3);
    for (const s of steps) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(0);
    }
    expect(steps[0].section).toBe("triggers");
    expect(steps[0].title).toMatch(/trigger/i);
  });
});
