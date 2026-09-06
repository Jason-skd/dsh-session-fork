# 工作区治理 — dsh-session-fork × git worktree

> 本文件是本工作区所有 session 的治理基线，对所有 branch 生效，包括从其他 branch 继承的对话历史。
>
> 如果你没有在使用 DeepSeek Harness，或未启用 dsh-session-fork 插件，请忽略本治理。

## 定义

- session branch: 由 dsh-session-fork 插件创建并管理的 branch 形态 session。
- root branch: 用户第一个产生对话的 branch，通常对应 git main（代码中 `forkOrigin` 为 null）。
- forked branch: 所有非 root branch，负责具体工作；通常由 root branch fork 产生，也可以由其他 forked branch fork 产生。

**说明**：forked branch 可以继续 fork 出新的 forked branch 处理支线任务，形成多层结构。fork 关系中，fork 发起方称为 fork 来源；root branch 是整条 fork 链的起点。

## 治理核心

无论规则是否明文写出，本文件的所有规则都服务于三个核心思想：

1. 降低上下文污染
2. 高效并行开发
3. 模拟人类协作办公模式：各 branch 并行开发、互不撞车，由管理员合并

## 分支与 worktree

- 一个 session branch ⇔ 一个同名 git branch ⇔ 容器目录下同名 worktree（`/` → `-`）。
- root branch 始终保持开发者秘书的身份：任何可能污染上下文的行为（如写代码、深度调研），都应主动 fork 新的 branch 交由它处理。
- forked branch 遇到支线任务时同理：与当前任务相关性不高、任务量足够大、且阻塞当前任务（比如写 feat 时发现必须先进行 fix，否则会影响后续的代码复用或风格），应当从自己 fork 一个新的 forked branch。

## 权限

- 只有 root branch 拥有 gh 写操作权；forked branch 均有 gh 读操作权，同时在各自 git branch 上拥有无限权力（push、rebase、force-push）。
- 跨分支 git 操作权（merge、rebase、squash）只属于 fork 发起方：root branch 对任何 forked branch，forked branch 对自己 fork 出的 branch；被 fork 的一方没有反向操作权。

## 创建

- fork 发生后，新产生的 forked branch 主动检查 worktree 是否存在，缺失即创建，同时补写 `.code-workspace` 文件，把新 worktree 加入 VS Code 的 workspace。
- 需要 dsh 原生 sub agent 的场景，总是可以放心迁移为 forked branch。

> 注意：`.code-workspace` 始终由 forked branch 各自编辑，容易出现竞态。

## 合并与收尾

- 工作完成后，forked branch 主动向 fork 来源执行 session 层 squash（`squash_into` <fork 来源>）；若 compact 不出有效信息，可以改用 `rebased_into`。确认 squash 到位后，通过 `send_message_by_branch` 要求 fork 来源处理交付，git 层 branch 操作由 fork 来源执行。
- 开发者确认收尾时，forked branch 负责清理自己的 worktree 和本地 git branch，同时清理 `.code-workspace` 文件中对应的 worktree 条目；fork 来源负责回收（rm）它的 session branch。

## 消息与沟通

`send_message_by_branch` 工具推荐用于以下场景：

1. forked branch 交付工作：紧接 squash 操作，要求 fork 来源处理分支间操作。
2. forked branch 为支线任务 fork 新 branch 时：用最简短的语言描述需求。（牢记新 branch 会**完全**继承你的上下文，你知道的它也都知道，不需要交代任何 context。）
3. forked branch 需要决策支援：需要 fork 来源决策时，先 squash 自己，再用最简短的语言提问；需要用户决策时，建议直接用 `send_message_by_branch` 发给 fork 来源提醒用户，不需要 squash，让用户直接在这个 branch 上处理。

## 常见场景的处理流程

### 用户要求处理一个 issue

1. root branch: 给任务命名，按照仓库分支名习惯创建 session branch。
2. root branch: 用 `send_message_by_branch` 唤醒新建的 branch（fork 不继承当前 turn 的上下文，消息需要点名要处理哪个 issue；但如何处理应由 forked branch 自己思考，root branch 不应额外调研并输出行动指南）。
3. forked branch: 创建同名 git branch 与 git worktree，修改 `.code-workspace` 文件。
4. forked branch: 依照用户自己的治理习惯，或是直接行动，或是按要求开始调研。
5. forked branch: 行动完成，squash 回 root branch。
6. forked branch: 用 `send_message_by_branch` 唤醒 root branch，说明自己已交付（squash 已到位，root branch 已明白发生了什么，也有能力推断出下一步要怎么做，这里只做唤醒，不需要传递待办）。
7. root branch: 判别任务类型，提 PR 或 git merge。
8. root branch: 向用户汇报，给出当前进度的看板。

> 注意：除非任务本身就是调研，否则调研只是代码行动的附属品。
>
> 1. **不需要**先/额外启动一个只负责调研的分支。
> 2. forked branch 调研完**不需要**直接回报 root branch，静候和用户继续深度讨论/接受行动指令即可。

该流程同样适用于用户口述的一个需求。

### PR 已合，用户要求清理本地环境

1. root branch: 明确用户指的是哪些 branch。
2. root branch: 用 `send_message_by_branch` 要求 forked branch 做环境清理。
3. forked branch: 清理 git worktree 与 git branch，修改 `.code-workspace` 文件。
4. forked branch: 用 `send_message_by_branch` 回报 root branch 清理结束，请求回收 session branch。
5. root branch: 执行 session branch 的回收，本地环境干净。
