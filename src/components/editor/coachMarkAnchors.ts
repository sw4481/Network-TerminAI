/**
 * Pure line-anchor computation for pipeline coach-marks.
 *
 * Given the generated pipeline YAML, find the line ranges for the three
 * sections a beginner needs to understand — the trigger, the plan job, and the
 * apply job — so an overlay can spotlight them with plain-English callouts.
 *
 * Deliberately heuristic and forgiving: if a section can't be located we DROP
 * it rather than point at the wrong line. The "apply" section is legitimately
 * absent for plan-only pipelines, so its omission is expected, not an error.
 */

export type CoachSection = "triggers" | "plan" | "apply";

export interface Anchor {
  section: CoachSection;
  /** 1-based, to match Monaco line numbers. */
  startLine: number;
  endLine: number;
}

/** Plain-English, networking-flavoured copy shown for each section. */
export const SECTION_COPY: Record<CoachSection, { title: string; body: string }> = {
  triggers: {
    title: "The trigger",
    body:
      "This is the trigger — like the condition that kicks off a MOP. It tells " +
      "the pipeline WHEN to run: here, when a pull request is opened and again " +
      "when it's merged.",
  },
  plan: {
    title: "The plan job (dry run)",
    body:
      "The plan job is a dry run. It shows what WOULD change without touching " +
      "anything — read it like `show` before you `configure`. This runs on the " +
      "pull request so reviewers can see the diff before approving.",
  },
  apply: {
    title: "The apply job (for real)",
    body:
      "The apply job makes the change for real — like hitting `commit`. It only " +
      "runs after the pull request is merged, so nothing changes until a human " +
      "has approved it.",
  },
};

/** Leading-whitespace count (spaces) of a line; tabs count as one each. */
function indentOf(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

/**
 * Extend an anchor's end line to the last line that belongs to the block
 * started at `startLine` — i.e. up to (but not including) the next line whose
 * indent is less-than-or-equal to the start line's indent. Blank lines and
 * deeper-indented lines are considered part of the block. Capped by `maxSpan`
 * so a runaway block (e.g. the last section in the file) doesn't spotlight the
 * whole document.
 */
function blockEnd(lines: string[], startIdx: number, maxSpan = 12): number {
  const baseIndent = indentOf(lines[startIdx]);
  let end = startIdx;
  for (let i = startIdx + 1; i < lines.length && i - startIdx < maxSpan; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      continue; // blanks don't terminate a block
    }
    if (indentOf(line) <= baseIndent) {
      break;
    }
    end = i;
  }
  return end;
}

/** Strip a trailing `#`-comment so keyword matching ignores commentary. */
function codePart(line: string): string {
  const hash = line.indexOf("#");
  return hash === -1 ? line : line.slice(0, hash);
}

/**
 * Compute coach-mark anchors for a generated pipeline file.
 *
 * @param yaml     the generated pipeline source
 * @param platform github → look for `on:`/`push:`/`pull_request:`;
 *                 gitlab → look for `rules:`/`only:`/`stage:`
 */
export function computePipelineAnchors(
  yaml: string,
  platform: "github" | "gitlab",
): Anchor[] {
  if (!yaml || !yaml.trim()) return [];
  const lines = yaml.split("\n");

  const anchors: Anchor[] = [];
  const seen = new Set<CoachSection>();

  const add = (section: CoachSection, idx: number) => {
    if (seen.has(section)) return;
    seen.add(section);
    anchors.push({
      section,
      startLine: idx + 1,
      endLine: blockEnd(lines, idx) + 1,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const code = codePart(lines[i]);
    const trimmed = code.trim();
    if (!trimmed) continue;

    // --- triggers ---
    if (!seen.has("triggers")) {
      if (platform === "github") {
        // Top-level `on:` block, or an explicit pull_request/push key.
        if (/^on:\s*(\[.*\])?\s*$/.test(trimmed) || /^on:\s*\w/.test(trimmed)) {
          add("triggers", i);
        } else if (/^(pull_request|push):/.test(trimmed)) {
          add("triggers", i);
        }
      } else {
        // GitLab: workflow rules, or a job-level rules/only clause.
        if (/^(workflow|rules|only):/.test(trimmed) || /^-?\s*(rules|only):/.test(trimmed)) {
          add("triggers", i);
        } else if (/merge_request|merge_requests/.test(trimmed)) {
          add("triggers", i);
        }
      }
    }

    // --- plan (terraform plan, or ansible's --check dry run) ---
    if (!seen.has("plan") && (/plan/i.test(trimmed) || /--check/.test(trimmed))) {
      add("plan", i);
    }

    // --- apply (terraform apply, or a real ansible-playbook run w/o --check) ---
    if (
      !seen.has("apply") &&
      (/apply/i.test(trimmed) ||
        (/ansible-playbook/.test(trimmed) && !/--check/.test(trimmed)))
    ) {
      add("apply", i);
    }
  }

  // Present them top-to-bottom in file order so stepping through reads naturally.
  return anchors.sort((a, b) => a.startLine - b.startLine);
}

export interface ResolvedCoachStep extends Anchor {
  title: string;
  body: string;
}

/** Attach the per-section teaching copy to each anchor. */
export function toCoachSteps(anchors: Anchor[]): ResolvedCoachStep[] {
  return anchors.map((a) => ({ ...a, ...SECTION_COPY[a.section] }));
}
