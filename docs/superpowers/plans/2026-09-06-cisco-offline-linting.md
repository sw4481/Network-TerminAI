# Offline Cisco Linting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add an explicit IOS-XE/NX-OS offline Cisco editor mode with conservative structural linting, local guardrail diagnostics, Monaco markers, and a clickable Problems panel, while removing the editor's selected-text terminal handoff.

**Architecture:** Keep the validator pure and Monaco-independent. Carry a nullable Cisco platform profile with the in-memory editor buffer and its existing attached/detached synchronization contract. The active editor owns one debounced structural-plus-guardrail diagnostic result; Monaco renders only the dedicated Cisco marker owner, and a reusable Problems panel presents the result without invoking terminal, approval, audit, sidecar, or device paths.

**Tech Stack:** React, TypeScript, Zustand, Monaco Editor 0.52.2, Tauri 2, Rust buffer synchronization, Vitest, Cargo tests, and the existing local guardrail classifier.

**Spec:** docs/superpowers/specs/2026-09-05-cisco-offline-linting-design.md

## Global Constraints

- Cisco mode is explicitly Off, IOS-XE, or NX-OS; never infer a platform from a filename or buffer contents.
- The Cisco profile is memory-only on the editor buffer and is carried through detached-buffer synchronization; do not add database persistence.
- Structural linting is synchronous, deterministic, side-effect free, and must run without Tauri, React, Monaco, network access, or a device.
- Unknown Cisco commands, release-specific features, and indentation differences must not become invalid-command errors.
- Guardrail classification uses the existing local guardrail_classify/classifyCommand path only.
- Cisco linting must not call recordDecision, enqueue PendingDecision entries, ptyWrite, SSH, NETCONF, PyATS, a sidecar, a model, or a device.
- Diagnostics are advisory; they do not block saving and do not alter terminal/workflow safety paths.
- Monaco Cisco markers use a dedicated owner and must not clear LSP, bookmark, power-editing, or other decorations.
- Preserve current-file FindReplace, workspace search, runtime-local macros, terminal search, workflows, and all shared terminal/guardrail APIs.
- Remove the editor SendSelectionToCisco surface and its coordinator only after confirming no other consumer exists.
- Preserve unrelated dirty files, including Plans/Mistakes.MD and untracked cache artifacts.
- Before claiming completion, run focused tests, the frontend suite, TypeScript/build checks, Rust tests, git diff --check, ./run.sh, and the sidecar health checks required by AGENTS.md.

---

## Verified baseline and file map

Graphify and direct source inspection verified:

- MonacoEditor.tsx owns Monaco creation, model-language changes, model-content events, registration disposal, and the current LSP lifecycle.
- editorStore.ts owns EditorBufferState and the attached workspace buffers.
- editorBufferSync.ts and the Rust editor buffer manager carry authoritative snapshots between attached and detached windows.
- EditorTab.tsx owns the toolbar, focused editor references, and location routing.
- EditorPane.tsx and EditorSplitTree.tsx forward buffer/editor callbacks.
- DetachedEditorWindow.tsx reconstructs an EditorBufferState from synchronized snapshots and reuses EditorPane/MonacoEditor.
- hclLanguage.ts is the idempotent custom Monarch registration pattern.
- playbook-validate.ts is the existing pure, line-aware validator pattern.
- IacProblemsPanel.tsx is the existing collapsed Problems interaction pattern.
- classifyCommand calls the local guardrail Tauri command; recordDecision is a separate audit operation.

Create:

- src/lib/ciscoLint.ts
- src/lib/ciscoLint.test.ts
- src/components/editor/lsp/ciscoLanguage.ts
- src/components/editor/lsp/ciscoLanguage.test.ts
- src/hooks/useCiscoLint.ts
- src/hooks/useCiscoLint.test.ts
- src/components/editor/ciscoMarkers.ts
- src/components/editor/ciscoMarkers.test.ts
- src/components/editor/ProblemsPanel.tsx
- src/components/editor/ProblemsPanel.css
- src/components/editor/ProblemsPanel.test.tsx
- src/components/editor/EditorTab.cisco.test.tsx

Modify:

- src/state/editorStore.ts
- src/components/editor/editorBufferSync.ts
- src/lib/tauri.ts
- src-tauri/src/editor/buffer_manager.rs
- src-tauri/src/commands/editor.rs
- src/components/editor/MonacoEditor.tsx
- src/components/editor/EditorPane.tsx
- src/components/editor/EditorSplitTree.tsx
- src/components/editor/EditorTab.tsx
- src/components/editor/DetachedEditorWindow.tsx
- src/components/iac/IacProblemsPanel.tsx
- src/components/iac/IacStudioTab.tsx
- src/components/iac/IacStudioTab.css
- src/components/editor/EditorTab.css only for the Cisco selector/status/panel layout

Delete after consumer search:

- src/components/editor/SendSelectionToCisco.tsx
- src/components/editor/SendSelectionToCisco.css
- src/components/editor/SendSelectionToCisco.test.tsx
- src/components/editor/ciscoSelectionBridge.ts
- src/components/editor/ciscoSelectionBridge.test.ts

Do not modify terminalConnectionStore.ts, terminalRegistry.ts, workflowDispatcher.ts, guardrails.ts, guardrailsStore.ts, ptyWrite, src-tauri/src/search.rs, or sidecar code.

