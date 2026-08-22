/**
 * Browser-half dictionaries: the plugin's locale namespace, registered in
 * the client apply and read through the bound translator (tab label and
 * view states).
 * @module dsh-session-fork/src/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'dsh-session-fork'

/** The plugin dictionary key set (source of truth for both locales). */
export type ForkLocaleKey =
  | 'view.branches'
  | 'state.loading'
  | 'state.error'
  | 'state.retry'
  | 'state.empty'
  | 'state.dangling'
  | 'menu.fork'
  | 'menu.squash'
  | 'menu.remove'
  | 'toast.forked'
  | 'toast.squashed'
  | 'toast.removed'
  | 'remove.title'
  | 'remove.description'
  | 'remove.acknowledge'
  | 'remove.cancel'
  | 'remove.confirm'
  | 'remove.failed'
  | 'squash.title'
  | 'squash.description'
  | 'squash.placeholder'
  | 'squash.confirm'
  | 'fork.title'
  | 'fork.description'
  | 'fork.placeholder'
  | 'fork.cancel'
  | 'fork.confirm'
  | 'fork.close'
  | 'fork.invalid'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The branches graph tab label and its states. */
    'dsh-session-fork': ForkLocaleKey
  }
}

/** Simplified Chinese dictionary. */
export const zh: Record<ForkLocaleKey, string> = {
  'view.branches': '分支',
  'state.loading': '加载分支图…',
  'state.error': '分支图加载失败',
  'state.retry': '重试',
  'state.empty': '还没有分支。试试 /branch create <name>',
  'state.dangling': '悬空分支(会话已缺失):',
  'menu.fork': '从此处 Fork',
  'menu.squash': 'Squash 到分支',
  'menu.remove': '删除分支',
  'toast.forked': '已创建分支 ',
  'toast.squashed': '已 squash 到分支 ',
  'toast.removed': '已删除分支 ',
  'remove.title': '删除分支',
  'remove.description': '只删除分支引用,会话数据永不删除;会话仍可正常打开。此操作不可撤销。',
  'remove.acknowledge': '我了解此操作只删除分支引用且不可撤销',
  'remove.cancel': '取消',
  'remove.confirm': '删除分支',
  'remove.failed': '删除分支失败:',
  'squash.title': 'Squash 到分支',
  'squash.description': '输入目标分支名(当前仅支持本分支的父分支),本分支的独有历史将压缩为一条摘要合并过去。',
  'squash.placeholder': 'squash 到 ',
  'squash.confirm': 'Squash',
  'fork.title': 'Fork 到命名分支',
  'fork.description': '分支名将成为新会话的标题,且在本工作区内唯一。',
  'fork.placeholder': '分支名',
  'fork.cancel': '取消',
  'fork.confirm': 'Fork',
  'fork.close': '关闭',
  'fork.invalid': '无效的分支名:',
}

/** English dictionary. */
export const en: Record<ForkLocaleKey, string> = {
  'view.branches': 'Branches',
  'state.loading': 'Loading branch graph…',
  'state.error': 'Failed to load the branch graph',
  'state.retry': 'Retry',
  'state.empty': 'No branches yet. Try /branch create <name>',
  'state.dangling': 'Dangling branches (session missing):',
  'menu.fork': 'Fork from here',
  'menu.squash': 'Squash into branch',
  'menu.remove': 'Remove branch',
  'toast.forked': 'Forked branch ',
  'toast.squashed': 'Squashed into branch ',
  'toast.removed': 'Removed branch ',
  'remove.title': 'Remove branch',
  'remove.description': 'Removes the branch ref only — session data is never deleted and the session stays openable. This cannot be undone.',
  'remove.acknowledge': 'I understand this removes the branch ref only and cannot be undone',
  'remove.cancel': 'Cancel',
  'remove.confirm': 'Remove branch',
  'remove.failed': 'Failed to remove branch: ',
  'squash.title': 'Squash into branch',
  'squash.description': 'Enter the target branch name (currently the parent branch of this one); this branch\u2019s own history is squashed into one summary there.',
  'squash.placeholder': 'squash into ',
  'squash.confirm': 'Squash',
  'fork.title': 'Fork to a named branch',
  'fork.description': 'The branch name becomes the new session\u2019s title and must be unique in this workspace.',
  'fork.placeholder': 'Branch name',
  'fork.cancel': 'Cancel',
  'fork.confirm': 'Fork',
  'fork.close': 'Close',
  'fork.invalid': 'Invalid branch name: ',
}
