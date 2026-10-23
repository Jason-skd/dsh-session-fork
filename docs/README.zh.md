# dsh-session-fork

`0.4.0` 支持 dsh `0.2.1-rc.2`，替代原先的 dsh `0.1.2-rc.1` 兼容线；请先升级 dsh，再升级本插件。

兼容性开发：先构建旁边的 `../deepseek-harness`，再运行 `bun run test:harness`；可通过 `DSH_HARNESS_DIR` 指定其他目录。检查使用隔离副本连接真实宿主包，覆盖 V4 消息、历史合并记录及 Host、Client 两面的类型。

[English](../README.md) | 简体中文

Sub agent 与 并行开发在当前 agent 应用上表现总是不尽人意。本项目以 git 的 branch 式管理 dsh 原生的离散的 会话，通过提供 `fork` 会话继承和 `squash`、 `rebased` 会话合并，极大提升了在 dsh 上并行开发和提示词管理的体验。

本项目是 `Deepseek Harness` 的插件，无法独立运行。

![branch_tab](media/branch_tab.png)

## 解决痛点

- **高效的单人并行开发**：branch 模型模拟了真实程序员协作。并行开发时，所有 agent 持有独立的仓库快照。用解决合并时冲突替代必须线性的开发历史。
- **干净的上下文管理**：主 branch（e.g. `main`）充当秘书角色，维持调度者身份。所有调研/代码任务派分给 child branch 完成。任务完成后仅将压缩后的上下文回报给主分支。
- **强化的会话管理**：依据引入的 branch 模型，强化了 dsh 原生的 `fork` 和跨会话 `send_message` 体验。

## 一分钟体验

安装(需要基于 web 应用的 dsh profile):

```sh
dsh plugin --profile web add dsh-session-fork
```

之后，您可以直接让 agent 自由使用该插件——我们的所有命令都提供了 agent 可调用的 tool 形态！

## 核心功能

- `branch` 操作让每个会话具名，有祖先，易索引，可通过命令管理。
- `fork` 强化原生体验并提供祖先源语。
- `squash`, `rebase` 提供跨分支合并的两种形态。
- `send_message_by_branch` 强化了会话间交流。
- “分支”页对 branch 的可视化管理。

## 加入我们

我们想继续提供的功能:

1. **基于 branch 的项目记忆管理**。现有的长期记忆模型都以项目为粒度,对 branch 模型是灾难——记忆跨 branch 泄漏,直接污染上下文。branch 粒度的记忆管理是让模型更健壮的必经之路。
2. **持续维护**。点开 `Issues`，还有很多 Long Term 强化和 bug。

我们对 AI 协作持开放态度:欢迎自由地用 AI 贡献代码、撰写 commit message 和 PR。但我们希望您对自己的代码负责,亲自 review,并在沟通中把 AI 当作您的工具,而不是让 AI 直接代表您与我们对话。

## License

[MIT](../LICENSE)
