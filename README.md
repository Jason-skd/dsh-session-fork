# dsh-session-fork

English | [简体中文](docs/README.zh.md)

Sub agents and parallel development never quite deliver in today's agent apps. This project manages dsh's native, discrete sessions the way git manages branches: `fork` gives conversations inheritance, while `squash` and `rebase` give them merging — a major upgrade to the parallel-development and prompt-management experience on dsh.

This is a plugin for `DeepSeek Harness`; it cannot run standalone.

Version `0.4.0` supports dsh `0.2.1-rc.2`. It replaces the previous dsh `0.1.2-rc.1` compatibility line; upgrade dsh before upgrading this plugin.

For compatibility development, build a sibling `../deepseek-harness` checkout and run `bun run test:harness`. Set `DSH_HARNESS_DIR` to use another checkout. The check uses an isolated copy linked to the actual harness packages and checks V4 messages, historical merges, and both Host and Client types.

![branch_tab](docs/media/branch_tab.png)

## Pain points it solves

- **Efficient solo parallel development**: the branch model mirrors how real programmers collaborate. While developing in parallel, every agent holds its own snapshot of the repo — you trade a strictly linear development history for resolving conflicts at merge time.
- **Clean context management**: the main branch (e.g. `main`) stays your secretary and dispatcher. Research and coding tasks are delegated to child branches; when a task is done, only its compressed context is reported back to the main branch.
- **Hardened session management**: the branch model upgrades dsh's native `fork` and cross-session messaging experience.

## Quick start

Install (requires a web-app-based dsh profile):

```sh
dsh plugin --profile web add dsh-session-fork
```

After that, just let your agent use the plugin freely — every command also ships as an agent-callable tool!

## Core features

- `branch` operations give every session a name, an ancestry, and an index — manageable through commands.
- `fork` hardens the native experience and provides the ancestry primitive.
- `squash` and `rebase` offer two forms of cross-branch merging.
- `send_message_by_branch` strengthens communication between sessions.
- The **branch** tab provides visual management of branches.

## Join us

What we want to build next:

1. **Branch-scoped project memory**. Existing long-term memory models are project-grained, which is a disaster for the branch model: memory leaks across branches and pollutes context. Branch-grained memory management is the road to a more robust model.
2. **Ongoing maintenance**. Open `Issues` — there are plenty of long-term improvements and bugs waiting.

We take an open stance on AI collaboration: feel free to use AI to contribute code, write commit messages, and draft PRs. But we expect you to own your code — review it yourself, and treat AI as your tool in communication rather than letting it talk to us on your behalf.

## License

[MIT](LICENSE)
