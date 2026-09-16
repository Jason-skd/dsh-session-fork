# dsh-session-fork

[English](../README.md) | 简体中文

`dsh-session-fork` 为 `DeepSeek Harness` 引入了类似 Git 的 branch 模型，让多个规模较大、相对独立的任务可以在不同的 dsh 会话中并行进行。

与其把所有任务都放在一个线性的对话中，每个任务都可以在自己的 branch 中独立推进。当工作准备合并时，可以使用 `squash` 和 `rebase` 将这些工作重新汇聚到统一的历史中。

本项目是 `DeepSeek Harness` 的插件，无法独立运行。

![branch_tab](media/branch_tab.png)

## 为什么用 branch 进行并行开发？

branch 模型对应了程序员已经通过 Git 处理并行工作的方式。

当多个大型任务并行开发时，每个 branch 都可以独立推进，而不需要立即解决所有变化之间的冲突。当工作准备就绪后，可以通过 `squash` 和 `rebase` 等操作重新汇聚这些 branch。

这提供了一种对应关系：

**并行开发 → 统一历史**

目标是在让并行开发变得可行的同时，仍然能够将最终工作重新组织成一致的历史。

## Branch 不是 sub-agent

Branch 和 sub-agent 解决的是不同的问题。

Branch 适用于多个规模较大、相对独立、需要分别推进的任务。它并不只是把一个大型任务拆分成几个更小的任务。

Sub-agent 仍然适合小型、轻量级的任务。对于不需要独立的长期运行会话的工作，sub-agent 在上下文成本方面可能更加合适。

两种方式也可以结合使用。Sub-agent 可以继续作为工作流的一部分，而 branch 则为更大型的并行任务提供更加清晰的边界。

## 在 agent 工作时继续思考

这个项目的一个实际动机，是减少使用单个 agent 会话时可能产生的等待时间。

关于 vibe coding，有一个常见的玩笑：

> 聊一次，然后花十分钟刷手机。

通过并行 branch，可以在一个对话完成之前继续处理其他任务，而不必一直等待。

根据维护者的实际经验，大约 **5 倍的 token 消耗带来了大约 4 倍的效率**。

这种方式的代价是增加 token 使用量，换取多个任务能够持续推进。

## 让 AI 管理会话

独立会话比 sub-agent 更难管理。

它们并不会天然绑定到主会话，其生命周期和身份也更难追踪。dsh-session-fork 通过以下方式解决这一问题：

- 提供完整的 branch 管理命令。
- 为这些命令提供 agent 可调用的 tool 版本。
- 提供管理 branch 会话的推荐治理方式。

目标是让开发者不需要手动处理会话管理的细节。AI 可以负责 branch 的生命周期和协调，而开发者则专注于当前的工作。

## DeepSeek Harness 集成

dsh-session-fork 的设计目标是使用 dsh 已有的能力，而不是创建一个独立的会话生态。

项目采用 pattern-mimic 和 vendor 的方式与 dsh 进行集成。

例如，`squash` 操作会生成一个 summary message，并保持与 dsh 的 `compact` 风格 summary 行为兼容。

Sub-agent 也可以继续与基于 branch 的工作流一起使用。

## AI secretary 方向

Branch 模型也为 **AI secretary** 工作流提供了可能。

Root branch 可以维护一个看板和干净的上下文，而 AI 则负责协调开发者当前的任务以及它们之间的衔接。

Secretary 可以组织开发者的工作流和习惯，同时保留管理开发过程所需要的操作能力。

长期方向是让 AI 专注于任务编排和协调，而开发者专注于当前正在进行的工作。

这是项目 **v0.3.0 AI secretary** 方向的一部分。

## 一分钟体验

安装（需要基于 web 应用的 dsh profile）：

```sh
dsh plugin --profile web add dsh-session-fork
```

之后，让 agent 自由使用该插件即可。所有命令都提供了 agent 可调用的 tool 形式。

## 核心功能

- `branch` 操作让每个会话拥有名称、祖先关系和索引，并提供相应的管理命令。
- `fork` 强化原生体验并提供祖先源语。
- `squash` 和 `rebase` 提供两种跨 branch 合并方式。
- `send_message_by_branch` 强化会话之间的通信。
- **branch** 页面提供 branch 的可视化管理。

## 加入我们

我们想继续提供的功能：

1. **基于 branch 的项目记忆管理**。现有的长期记忆模型以项目为粒度，可能导致记忆跨 branch 泄漏并污染上下文。branch 粒度的记忆管理旨在让模型更加健壮。
2. **持续维护**。打开 `Issues`，可以找到等待贡献的长期改进和 bug。

我们对 AI 协作持开放态度：欢迎自由地使用 AI 贡献代码、撰写 commit message 和 PR。但我们希望你对自己的代码负责，亲自进行 review，并在沟通中把 AI 当作工具，而不是让 AI 直接代表你与我们交流。

## License

[MIT](../LICENSE)
