---
name: delegate
description: Analyze tasks and delegate work to focused sub-agents. Use at the start of any non-trivial task.
user_invocable: true
---

# Delegate Skill

You are starting work on a task. Before writing any code yourself, analyze the task and determine if it spans multiple focus areas. If it does, delegate to specialized sub-agents. If it only touches one area, you may still delegate to keep context clean, or handle it directly if it's small.

## Focus Areas

This project is a monorepo with these distinct areas:

| Area | Path(s) | Stack |
|------|---------|-------|
| **Frontend** | `packages/web/`, `packages/desktop/` (UI layer) | Next.js, React, TypeScript |
| **Rust** | `packages/desktop/src-tauri/` | Rust, Tauri |
| **Database** | `supabase/` | PostgreSQL, Supabase migrations, Edge Functions |
| **Shared** | `packages/shared/` | TypeScript |

## Instructions

### Step 1: Analyze the task

Break the task down into sub-tasks. For each sub-task, identify which focus area it belongs to. Consider dependencies between sub-tasks — some may need to run sequentially (e.g., database migration before API code that uses it), others can run in parallel.

### Step 2: Write a brief plan

Before spawning agents, output a short plan to the user:

```
**Plan:**
- [ ] [Area] Sub-task description
- [ ] [Area] Sub-task description
  - depends on: [previous sub-task]
```

### Step 3: Spawn agents

For each independent focus area, spawn a sub-agent using the `Agent` tool. Follow these rules:

1. **One agent per focus area** — never have two agents editing the same files. If two sub-tasks touch the same area, combine them into one agent.
2. **Fresh context** — each agent prompt must be self-contained. Include:
   - What to do (the specific sub-task)
   - Relevant file paths and any architectural context it needs
   - What conventions to follow (e.g., test-driven development)
   - What NOT to do (don't modify files outside its area, don't add unnecessary abstractions)
3. **Parallel when possible** — launch independent agents in a single message with multiple `Agent` tool calls.
4. **Sequential when necessary** — if agent B depends on agent A's output, wait for A to complete, then brief B with A's results.
5. **Use worktrees for risky work** — if an agent's changes might conflict with another agent's work, use `isolation: "worktree"`.
6. **Name your agents** — use descriptive names like `frontend-auth`, `rust-renderer`, `db-migration` so you can send follow-up messages if needed.

### Step 4: Integrate and verify

After all agents complete:
- Review their outputs for consistency across areas
- Run builds/tests if applicable (`pnpm build`, `cargo check`, etc.)
- Handle any integration issues yourself or by spawning a focused follow-up agent

## When NOT to delegate

- Single-file changes or small edits — just do them directly
- Pure research/exploration — use the Explore agent type instead
- Tasks that only touch one focus area AND are straightforward — handle directly

## Agent prompt template

Use this as a starting point for agent prompts:

```
You are working on the herzies project, a [brief context].

**Task:** [specific sub-task]

**Relevant paths:**
- [list of files/directories to read and modify]

**Context:**
- [any architectural decisions, constraints, or related work]

**Conventions:**
- Write tests before implementation (TDD)
- Don't add unnecessary abstractions or error handling
- Don't modify files outside your assigned paths
- [any area-specific conventions]

**Deliverable:** [what the agent should produce — code changes, a summary, etc.]
```
