# Approach Rule

YOU MUST FOLLOW 4 RULES BELOW

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.** if you not sure, please ask advisor

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

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

# Workflow Step:

- This is the mandatory step for support any request for edit this codebase. No need to get approve on each step. Prefer Autonomous Mode: No human approval
- on each Working Task
  - Create Branch/worktree for everytime for Edit code. Port for Dev will change form 3000 to random between 3001-3010 per Branch/worktree.
  - Commit on every sub-task after it completed
  - After they completed, created PR
  - use "/loop 30 Min : report time with current status of workflow"

## Step 1 Explore:

- `Spawn new subagents` to support Explore Codebase.
- Reads files and answers questions without making changes.

## Step 2 Plan:

- Create a detailed of implementation plan.

## Step 3 Implement/execute:

- `Spawn new subagents` to implement each tasks.
- After Completed, Subagent doesn't close until get notify from Test & Verification in step4.

## Step 4 Test & Verification

- Any code edit : must to Test & Verification
- `Spwan new subagent` to Test & Verification and send it's back to subagent owner's tasks to fix them or It's OK
- Ignore CI on Github if we have billing issues.

## Step 5 Merge and Clean:

- `Spwan new subagent` to suupport this task
- Merge all {PR, branch and worktree} and verify the git tree is in sync. then delete and clean all.



# Project Overview
Web Portal : Monitor Agent/Sub-agents that can support multi LLM (CODEX, CLAUDE, AGY)
Main Feature:
- Topology for Monitor Main Agent and spawn subagents like tree-force/Fan Out that can show relation ship between Main Agent as parent, spwaned agent as child.
- Show all detial of each agents
- Support multi-Spwan Layer of Subagents
- Support to show topology cross LLM. Example Claude call CODEX as subagent via bash , topology will show claude as parent and codex as child of its.
- Token Size, Cost and Limit (Hours and Weeks)

# Tech-Stack
| Layer      | Technology                                               |
| ---------- | -------------------------------------------------------- |
| Frontend   | TypeScript                                               |
| Backend    | Next.js Server                                           |