## Task 1: Build the pure Cisco structural validator

**Files:**

- Create: src/lib/ciscoLint.ts
- Test: src/lib/ciscoLint.test.ts

**Interfaces:**

- CiscoPlatform is the union "iosxe" | "nxos".
- CiscoDiagnosticSeverity is the union "error" | "warning" | "info".
- CiscoDiagnostic has line, column, endColumn, severity, message, source, and code fields.
- CiscoLintResult has diagnostics: CiscoDiagnostic[] and structuralStatus: "ready".
- ciscoLanguageId(platform) returns "cisco-iosxe" or "cisco-nxos".
- lintCiscoConfig(text, platform) returns CiscoLintResult.

- [ ] **Step 1: Write the failing validator tests**

Add deterministic fixtures and assert diagnostic codes, severity, and one-based locations rather than relying only on message text:

    it("accepts comments, known contexts, exits, and unknown release commands", () => {
      const result = lintCiscoConfig(
        [
          "!",
          "interface GigabitEthernet1/0/1",
          " description uplink",
          " mystery-release-command",
          " exit",
        ].join("\n"),
        "iosxe",
      );
      expect(result.diagnostics).toEqual([]);
    });

    it("flags a captured CLI prompt and control character", () => {
      const result = lintCiscoConfig("Router#show version\ninterface \u0000 Gi1", "iosxe");
      expect(result.diagnostics.map((d) => d.code)).toEqual([
        "cli-prompt",
        "control-character",
      ]);
      expect(result.diagnostics[0]).toMatchObject({ line: 1, column: 1, severity: "warning" });
    });

    it("warns when a recognized child command is outside its context", () => {
      const result = lintCiscoConfig(" ip address 192.0.2.1 255.255.255.0", "iosxe");
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: "orphan-child-command",
          line: 1,
          severity: "warning",
        }),
      ]);
    });

    it("flags unmatched exit without requiring a final end", () => {
      const result = lintCiscoConfig("exit\ninterface Gi1/0/1\n description test", "nxos");
      expect(result.diagnostics.map((d) => d.code)).toContain("unmatched-exit");
      expect(result.diagnostics.map((d) => d.code)).not.toContain("missing-end");
    });

    it("reports only high-confidence platform mismatches", () => {
      const ios = lintCiscoConfig("feature ospf\n", "iosxe");
      const nxos = lintCiscoConfig("router ospf 1\n", "nxos");
      expect(ios.diagnostics.some((d) => d.code === "platform-mismatch")).toBe(true);
      expect(nxos.diagnostics.some((d) => d.code === "platform-mismatch")).toBe(false);
    });

    it("returns stable path-independent output", () => {
      const text = "!\ninterface Gi1/0/1\n ip address 192.0.2.1 255.255.255.0";
      expect(lintCiscoConfig(text, "iosxe")).toEqual(lintCiscoConfig(text, "iosxe"));
    });

Run before implementation:

    bunx vitest run src/lib/ciscoLint.test.ts

Expected: FAIL because ciscoLint.ts and its exported contracts do not exist.

- [ ] **Step 2: Implement line normalization and diagnostic construction**

Split CRLF, CR, and LF without changing source line positions. Trim only a
temporary comparison copy; preserve the original leading column for every
finding. Ignore blank lines and lines whose first non-whitespace character is
!. Construct every diagnostic with a stable code, source cisco-structural,
one-based line/endColumn, and one of error/warning/info.

- [ ] **Step 3: Implement conservative lexical and context checks**

Implement only these rules:

