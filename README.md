# dsh-session-fork

English | [简体中文](docs/README.zh.md)

`dsh-session-fork` brings a Git-like branch model to `DeepSeek Harness`, making it possible to work on several large, relatively independent tasks in parallel across dsh sessions.

Instead of keeping every task in one linear conversation, each task can evolve in its own branch. When the work is ready to come together, `squash` and `rebase` provide ways to bring the work back into a unified history.

This is a plugin for `DeepSeek Harness`; it cannot run standalone.

![branch_tab](docs/media/branch_tab.png)

## Why branches for parallel development?

The branch model mirrors how programmers already handle parallel work with Git.

When several large tasks are being developed in parallel, each branch can evolve independently without requiring every change to be resolved immediately. Once the work is ready, branches can be brought back together through operations such as `squash` and `rebase`.

This provides a mapping from:

**parallel development → unified history**

The goal is to make parallel development practical while keeping the ability to bring the resulting work back into a coherent history.

## Branches are not sub-agents

Branches and sub-agents solve different problems.

A branch is intended for several large, relatively unrelated tasks that need to progress independently. It is not simply a way to split one large task into several smaller tasks.

Sub-agents are still useful for small, lightweight tasks. They can be cheaper in context and better suited to work that does not need an independent long-running session.

The two approaches can also coexist. Sub-agents can remain part of the workflow, while branches provide a clearer boundary for larger parallel tasks.

## Keep thinking while your agents work

One practical motivation for the project is to reduce the waiting time that can happen when working with a single agent session.

There is a familiar joke about vibe coding being:

> chat once, then spend ten minutes on your phone.

Parallel branches make it possible to continue working on other tasks instead of waiting for one conversation to finish before moving on.

In the maintainer's experience, roughly **5× the token consumption produced roughly 4× the efficiency**.

The trade-off is additional token usage in exchange for keeping development moving across multiple tasks.

## Let AI handle session management

Independent sessions are harder to manage than sub-agents.

They are not inherently bound to the main session, and their lifecycle and identity are more difficult to keep track of. dsh-session-fork addresses this by providing:

- A complete set of branch management commands.
- Agent-callable tool versions of those commands.
- A recommended governance approach for managing branch sessions.

The goal is that developers do not need to manually worry about the details of session management. The AI can handle the branch lifecycle and orchestration while the developer focuses on the work.

## DeepSeek Harness integration

dsh-session-fork is designed to work with dsh's existing features rather than creating a separate session ecosystem.

The project follows a pattern-mimic and vendor approach to integration with dsh.

For example, a `squash` operation produces a summary message that remains compatible with dsh's `compact`-style summary behavior.

Sub-agents can also continue to work alongside the branch-based workflow.

## AI secretary direction

The branch model also opens the possibility of an **AI secretary** workflow.

A root branch can maintain a board and a clean context while the AI coordinates the developer's current tasks and handles the connections between them.

The secretary can organise the developer's workflow and habits while retaining the operational capabilities needed to manage the development process.

The longer-term direction is for the AI to focus on task orchestration and coordination while the developer focuses on the current work.

This is part of the project's **v0.3.0 AI secretary** direction.

## Quick start

Install (requires a web-app-based dsh profile):

```sh
dsh plugin --profile web add dsh-session-fork
```

After that, let your agent use the plugin freely. Every command also ships as an agent-callable tool.

## Core features

- `branch` operations give every session a name, an ancestry, and an index, with commands for managing them.
- `fork` strengthens the native experience and provides the ancestry primitive.
- `squash` and `rebase` provide two forms of cross-branch merging.
- `send_message_by_branch` strengthens communication between sessions.
- The **branch** tab provides visual management of branches.

## Join us

What we want to build next:

1. **Branch-scoped project memory**. Existing long-term memory models are project-grained, which can cause memory to leak across branches and pollute context. Branch-grained memory management is intended to make the model more robust.
2. **Ongoing maintenance**. Open `Issues` to find long-term improvements and bugs waiting for contributions.

We take an open stance on AI collaboration: feel free to use AI to contribute code, write commit messages, and draft PRs. But we expect you to own your code, review it yourself, and treat AI as your tool in communication rather than letting it talk to us on your behalf.

## License

[MIT](LICENSE)
