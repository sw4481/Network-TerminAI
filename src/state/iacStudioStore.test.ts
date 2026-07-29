import { describe, it, expect, beforeEach } from "vitest";
import { useIacStudioStore, freshIacStudioState } from "./iacStudioStore";

describe("iacStudioStore", () => {
  beforeEach(() => {
    useIacStudioStore.setState({ tabs: {} });
  });

  it("ensure() seeds a tab rooted at the given workspace path", () => {
    const st = useIacStudioStore.getState().ensure("t1", "/tmp/proj");
    expect(st.root_path).toBe("/tmp/proj");
    expect(st.file_path).toBeNull();
    expect(st.is_dirty).toBe(false);
    expect(st.expanded_dirs.has("/tmp/proj")).toBe(true);
  });

  it("openFile sets path+content and clears dirty", () => {
    useIacStudioStore.getState().ensure("t1", "/tmp/proj");
    useIacStudioStore.getState().openFile("t1", "/tmp/proj/main.tf", 'resource "x" {}', "hcl");
    const st = useIacStudioStore.getState().tabs["t1"];
    expect(st.file_path).toBe("/tmp/proj/main.tf");
    expect(st.content).toBe('resource "x" {}');
    expect(st.language).toBe("hcl");
    expect(st.is_dirty).toBe(false);
  });

  it("setContent marks dirty; setDirty(false) clears it", () => {
    useIacStudioStore.getState().ensure("t1", "/tmp/proj");
    useIacStudioStore.getState().setContent("t1", "changed");
    expect(useIacStudioStore.getState().tabs["t1"].is_dirty).toBe(true);
    useIacStudioStore.getState().setDirty("t1", false);
    expect(useIacStudioStore.getState().tabs["t1"].is_dirty).toBe(false);
  });

  it("toggleDir adds and removes an expanded directory", () => {
    useIacStudioStore.getState().ensure("t1", "/tmp/proj");
    useIacStudioStore.getState().toggleDir("t1", "/tmp/proj/modules");
    expect(useIacStudioStore.getState().tabs["t1"].expanded_dirs.has("/tmp/proj/modules")).toBe(true);
    useIacStudioStore.getState().toggleDir("t1", "/tmp/proj/modules");
    expect(useIacStudioStore.getState().tabs["t1"].expanded_dirs.has("/tmp/proj/modules")).toBe(false);
  });

  it("setRoot re-roots the workspace and reseeds expanded dirs", () => {
    useIacStudioStore.getState().ensure("t1", "/tmp/proj");
    useIacStudioStore.getState().setRoot("t1", "/tmp/other");
    const st = useIacStudioStore.getState().tabs["t1"];
    expect(st.root_path).toBe("/tmp/other");
    expect(st.expanded_dirs.has("/tmp/other")).toBe(true);
  });
});

describe("iacStudioStore diagnostics", () => {
  beforeEach(() => {
    useIacStudioStore.setState({ tabs: {} });
  });

  it("stores diagnostics and linters per tab", () => {
    const { ensure, setDiagnostics } = useIacStudioStore.getState();
    ensure("tabD", "/ws");
    setDiagnostics("tabD", {
      diagnostics: [
        { line: 2, column: 1, severity: "error", message: "boom", source: "terraform fmt" },
      ],
      linters: [{ name: "terraform fmt", ran: true, available: true, reason: null }],
    });
    const s = useIacStudioStore.getState().tabs["tabD"];
    expect(s.diagnostics).toHaveLength(1);
    expect(s.diagnostics[0].message).toBe("boom");
    expect(s.linters[0].name).toBe("terraform fmt");
  });

  it("defaults diagnostics and linters to empty arrays", () => {
    const { ensure } = useIacStudioStore.getState();
    const seeded = ensure("tabE", "/ws");
    expect(seeded.diagnostics).toEqual([]);
    expect(seeded.linters).toEqual([]);
  });
});