- cli-prompt: a line beginning with a hostname-like token followed by #, >,
  or ( looks like captured CLI output;
- control-character: a non-tab/non-newline control character appears in a line;
- orphan-child-command: a recognized child such as description, ip address,
  ipv6 address, switchport, spanning-tree, neighbor, or access-group appears
  without a compatible tracked parent context;
- unmatched-exit: exit/exit-address-family cannot close the tracked context;
- platform-mismatch: only high-confidence IOS-XE/NX-OS-only commands are
  flagged, with the platform-specific table kept small and explicit; and
- suspicious-output: a line clearly resembles command output rather than
  configuration, using a warning rather than an error.

Track only recognized parent contexts needed by those rules: interface,
router, address-family, line, vlan, vrf, policy-map, class-map, route-map,
controller, and the explicit NX-OS feature context. Treat ! as a separator
that clears nested context. Do not reject unknown commands, require a
complete top-level command allowlist, or require a final end.

- [ ] **Step 4: Run the validator tests**

    bunx vitest run src/lib/ciscoLint.test.ts

Expected: PASS with deterministic diagnostics and no device/Tauri imports.

- [ ] **Step 5: Commit**

    git add src/lib/ciscoLint.ts src/lib/ciscoLint.test.ts
    git commit -m "feat(editor): add offline Cisco structural linter"

## Task 2: Register IOS-XE and NX-OS Monaco languages

**Files:**

- Create: src/components/editor/lsp/ciscoLanguage.ts
- Test: src/components/editor/lsp/ciscoLanguage.test.ts
- Modify: src/components/editor/MonacoEditor.tsx

**Interfaces:**

- CISCO_IOSXE_LANGUAGE_ID is "cisco-iosxe".
- CISCO_NXOS_LANGUAGE_ID is "cisco-nxos".
- registerCiscoLanguages(monaco: typeof Monaco): void.
- ciscoLanguageId(platform) from Task 1 is the only platform-to-language mapping.

- [ ] **Step 1: Write the failing registration tests**

Use the same small fake Monaco language surface as hclLanguage.test.ts:

    it("registers both Cisco language ids exactly once", () => {
      const monaco = fakeMonaco();
      registerCiscoLanguages(monaco as never);
      registerCiscoLanguages(monaco as never);
      expect(monaco.registered).toEqual(["cisco-iosxe", "cisco-nxos"]);
    });

    it("configures comments, brackets, and off-side folding", () => {
      const monaco = fakeMonaco();
      registerCiscoLanguages(monaco as never);
      expect(monaco.configByLang["cisco-iosxe"]).toMatchObject({
        comments: { lineComment: "!" },
        folding: { offSide: true },
      });
      expect(monaco.configByLang["cisco-nxos"]).toMatchObject({
        comments: { lineComment: "!" },
      });
    });

    it("tokenizes Cisco comments, commands, interface names, and addresses", () => {
      const monaco = fakeMonaco();
      registerCiscoLanguages(monaco as never);
      expect(monaco.monarchByLang["cisco-iosxe"].keywords).toContain("interface");
    });

Run:

    bunx vitest run src/components/editor/lsp/ciscoLanguage.test.ts

Expected: FAIL because the Cisco language module does not exist.

- [ ] **Step 2: Implement the idempotent language configuration**

Register both ids once. Configure ! line comments, brackets/quotes,
auto-closing pairs where they are safe, folding.offSide: true, and an
indentation-preserving language configuration. Use one shared Monarch provider
with separate language ids. Tokenize high-confidence categories only:
comments, quoted strings, variables, numbers, IPv4/IPv6-looking values,
interface names, command verbs, and mode keywords. Do not add a Cisco LSP.

- [ ] **Step 3: Wire registration into Monaco loading**

Call registerCiscoLanguages(monaco) beside registerHclLanguage in the
existing one-time Monaco load effect. Add no second Monaco import or language
loader.

- [ ] **Step 4: Run focused language and existing Monaco tests**

    bunx vitest run src/components/editor/lsp/ciscoLanguage.test.ts src/components/editor/MonacoEditor.powerEditing.test.tsx

Expected: PASS; existing power-editing action registration and disposal remain unchanged.

- [ ] **Step 5: Commit**

    git add src/components/editor/lsp/ciscoLanguage.ts src/components/editor/lsp/ciscoLanguage.test.ts src/components/editor/MonacoEditor.tsx
    git commit -m "feat(editor): add Cisco Monaco language modes"

## Task 3: Carry the memory-only Cisco profile through editor buffers

**Files:**

- Modify: src/state/editorStore.ts
- Modify: src/lib/tauri.ts
- Modify: src/components/editor/editorBufferSync.ts
- Modify: src-tauri/src/editor/buffer_manager.rs
- Test: src-tauri/src/editor/buffer_manager.rs
- Test: src/components/editor/editorBufferSync.test.ts
- Test: src/state/editorStore.test.ts

**Interfaces:**

- EditorBufferState gains cisco_platform: CiscoPlatform | null.
- EditorBufferSeed gains ciscoPlatform: CiscoPlatform | null.
- EditorBufferSnapshot gains ciscoPlatform: CiscoPlatform | null.
- EditorBufferUpdateRequest gains ciscoPlatform: CiscoPlatform | null.
- EditorBufferSyncClient.queueLocal(content, language, ciscoPlatform, dirty) carries the profile.
- Rust EditorBufferSeed, EditorBufferSnapshot, and update state use Option<String> serialized as ciscoPlatform.

- [ ] **Step 1: Write failing synchronization tests**

Add a Rust manager test proving registration/update preserve the platform:

    #[test]
    fn editor_buffer_profile_survives_register_and_update() {
        let manager = EditorBufferManager::new();
        let mut seed = seed("interface Gi1");
        seed.cisco_platform = Some("iosxe".to_string());
        let registered = manager.register(seed);
        assert_eq!(registered.cisco_platform.as_deref(), Some("iosxe"));

        let result = manager
            .update(
                &registered.buffer_id,
                registered.revision,
                registered.content.clone(),
                registered.language.clone(),
                Some("nxos".to_string()),
                true,
                "detached".to_string(),
            )
            .expect("registered buffer");
        let EditorBufferUpdateResult::Applied { snapshot } = result else {
            panic!("expected applied update");
        };
        assert_eq!(snapshot.cisco_platform.as_deref(), Some("nxos"));
    }

Extend the TypeScript sync fixture and tests so:

    expect(transport.register).toHaveBeenCalledWith(
      expect.objectContaining({ ciscoPlatform: "iosxe" }),
    );
    client.queueLocal("interface Gi1", "cisco-iosxe", "iosxe", true);
    expect(transport.update).toHaveBeenCalledWith(
      expect.objectContaining({ ciscoPlatform: "iosxe" }),
    );

Add a store test that a newly created buffer has cisco_platform null and that
patching the active buffer changes only that profile field.

Run before implementation:

    cargo test --manifest-path src-tauri/Cargo.toml editor::buffer_manager::tests --lib
    bunx vitest run src/components/editor/editorBufferSync.test.ts src/state/editorStore.test.ts

Expected: FAIL because the profile fields and queue argument do not exist.

- [ ] **Step 2: Extend the Rust in-memory buffer contract**

Add cisco_platform to the Rust seed/snapshot structs and the manager register,
update, and conflict snapshots. Accept the value as an optional string and
preserve it exactly; do not persist it to SQLite. Update every manager test
fixture and update call with None or an explicit profile.

- [ ] **Step 3: Extend the typed Tauri and frontend synchronization contract**

Add ciscoPlatform to the TypeScript seed/snapshot/update request types and
update editorBufferSync LocalBufferVersion, queueLocal, register seed,
publishLatest, and equality checks. Add cisco_platform: null to
createEditorBuffer and propagate it in the editor store's patchBuffer path.
Do not add a migration or change editor layout serialization.

- [ ] **Step 4: Run synchronization tests**

    cargo test --manifest-path src-tauri/Cargo.toml editor::buffer_manager::tests --lib
    bunx vitest run src/components/editor/editorBufferSync.test.ts src/state/editorStore.test.ts

Expected: PASS with profile propagation and no persistence changes.

- [ ] **Step 5: Commit**

    git add src/state/editorStore.ts src/lib/tauri.ts src/components/editor/editorBufferSync.ts src-tauri/src/editor/buffer_manager.rs src-tauri/src/commands/editor.rs src/components/editor/editorBufferSync.test.ts src/state/editorStore.test.ts
    git commit -m "feat(editor): synchronize Cisco lint profiles"

## Task 4: Combine structural linting with local guardrail findings

**Files:**

- Create: src/hooks/useCiscoLint.ts
- Test: src/hooks/useCiscoLint.test.ts
- Modify: src/lib/ciscoLint.ts

**Interfaces:**

- CiscoGuardrailStatus is { state: "idle" | "running" | "ready" | "unavailable"; reason: string | null }.
- CiscoLintView is { diagnostics: CiscoDiagnostic[]; guardrails: CiscoGuardrailStatus }.
- useCiscoLint(args: { content: string; platform: CiscoPlatform | null; debounceMs?: number }): CiscoLintView.
- The hook calls classifyCommand("cisco", platform, line) for each non-empty source line.
- The hook never imports or calls recordDecision, useGuardrailsStore, ptyWrite, terminalConnectionStore, or approval code.

- [ ] **Step 1: Add pure guardrail mapping tests**

Add an exported pure mapper with a testable contract:

    guardrailDiagnostic(
      line: number,
      column: number,
      platform: CiscoPlatform,
      command: string,
      result: ClassifyResponse,
    ): CiscoDiagnostic | null

Test:

    it("maps non-T0 findings without changing the source command", () => {
      expect(
        guardrailDiagnostic(3, 2, "iosxe", " no ip route 0.0.0.0 0.0.0.0", {
          tier: "T3",
          rule_id: "remove-default-route",
          reasoning: "High impact route removal",
        }),
      ).toMatchObject({
        line: 3,
        column: 2,
        severity: "error",
        source: "guardrails",
        code: "guardrail-remove-default-route",
      });
    });

    it("does not produce a finding for T0", () => {
      expect(
        guardrailDiagnostic(1, 1, "nxos", "show version", {
          tier: "T0",
          rule_id: null,
          reasoning: "Read-only",
        }),
      ).toBeNull();
    });

Run:

    bunx vitest run src/lib/ciscoLint.test.ts

Expected: FAIL because guardrailDiagnostic is not defined.

- [ ] **Step 2: Implement stable guardrail severity/source mapping**

Map T1 and T2 to warning, T3 to error, and Ambiguous to warning with an
explicit Ambiguous label in the message. Return null for T0. Derive the
diagnostic code from the rule id when present and otherwise use a stable tier
code. Use the original line/column and do not trim the command included in
the message.

- [ ] **Step 3: Write failing hook tests**

Mock only classifyCommand and use fake timers. Cover:

    it("returns structural diagnostics immediately and classifies every non-empty line after debounce", async () => {
      classifyCommand.mockResolvedValueOnce({
        tier: "T0", rule_id: null, reasoning: "Read-only",
      }).mockResolvedValueOnce({
        tier: "T2", rule_id: "save-config", reasoning: "Writes startup config",
      });
      const { result } = renderHook(() =>
        useCiscoLint({
          content: "!\nshow version\ncopy running-config startup-config",
          platform: "iosxe",
          debounceMs: 10,
        }),
      );
      expect(result.current.guardrails.state).toBe("idle");
      await act(async () => { vi.advanceTimersByTime(10); });
      await waitFor(() => expect(result.current.guardrails.state).toBe("ready"));
      expect(classifyCommand).toHaveBeenNthCalledWith(
        2, "cisco", "iosxe", "copy running-config startup-config",
      );
      expect(result.current.diagnostics).toEqual([
        expect.objectContaining({ code: "guardrail-save-config", line: 3 }),
      ]);
    });

    it("keeps structural findings and reports unavailable on classifier failure", async () => {
      classifyCommand.mockRejectedValue(new Error("local classifier unavailable"));
      const { result } = renderHook(() =>
        useCiscoLint({ content: "Router#show version", platform: "nxos", debounceMs: 10 }),
      );
      await act(async () => { vi.advanceTimersByTime(10); });
      await waitFor(() => expect(result.current.guardrails.state).toBe("unavailable"));
      expect(result.current.diagnostics).toEqual([
        expect.objectContaining({ code: "cli-prompt" }),
      ]);
      expect(result.current.guardrails.reason).toContain("local classifier unavailable");
    });

    it("discards a stale classifier result after content changes", async () => {
      let resolveFirst!: (value: ClassifyResponse) => void;
      const first = new Promise<ClassifyResponse>((resolve) => {
        resolveFirst = resolve;
      });
      classifyCommand.mockReturnValueOnce(first).mockResolvedValue({
        tier: "T0", rule_id: null, reasoning: "Read-only",
      });
      const { result, rerender } = renderHook(
        ({ content }) => useCiscoLint({ content, platform: "iosxe", debounceMs: 10 }),
        { initialProps: { content: "copy running-config startup-config" } },
      );
      await act(async () => { vi.advanceTimersByTime(10); });
      rerender({ content: "show version" });
      await act(async () => { vi.advanceTimersByTime(10); });
      await act(async () => {
        resolveFirst({ tier: "T3", rule_id: "stale", reasoning: "stale" });
        await first;
      });
      await waitFor(() => expect(result.current.diagnostics).not.toContainEqual(
        expect.objectContaining({ code: "guardrail-stale" }),
      ));
    });

Run before implementation:

    bunx vitest run src/hooks/useCiscoLint.test.ts

Expected: FAIL because useCiscoLint does not exist.

- [ ] **Step 4: Implement the debounced hook**

Run structural linting synchronously whenever content and platform change.
When platform is null, return empty diagnostics and idle status without
calling classifyCommand. For an active platform, increment a request token,
schedule the classifier after debounceMs (default 400), classify non-empty
lines in source order, merge structural and guardrail results sorted by line,
column, severity, and code, and ignore all results from superseded tokens.
Keep structural diagnostics when any classifier call fails and expose the
sanitized error string as the unavailable reason.

- [ ] **Step 5: Run hook tests**

    bunx vitest run src/lib/ciscoLint.test.ts src/hooks/useCiscoLint.test.ts

Expected: PASS; test spies prove no audit, approval, terminal, or network path is reached.

- [ ] **Step 6: Commit**

    git add src/lib/ciscoLint.ts src/lib/ciscoLint.test.ts src/hooks/useCiscoLint.ts src/hooks/useCiscoLint.test.ts
    git commit -m "feat(editor): merge Cisco guardrail diagnostics"

## Task 5: Render Cisco diagnostics as isolated Monaco markers

**Files:**

- Create: src/components/editor/ciscoMarkers.ts
- Test: src/components/editor/ciscoMarkers.test.ts
- Modify: src/components/editor/MonacoEditor.tsx
- Modify: src/components/editor/MonacoEditor.powerEditing.test.tsx

**Interfaces:**

- setCiscoMarkers(monaco, model, diagnostics): void.
- clearCiscoMarkers(monaco, model): void.
- MonacoEditor receives ciscoPlatform, ciscoDiagnostics, and ciscoGuardrailStatus props.
- ciscoPlatform null means the existing language and LSP path are retained.

- [ ] **Step 1: Write failing marker tests**

Use a fake Monaco model and marker API:

    it("sets only the Cisco marker owner with one-based ranges", () => {
      const model = {};
      const monaco = {
        MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
        editor: { setModelMarkers: vi.fn() },
      };
      setCiscoMarkers(monaco as never, model as never, [{
        line: 4, column: 2, endColumn: 12, severity: "warning",
        message: "High impact", source: "guardrails", code: "guardrail-save",
      }]);
      expect(monaco.editor.setModelMarkers).toHaveBeenCalledWith(
        model, "cisco-lint", [{
          startLineNumber: 4, startColumn: 2,
          endLineNumber: 4, endColumn: 12,
          message: "High impact (guardrails)",
          severity: 4,
        }],
      );
    });

    it("clears Cisco markers without touching other owners", () => {
      const monaco = { editor: { setModelMarkers: vi.fn() } };
      clearCiscoMarkers(monaco as never, {} as never);
      expect(monaco.editor.setModelMarkers).toHaveBeenCalledWith(
        {}, "cisco-lint", [],
      );
    });

Run:

    bunx vitest run src/components/editor/ciscoMarkers.test.ts

Expected: FAIL because ciscoMarkers.ts and its exports do not exist.

- [ ] **Step 2: Implement the isolated marker adapter**

Map error/warning/info to Monaco MarkerSeverity.Error/Warning/Info, clamp
line/column/endColumn to valid positive values, and call setModelMarkers only
with owner cisco-lint. Include source in the visible message. Empty
diagnostics must clear the owner. Do not call deltaDecorations or alter
existing LSP, bookmark, git, or power-editing decorations.

- [ ] **Step 3: Add Cisco props and effective language handling**

Add optional Cisco props to MonacoEditor. Compute the effective model
language as language when ciscoPlatform is null and ciscoLanguageId(platform)
otherwise. Register Cisco languages from Task 2 before model creation.
Disable useLspClient and the document/provider effects for Cisco mode, while
leaving the original language available to existing Ask-AI/context callbacks.
Update model acquisition, language changes, and their dependency lists to use
the effective model language so switching profiles changes highlighting
without replacing the shared model.

- [ ] **Step 4: Add marker lifecycle tests**

Extend MonacoEditor.powerEditing.test.tsx to assert:

    expect(mocks.setModelMarkers).toHaveBeenCalledWith(
      mocks.model, "cisco-lint", expect.any(Array),
    );

Then simulate Cisco mode changing to Off and assert the same owner receives
an empty marker list. Also assert existing power-editing registrations still
dispose through the current ownership lifecycle.

- [ ] **Step 5: Run focused marker and Monaco tests**

    bunx vitest run src/components/editor/ciscoMarkers.test.ts src/components/editor/MonacoEditor.powerEditing.test.tsx src/components/editor/MonacoEditor.lifecycle.test.ts

Expected: PASS with Cisco markers isolated and cleared on disable/disposal.

- [ ] **Step 6: Commit**

    git add src/components/editor/ciscoMarkers.ts src/components/editor/ciscoMarkers.test.ts src/components/editor/MonacoEditor.tsx src/components/editor/MonacoEditor.powerEditing.test.tsx
    git commit -m "feat(editor): render Cisco lint markers"

## Task 6: Add the reusable Problems panel

**Files:**

- Create: src/components/editor/ProblemsPanel.tsx
- Create: src/components/editor/ProblemsPanel.css
- Test: src/components/editor/ProblemsPanel.test.tsx
- Modify: src/components/iac/IacProblemsPanel.tsx
- Modify: src/components/iac/IacStudioTab.tsx only if its import/adapter changes
- Modify: src/components/iac/IacStudioTab.css only if styles move

**Interfaces:**

- ProblemDiagnostic accepts line, column, endColumn?, severity, message, source, and code?.
- ProblemStatus is { name: string; state: "ready" | "running" | "unavailable" | "idle"; reason: string | null }.
- ProblemsPanel props are diagnostics: ProblemDiagnostic[], statuses: ProblemStatus[], onJumpTo(line, column), title?: string.
- Existing IacProblemsPanel remains a compatibility wrapper around ProblemsPanel and preserves its current public props.

- [ ] **Step 1: Write failing generic panel tests**

Cover exact counts, severity labels, status honesty, collapse, mouse activation,
and keyboard activation:

    it("renders counts and jumps to a one-based location", () => {
      const onJumpTo = vi.fn();
      render(<ProblemsPanel
        diagnostics={[{
          line: 7, column: 3, endColumn: 8, severity: "error",
          message: "Unexpected exit", source: "cisco-structural", code: "unmatched-exit",
        }]}
        statuses={[{ name: "Structural", state: "ready", reason: null }]}
        onJumpTo={onJumpTo}
      />);
      expect(screen.getByText(/1 error/)).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("problem-0"));
      expect(onJumpTo).toHaveBeenCalledWith(7, 3);
    });

    it("does not claim clean when a provider is unavailable", () => {
      render(<ProblemsPanel
        diagnostics={[]}
        statuses={[{
          name: "Guardrails", state: "unavailable",
          reason: "local classifier unavailable",
        }]}
        onJumpTo={() => {}}
      />);
      expect(screen.queryByText(/No issues found/i)).not.toBeInTheDocument();
      expect(screen.getByText(/local classifier unavailable/)).toBeInTheDocument();
    });

    it("supports keyboard activation for a problem row", () => {
      const onJumpTo = vi.fn();
      render(<ProblemsPanel
        diagnostics={[{
          line: 2, column: 1, severity: "warning",
          message: "Captured prompt", source: "cisco-structural", code: "cli-prompt",
        }]}
        statuses={[]}
        onJumpTo={onJumpTo}
      />);
      fireEvent.keyDown(screen.getByTestId("problem-0"), { key: "Enter" });
      expect(onJumpTo).toHaveBeenCalledWith(2, 1);
    });

