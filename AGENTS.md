Always Use Superpowers plugin unless asked not to
Always use context7 for documentation thats up to date
Always use object oriented programming

If you make a mistake you MUST write out the following to Plans/Mistakes.md
    What the issue/mistake was
    An RCA of the Issue
    How you fixed it
ANY time you create a plan - you MUST refer to Plans/Mistakes.md to make sure we do not make the same mistakes.
Always use graphify to base your decisions and plans in fact from the actual code base. And always update the graphify graph

# Global Codex Second-Brain Policy

This policy applies to every local Codex session, regardless of the current working directory.

Shaun's Obsidian second brain is the vault at `/Users/shaunwhi/Documents/Shauns-Remote-Vault`, exposed through the MCP server `obsidian_second_brain`.

## Retrieval

- When vault-backed memory or prior local context would materially help, read `wiki/hot.md` first, then `wiki/index.md`, then only the relevant pages.
- Treat the vault as the source of truth. Do not copy vault content into Codex's separate memory store unless Shaun explicitly asks.
- Do not automatically inspect sensitive-looking paths, including `.obsidian/`, `.git/`, token, password, secret, credential, or API-key files.

## Automatic Write-Out

Before the final response in every substantive local Codex session, call the MCP tool `second_brain_save_session` to preserve durable context and refresh `wiki/hot.md`, `wiki/index.md`, and `wiki/log.md`.

A session is substantive when it produces any of the following:

- code, configuration, setup, or environment changes
- debugging findings or verification results
- decisions, plans, or follow-up work Shaun may need later
- useful facts about local repositories, tools, devices, services, or workflows
- an answer that should be findable in a future session

Use `second_brain_file_note` when a source, durable question or answer, concept, entity, resource, project, area, or archive item deserves its own structured page.

Skip write-out only for trivial exchanges with no durable value. Keep saved notes concise and structured; never store credentials, secrets, raw tokens, or unnecessary transcript text.

## Vault Safety

- Existing vault content is read-only by default.
- New second-brain content may be written only under `wiki/`, `.raw/`, `_templates/`, or `.vault-meta/`.
- Prefer the MCP tools over direct filesystem writes.
- If a required second-brain tool is unavailable or a save fails, tell Shaun explicitly instead of silently treating the session as saved.


## 1. Think Before Coding


**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.
- Use graphify to base your implementations in fact based on the code base

## 2. Simplicity First



**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes



**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution



**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.