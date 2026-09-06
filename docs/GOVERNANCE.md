# Workspace governance — dsh-session-fork × git worktree

> This file is the governance baseline for every session in this workspace. It applies to all branches, including conversation history inherited from other branches.
>
> If you are not running on DeepSeek Harness, or the dsh-session-fork plugin is not enabled, ignore this governance.

## Definitions

- **session branch**: a branch-shaped session created and managed by the dsh-session-fork plugin.
- **root branch**: the branch where the user's first conversation lives; usually maps to git main (`forkOrigin` is null in code).
- **forked branch**: every branch that is not the root branch; does the hands-on work. Usually forked from the root branch, and can also be forked from another forked branch.

**Note**: a forked branch can fork further forked branches for side quests, forming a multi-level structure. In a fork relation, the initiating side is the fork source; the root branch is where the whole fork chain begins.

## Core principles

Stated or not, every rule in this file serves three ideas:

1. Reduce context pollution.
2. Enable efficient parallel development.
3. Mirror human office collaboration: branches develop in parallel without collisions, and an integrator merges.

## Branches and worktrees

- One session branch ⇔ one same-named git branch ⇔ one same-named worktree under the container directory (`/` → `-`).
- The root branch always remains the developer's secretary: any activity that could pollute its context (writing code, deep research) is handed to a freshly forked branch.
- A forked branch does the same when it hits a side quest — loosely related to the current task, yet large enough to block it (e.g. mid-feat you discover a fix must land first, or later code reuse or style suffers): it forks a new forked branch off itself.

## Permissions

- Only the root branch holds gh write access. Every forked branch has gh read access, plus unlimited power on its own git branch (push, rebase, force-push).
- Cross-branch git authority (merge, rebase, squash) belongs solely to the initiating side of a fork: the root branch over any forked branch, and a forked branch over the branches it forked. The forked side holds no authority in the opposite direction.

## Creation

- After a fork happens, the newly forked branch proactively checks that the worktree exists, creates it if missing, and updates the `.code-workspace` file so the new worktree joins the VS Code workspace.
- Scenarios that would otherwise call for dsh's native sub agents can always be migrated to forked branches with confidence.

> Note: the `.code-workspace` file is always edited by forked branches themselves, which is prone to races.

## Merge and closing

- When its work is done, the forked branch proactively runs the session-level squash toward its fork source (`squash_into` <fork source>); if nothing meaningful can be compacted, it falls back to `rebased_into`. Once the squash has landed, it asks the fork source via `send_message_by_branch` to take over the delivery; git-level branch operations are performed by the fork source.
- When the developer confirms closing: the forked branch cleans up its own worktree and local git branch, and removes the matching worktree entry from the `.code-workspace` file; the fork source recycles (rm) its session branch.

## Messaging and communication

The `send_message_by_branch` tool is recommended for these scenarios:

1. Forked-branch work delivery: right after the squash, ask the fork source to handle the cross-branch operations.
2. A forked branch forking a new branch for a side quest states the requirement in the fewest words possible. (Remember: the new branch inherits your context **in full** — whatever you know, it knows; no context needs to be restated.)
3. A forked branch that needs a decision: when the fork source should decide, squash itself first, then ask in the fewest words; when the user should decide, message the fork source via `send_message_by_branch` to alert the user instead of squashing, and let the user handle it directly on this branch.

## Common scenario workflows

### The user asks to handle an issue

1. **Root branch**: name the task and create the session branch following the repo's branch-naming convention.
2. **Root branch**: wake the new branch with `send_message_by_branch` (a fork does not inherit the current turn's context, so the message must name the issue to handle; how to handle it is for the forked branch to work out — the root branch should not do extra research and hand over an action plan).
3. **Forked branch**: create the same-named git branch and git worktree; update the `.code-workspace` file.
4. **Forked branch**: following the user's own governance habits, either act directly or start the requested research.
5. **Forked branch**: when the work is done, squash back to the root branch.
6. **Forked branch**: wake the root branch with `send_message_by_branch` and state that the work is delivered (the squash has landed, so the root branch already knows what happened and can infer the next step — this is a wake-up only, no to-do list needs to be passed).
7. **Root branch**: classify the task and open a PR or perform a git merge.
8. **Root branch**: report to the user — e.g. a board of the current progress.

> Note: unless the task itself is research, research is only an adjunct to the code action.
>
> 1. There is **no** need to start a dedicated research-only branch first, or in addition.
> 2. After finishing research, the forked branch does **not** report straight back to the root branch; it stands by to continue the deep discussion with the user or receive action instructions.

The same workflow applies to a requirement the user describes verbally.

### A PR is merged and the user asks to clean up the local environment

1. **Root branch**: identify which branches the user means.
2. **Root branch**: ask the forked branches via `send_message_by_branch` to clean up their environments.
3. **Forked branch**: remove the git worktree and git branch; update the `.code-workspace` file.
4. **Forked branch**: report back to the root branch via `send_message_by_branch` that the cleanup is done, and request recycling of its session branch.
5. **Root branch**: recycle the session branches; the local environment is clean.