Run:

    bunx vitest run src/components/editor/ProblemsPanel.test.tsx src/components/iac/IacProblemsPanel.test.tsx

Expected: FAIL because the generic panel does not exist.

- [ ] **Step 2: Extract the generic panel without changing IaC behavior**

Move the existing summary/count/list/collapse behavior into ProblemsPanel.
Render each problem as a native button with a stable test id and accessible
name containing source, location, and message. Render clean only when every
status is ready and diagnostics is empty. Render running/unavailable/idle
statuses separately. Keep the current IacProblemsPanel prop shape by mapping
LintDiagnostic/LinterStatus to ProblemDiagnostic/ProblemStatus.

- [ ] **Step 3: Run the panel tests**

    bunx vitest run src/components/editor/ProblemsPanel.test.tsx src/components/iac/IacProblemsPanel.test.tsx

Expected: PASS, including the existing IaC tests.

- [ ] **Step 4: Commit**

    git add src/components/editor/ProblemsPanel.tsx src/components/editor/ProblemsPanel.css src/components/editor/ProblemsPanel.test.tsx src/components/iac/IacProblemsPanel.tsx src/components/iac/IacStudioTab.tsx src/components/iac/IacStudioTab.css
    git commit -m "refactor(editor): share Problems panel behavior"

## Task 7: Integrate active-buffer Cisco mode and remove handoff UI