describe("ai slice", () => {
  beforeEach(() => {
    useIacStudioStore.setState({ tabs: {} });
  });

  it("defaults to not-generating with no proposal", () => {
    const store = useIacStudioStore.getState();
    store.ensure("ai-tab", "/root");
    const s = useIacStudioStore.getState().tabs["ai-tab"];
    expect(s.ai).toEqual({ generating: false, proposal: null, error: null });
  });

  it("setAiGenerating flips the flag and clears prior error", () => {
    const store = useIacStudioStore.getState();
    store.ensure("ai-tab2", "/root");
    store.setAiError("ai-tab2", "boom");
    store.setAiGenerating("ai-tab2", true);
    const s = useIacStudioStore.getState().tabs["ai-tab2"];
    expect(s.ai.generating).toBe(true);
    expect(s.ai.error).toBeNull();
  });

  it("setAiProposal stores the proposal and stops generating", () => {
    const store = useIacStudioStore.getState();
    store.ensure("ai-tab3", "/root");
    store.setAiGenerating("ai-tab3", true);
    store.setAiProposal("ai-tab3", {
      code: "resource {}",
      filename: "x.tf",
      explanation: "x",
      validation: { valid: true, skipped: false, error: null },
    });
    const s = useIacStudioStore.getState().tabs["ai-tab3"];
    expect(s.ai.generating).toBe(false);
    expect(s.ai.proposal?.filename).toBe("x.tf");
  });

  it("clearAiProposal resets the proposal", () => {
    const store = useIacStudioStore.getState();
    store.ensure("ai-tab4", "/root");
    store.setAiProposal("ai-tab4", {
      code: "c",
      filename: "f",
      explanation: "e",
      validation: { valid: null, skipped: true, error: null },
    });
    store.clearAiProposal("ai-tab4");
    expect(useIacStudioStore.getState().tabs["ai-tab4"].ai.proposal).toBeNull();
  });

  it("setAiError records the message and stops generating", () => {
    const store = useIacStudioStore.getState();
    store.ensure("ai-tab5", "/root");
    store.setAiGenerating("ai-tab5", true);
    store.setAiError("ai-tab5", "rpc failed");
    const s = useIacStudioStore.getState().tabs["ai-tab5"];
    expect(s.ai.error).toBe("rpc failed");
    expect(s.ai.generating).toBe(false);
  });
});

describe("iacStudioStore pending_wizard", () => {
  beforeEach(() => useIacStudioStore.setState({ tabs: {} }));

  it("freshIacStudioState defaults pending_wizard to null", () => {
    expect(freshIacStudioState("/root").pending_wizard).toBeNull();
  });

  it("setPendingWizard sets and clears the flag", () => {
    const s = useIacStudioStore.getState();
    s.ensure("t1", "/root");
    s.setPendingWizard("t1", "resource");
    expect(useIacStudioStore.getState().tabs["t1"].pending_wizard).toBe("resource");
    s.setPendingWizard("t1", null);
    expect(useIacStudioStore.getState().tabs["t1"].pending_wizard).toBeNull();
  });

  it("setAiProposal preserves an optional target_path", () => {
    const s = useIacStudioStore.getState();
    s.ensure("t2", "/root");
    s.setAiProposal("t2", {
      code: "x", filename: "web.tf", explanation: "", target_path: "/root/web.tf",
      validation: { valid: null, skipped: true, error: null },
    });
    expect(useIacStudioStore.getState().tabs["t2"].ai.proposal?.target_path).toBe("/root/web.tf");
  });

  it("supports the 'onboarding' pending_wizard value", () => {
    const s = useIacStudioStore.getState();
    s.ensure("t1", "/root");
    s.setPendingWizard("t1", "onboarding");
    expect(useIacStudioStore.getState().tabs["t1"].pending_wizard).toBe("onboarding");
  });
});

describe("iacStudioStore coach-marks", () => {
  beforeEach(() => useIacStudioStore.setState({ tabs: {} }));

  const steps = [
    { section: "triggers" as const, startLine: 1, endLine: 2, title: "T", body: "t" },
    { section: "plan" as const, startLine: 3, endLine: 4, title: "P", body: "p" },
  ];

  it("defaults coach to null and coach_pending to false", () => {
    const fresh = freshIacStudioState("/root");
    expect(fresh.coach).toBeNull();
    expect(fresh.coach_pending).toBe(false);
  });

  it("startCoach activates at index 0 and clears coach_pending", () => {
    const s = useIacStudioStore.getState();
    s.ensure("t1", "/root");
    s.setCoachPending("t1", true);
    s.startCoach("t1", steps);
    const st = useIacStudioStore.getState().tabs["t1"];
    expect(st.coach?.active).toBe(true);
    expect(st.coach?.index).toBe(0);
    expect(st.coach_pending).toBe(false);
  });

  it("startCoach with no steps leaves coach null", () => {
    const s = useIacStudioStore.getState();
    s.ensure("t1", "/root");
    s.startCoach("t1", []);
    expect(useIacStudioStore.getState().tabs["t1"].coach).toBeNull();
  });

  it("coachNext advances and ends past the last step", () => {
    const s = useIacStudioStore.getState();
    s.ensure("t1", "/root");
    s.startCoach("t1", steps);
    s.coachNext("t1");
    expect(useIacStudioStore.getState().tabs["t1"].coach?.index).toBe(1);
    s.coachNext("t1");
    expect(useIacStudioStore.getState().tabs["t1"].coach).toBeNull();
  });

  it("coachBack clamps at zero", () => {
    const s = useIacStudioStore.getState();
    s.ensure("t1", "/root");
    s.startCoach("t1", steps);
    s.coachBack("t1");
    expect(useIacStudioStore.getState().tabs["t1"].coach?.index).toBe(0);
  });

  it("coachEnd clears the walkthrough", () => {
    const s = useIacStudioStore.getState();
    s.ensure("t1", "/root");
    s.startCoach("t1", steps);
    s.coachEnd("t1");
    expect(useIacStudioStore.getState().tabs["t1"].coach).toBeNull();
  });
});
