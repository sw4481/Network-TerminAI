import { describe, it, expect } from "vitest";

import {
  lintExpressionSyntax,
  validatePlaybookYaml,
} from "./playbook-validate";

describe("lintExpressionSyntax (JMESPath vs JSONPath guard)", () => {
  it("flags a leading JSONPath root '$.'", () => {
    expect(lintExpressionSyntax("$.session_state")).toMatch(/JSONPath/);
  });

  it("flags a JSONPath filter '[?(...)]'", () => {
    expect(lintExpressionSyntax("$.interfaces[?(@.auth_failures>0)]")).toMatch(
      /JSONPath/,
    );
  });

  it("flags a filter with parens even without a leading '$'", () => {
    expect(lintExpressionSyntax("interfaces[?(@.x>0)]")).toMatch(/\[\?\(/);
  });

  it("flags JSONPath recursive descent '..'", () => {
    expect(lintExpressionSyntax("interfaces..reason")).toMatch(/recursive/);
  });

  it("flags JSONPath current-node access '@.'", () => {
    expect(lintExpressionSyntax("interfaces[?@.x > `0`] @.reason")).toBeTruthy();
  });

  it("accepts a plain JMESPath field path", () => {
    expect(lintExpressionSyntax("session_state")).toBeNull();
    expect(lintExpressionSyntax("errdisable.reason")).toBeNull();
  });

  it("accepts a valid JMESPath filter (no parens, no @.)", () => {
    expect(lintExpressionSyntax("interfaces[?auth_failures > `0`]")).toBeNull();
  });
});

describe("validatePlaybookYaml surfaces the JMESPath guard", () => {
  const withExpr = (type: string, exprLine: string) => `id: pb
name: PB
description: d
vendor: cisco
platform: iosxe
symptom_keywords:
  - k
steps:
  - id: get
    type: command
    command: show foo
  - id: check
    type: ${type}
    ${exprLine}
  - id: done
    type: narration
    text: ok
`;

  it("errors on a JSONPath assertion expression", () => {
    const yaml = withExpr(
      "assertion",
      'expression: "$.interfaces[?(@.auth_failures>0)]"\n    expects: "non-empty"\n    on_pass: done\n    on_fail: done',
    );
    const { diagnostics } = validatePlaybookYaml(yaml);
    expect(
      diagnostics.some(
        (d) => d.severity === "error" && /JSONPath/.test(d.message),
      ),
    ).toBe(true);
  });

  it("errors on a JSONPath branch expression", () => {
    const yaml = withExpr(
      "branch",
      'expression: "$.session_state"\n    cases:\n      - when: "Authenticated"\n        next: done',
    );
    const { diagnostics } = validatePlaybookYaml(yaml);
    expect(
      diagnostics.some(
        (d) => d.severity === "error" && /JSONPath/.test(d.message),
      ),
    ).toBe(true);
  });

  it("does not error on a valid JMESPath branch expression", () => {
    const yaml = withExpr(
      "branch",
      'expression: "errdisable.reason"\n    cases:\n      - when: "bpduguard"\n        next: done',
    );
    const { diagnostics } = validatePlaybookYaml(yaml);
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });
});