**Files:**

- Modify: src/state/editorStore.ts
- Modify: src/components/editor/EditorTab.tsx
- Modify: src/components/editor/EditorPane.tsx
- Modify: src/components/editor/EditorSplitTree.tsx
- Modify: src/components/editor/DetachedEditorWindow.tsx
- Modify: src/components/editor/editorBufferSync.ts
- Modify: src/components/editor/EditorTab.css
- Delete: src/components/editor/SendSelectionToCisco.tsx
- Delete: src/components/editor/SendSelectionToCisco.css
- Delete: src/components/editor/SendSelectionToCisco.test.tsx
- Delete: src/components/editor/ciscoSelectionBridge.ts
- Delete: src/components/editor/ciscoSelectionBridge.test.ts
- Test: src/components/editor/EditorTab.cisco.test.tsx
- Test: src/components/editor/DetachedEditorWindow.test.tsx

**Interfaces:**

- EditorTab renders a select with aria-label Cisco editor mode and values "", "iosxe", and "nxos".
- EditorTab calls patchBuffer(bufferId, { cisco_platform: selectedPlatformOrNull }) for mode changes.
- EditorPane and EditorSplitTree forward ciscoPlatform, ciscoDiagnostics, ciscoGuardrailStatus, and onCiscoLintResult to MonacoEditor.
- EditorTab renders ProblemsPanel for the focused buffer and calls onJumpTo(line, column) on the focused editor.
- DetachedEditorWindow runs useCiscoLint for its synchronized buffer and passes the result into EditorPane/MonacoEditor.
- No editor component imports SendSelectionToCisco or ciscoSelectionBridge after this task.

- [ ] **Step 1: Add failing active-buffer mode tests**

Add tests that use a focused editor buffer and mocked editor store actions:

    it("offers Off, IOS-XE, and NX-OS without inferring a platform", () => {
      renderEditorTab({
        buffer: { ...buffer, language: "plaintext", cisco_platform: null },
      });
      const selector = screen.getByLabelText("Cisco editor mode");
      expect(selector).toHaveValue("");
      expect(screen.getByRole("option", { name: "IOS-XE" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "NX-OS" })).toBeInTheDocument();
    });

    it("updates only the focused buffer profile", () => {
      const patchBuffer = vi.fn();
      renderEditorTab({
        buffer: { ...buffer, id: "file:/repo/running.cfg", cisco_platform: null },
        patchBuffer,
      });
      fireEvent.change(screen.getByLabelText("Cisco editor mode"), {
        target: { value: "nxos" },
      });
      expect(patchBuffer).toHaveBeenCalledWith(
        "file:/repo/running.cfg",
        { cisco_platform: "nxos" },
      );
    });

    it("renders Problems for the active Cisco buffer and navigates the focused editor", () => {
      const editor = {
        revealLineInCenter: vi.fn(),
        setPosition: vi.fn(),
        focus: vi.fn(),
      };
      renderEditorTab({
        buffer: { ...buffer, cisco_platform: "iosxe" },
        focusedEditor: editor,
        ciscoResult: {
          diagnostics: [{
            line: 5, column: 4, endColumn: 10, severity: "warning",
            message: "Captured CLI prompt", source: "cisco-structural", code: "cli-prompt",
          }],
          guardrails: { state: "ready", reason: null },
        },
      });
      fireEvent.click(screen.getByTestId("problem-0"));
      expect(editor.revealLineInCenter).toHaveBeenCalledWith(5);
      expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 5, column: 4 });
      expect(editor.focus).toHaveBeenCalled();
    });

    it("does not render the removed Send Selection to Cisco surface", () => {
      renderEditorTab({ buffer });
      expect(screen.queryByText(/Send Selection to Cisco/i)).not.toBeInTheDocument();
      expect(screen.queryByTestId("editor-cisco-send-button")).not.toBeInTheDocument();
    });

Run before implementation:

    bunx vitest run src/components/editor/EditorTab.cisco.test.tsx

Expected: FAIL because the selector, diagnostics routing, and handoff removal are not implemented.

- [ ] **Step 2: Add focused-buffer profile actions**

Use the existing patchBuffer action and current focusedBuffer. Render Off,
IOS-XE, and NX-OS options. Changing the selector updates only the active
buffer's cisco_platform field, clears Cisco diagnostics when Off is selected,
and never mutates Tab vendor/platform, terminal state, or persisted layout.
Keep the selector disabled when there is no active buffer.

- [ ] **Step 3: Wire the active lint result through attached panes**

Run useCiscoLint from EditorTab for focusedBuffer content and
cisco_platform. Keep the hook disabled for Off. Store the latest result in
EditorTab-local state keyed by focused buffer id so stale results from a
previous buffer cannot feed the Problems panel. Pass the active result through
EditorSplitTree and EditorPane to the focused MonacoEditor. A non-focused pane
receives no active-panel result and retains its normal editor behavior.

Render the generic ProblemsPanel below the editor content when Cisco mode is
active. Its jump callback must use the existing focusedEditor reference:

    const onJumpTo = (line: number, column: number) => {
      const editor = focusedEditor;
      if (!editor) return;
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column });
      editor.focus();
    };

Do not add a second diagnostics store or alter workspace layout persistence.

- [ ] **Step 4: Wire synchronized profiles and detached inline validation**

Update EditorTab queueLocal calls to pass the current buffer's
cisco_platform. Update DetachedEditorWindow bufferFromSnapshot and local
queueLocal calls for the synchronized profile. Run useCiscoLint in the
detached window from buffer.content and buffer.cisco_platform, pass its
diagnostics/status to EditorPane, and keep the source-window Problems panel as
the only cross-window navigation surface. Add a detached test asserting a
snapshot with ciscoPlatform "nxos" reaches the pane/Monaco props.

- [ ] **Step 5: Remove the old handoff surface**

First run a consumer check:

    rg -n "SendSelectionToCisco|ciscoSelectionBridge|editor-cisco-send-button" src

After confirming only the old editor files and tests reference them, remove
those files and delete the EditorTab import, state, toolbar button, panel
render, and unused sessionId wiring. Do not change shared terminal,
guardrail, approval, or PTY code.

- [ ] **Step 6: Run focused integration tests**

    bunx vitest run src/components/editor/EditorTab.cisco.test.tsx src/components/editor/DetachedEditorWindow.test.tsx src/components/editor/ProblemsPanel.test.tsx src/components/iac/IacProblemsPanel.test.tsx

Expected: PASS; Cisco mode is explicit, diagnostics navigate correctly,
detached profiles synchronize, and no handoff surface remains.

- [ ] **Step 7: Commit**

    git add src/state/editorStore.ts src/components/editor/EditorTab.tsx src/components/editor/EditorPane.tsx src/components/editor/EditorSplitTree.tsx src/components/editor/DetachedEditorWindow.tsx src/components/editor/editorBufferSync.ts src/components/editor/EditorTab.css src/components/editor/EditorTab.cisco.test.tsx src/components/editor/DetachedEditorWindow.test.tsx
    git add -u src/components/editor/SendSelectionToCisco.tsx src/components/editor/SendSelectionToCisco.css src/components/editor/SendSelectionToCisco.test.tsx src/components/editor/ciscoSelectionBridge.ts src/components/editor/ciscoSelectionBridge.test.ts
    git commit -m "feat(editor): add Cisco lint mode and remove handoff"

## Task 8: Run the complete verification gate

**Files:**

- No source changes are expected in this task.
- Inspect: git status, git diff, and the live TerminAI/sidecar processes.

- [ ] **Step 1: Run the complete frontend suite**

    bunx vitest run

Expected: PASS, including existing FindReplace, WorkspaceFind, macro,
appearance, detached-window, IaC, and guardrail tests.

- [ ] **Step 2: Run TypeScript and production build checks**

    bunx tsc --noEmit
    bun run build
    git diff --check

Expected: PASS with no new TypeScript errors, build failures, or whitespace errors.

- [ ] **Step 3: Run Rust tests and formatting checks**

Run the focused buffer-manager suite first:

    cargo test --manifest-path src-tauri/Cargo.toml editor::buffer_manager::tests --lib

Then run the repository Rust test gate required by the current checkout:

    cargo test --manifest-path src-tauri/Cargo.toml

Expected: PASS without changes to terminal/guardrail behavior.

- [ ] **Step 4: Launch through the required development path**

Use ./run.sh for development validation. Do not launch a second instance if
the existing instance is healthy; inspect and reuse it according to the
repository's current runbook. Preserve sidecar/.venv and
~/Library/Application Support/ccie-terminal.

- [ ] **Step 5: Verify the sidecar health invariant**

Confirm all of the following after the app launch:

- target/debug/TerminAI is running;
- a child python -m ccie_sidecar process is running from sidecar/.venv;
- the sidecar warmup ping succeeds;
- sidecar_status.last_seen receives fresh heartbeat timestamps; and
- the footer chip leaves starting and shows the sidecar version.

These checks are release gates even though Cisco linting itself does not use
the sidecar.

- [ ] **Step 6: Perform the final scope audit**

Run:

    rg -n "SendSelectionToCisco|ciscoSelectionBridge|ptyWrite|enqueueAndAwait|recordDecision" src/components/editor src/hooks src/lib/ciscoLint.ts

Expected: the first two patterns have no matches; ptyWrite, enqueueAndAwait,
and recordDecision have no matches in Cisco lint files or editor components.
Verify that terminalConnectionStore, terminalRegistry, guardrails, and
workflowDispatcher diffs are empty.

- [ ] **Step 7: Record and commit verification-only fixes when a source defect is found**

When verification exposes a source defect, record the issue in
Plans/Mistakes.MD with the issue, root-cause analysis, and remedy before
fixing it. Re-run the affected focused test and the relevant complete gate.
Do not commit generated caches, app data, sidecar environments, or unrelated
dirty files.

If no source defect exists, leave the verification task with its evidence and
do not create a no-op commit.

## Plan self-review

- Spec coverage: Tasks 1 and 2 cover structural rules and language behavior;
  Task 3 covers memory-only profile propagation; Task 4 covers local
  guardrails and stale results; Task 5 covers isolated markers; Task 6 covers
  Problems behavior; Task 7 covers active-buffer integration, detached
  behavior, and handoff removal; Task 8 covers the full acceptance gate.
- Placeholder scan: no TBD, TODO, or unspecified implementation step is used.
- Type consistency: CiscoPlatform and CiscoDiagnostic originate in Task 1;
  all later tasks consume those exact types. The profile is named
  cisco_platform in editor state and ciscoPlatform at the Tauri JSON boundary,
  matching the existing Rust camelCase serialization convention.
- Scope check: no sidecar or device subsystem is introduced, and the plan
  leaves terminal and guardrail execution APIs unchanged.
