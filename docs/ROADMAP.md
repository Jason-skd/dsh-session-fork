# ROADMAP — dsh-session-fork: Git-style conversation branching for DeepSeek Harness

Status: **v0.0.1 implemented** (ref layer shipped; see §2 and §4) · Upstream: source checkout of dsh at `/Users/skd/Documents/deepseek-harness` · Delivery form: standalone dsh plugin package

This document is the single source of truth for scope, milestones, and acceptance
boundaries. Agents and humans should treat each milestone's **Acceptance** section as
the definition of done. Update this file (not chat history) whenever scope changes.

---

## 1. Problem & Vision

Long-running coding projects advance in phases. During review of a completed phase,
questions arise ("why is this code written this way?"). Two bad options exist today:

- **Open a new session** — loses all conversation context.
- **Ask inside the working session** — pollutes the context that later phases depend on.

dsh already supports *anonymous* session forking (kernel primitive
`ctx.sessions.fork()`, a Web GUI branch button, and persisted parent lineage). What is
missing is the **git layer on top**:

> **Branches are named refs pointing at sessions.** Forking creates a child branch;
> the child's conclusions are compressed and *squashed* back into the parent branch so
> later phases see a clean summary instead of the whole review.

### Git → dsh concept mapping

| Git concept | dsh-session-fork realization |
|---|---|
| commit | session event (immutable, append-only log) |
| commit chain | one session log |
| parent pointer | session header `parentSession` + `seedLength` (already persisted by dsh) |
| branch (ref) | named entry in the plugin's branch registry → session id |
| fork | dsh `fork` at a turn boundary (already exists) |
| `merge --squash` | compact the child's post-fork region, append summary into the parent |
| tag / rebase / true merge | later milestones |

### Non-goals (for now)

- No true two-parent merge (dsh session logs are single-chain; merges will be modeled
  as merge events, not log grafting).
- No mid-turn forking (dsh restricts fork boundaries to turn ends; accepted).
- No automatic interception of review-style questions (candidate for v0.1.0+, not core).
- No changes to dsh core — everything ships as a plugin.

---

## 2. Milestones

### v0.0.1 — Branch registry (ref layer)

**Goal:** named branches exist, persist across restarts, and never corrupt or crash.

Deliverables:

- Plugin package skeleton (cordis plugin; installs into the web profile).
- Branch registry storage (via the storage-domain facility over `ctx.storage`:
  domain `dsh_session_fork`, table `branches`, one record per workspace keyed by the
  session's `cwd`). Record shape: `{ name, sessionId, forkOrigin:
  { parentSessionId, atSeq } | null, createdAt? }`. The root branch has
  `forkOrigin: null`.
- Slash commands (shipped set): `/branch <name>` or `/branch create <name>`
  (fork the current session at its last completed turn; cold sources are
  forked via the seeded `ctx.agents.create` path with the source's recorded
  preset composition and workspace attachment, mirroring the host's
  `session.fork`), `/branch adopt <name>` (adopt the current session as the
  workspace's root branch, `forkOrigin: null`), `/branch list`,
  `/branch rm <name> --yes` (explicit-flag confirm; never deletes session
  data), `/branch rename <old> <new>`.
- `/branch switch <name>` (open the referenced session) is **deferred to
  v0.0.2**: session switching needs GUI cooperation, which this milestone's
  zero-client-change boundary excludes.
- Dangling-ref policy: a branch whose session was deleted/archived is listed as
  dangling; deletion of the branch is explicit.

Acceptance:

1. Registry content survives a dsh restart.
2. Duplicate names, unknown branches, and dangling refs produce clear errors — no crashes.
3. `forkOrigin.atSeq` locates the exact fork message in the parent session.
4. Branches are scoped per workspace (cwd), matching dsh session storage scoping.
5. Host-side only; zero client-code changes in this milestone.

**Deferred TODO — branch name uniqueness scope:** branch names are currently
globally unique across the whole workspace record set (cwd-keyed registry).
Semantics to be discussed later:

1. Sub branches under the same root should not share a name.
2. Whether a branch adopted as root is also subject to the same-name
   restriction is undecided.
3. Sub branches under *different* roots should be allowed to share names
   (currently not allowed — bug / not yet aligned with the intended semantics).

v0.0.1 keeps the global-uniqueness rule as-is; revisit after the core
features ship.

### v0.0.2 — Branch visibility (UI layer)

**Goal:** a human can see the branch tree and where each fork happened.

Deliverables:

- Spike (time-boxed, first): client-plugin packaging path — how plugin UI code reaches
  the Web GUI bundle, including rebuild/refresh workflow on a source checkout.
- `/branch switch <name>` (deferred from v0.0.1): open the referenced session;
  now possible because this milestone owns the GUI cooperation it needs
  (likely by hooking the Web UI's existing fork/branch interactions).
- Session list: branch name labels; child branches stay nested under their parent
  (dsh already nests by `parentSessionId`).
- Fork origin indicator: "forked from `<parent>` @ message N" (anchor from the
  registry; cross-checkable against the child session's seed boundary).
- Parent-side indicator: which branches were forked from the current session.

Acceptance:

1. Names, nesting, and fork origins render correctly after page reload and host restart.
2. Clicking a branch opens its session.
3. Dangling branches render distinctly (not hidden, not crashing).
4. All UI states degrade gracefully when the registry is missing or partial.

### v0.0.3 — Squash merge

**Goal:** merge a child branch's outcome back into the parent as a compact, durable
summary — the workhorse merge method.

Deliverables:

- `/squash into <branch>` command, run from the child branch.
- Pipeline: wait for the child agent to go idle → compact the child's **post-fork
  region** (seed boundary through the end of the child surface) with a vendored
  `compactNow` shell that takes an explicit region parameter → read the compacted
  child surface → append into the parent the summary checkpoint; the checkpoint is
  itself the conclusion — the entire post-fork region is compressed, nothing is
  carried over verbatim.
- Deviation from the native seam (deliberate): official
  `ctx.compaction.compactRegion` requires an open turn, and command execution has
  none ("no turn wraps them" — interaction/commands/src/index.ts:308); official
  `compactNow` auto-selects its region from the head of the surface, which would
  swallow the inherited prefix. Hence the vendored compactNow shell (surgery:
  explicit region parameter), run idle under the agent's maintenance machinery.
- Merge provenance: recorded in the parent-appended checkpoint's plugin source —
  `MessageSourceMap` is merge-extensible — rather than a custom plugin merge event,
  because the official session-event vocabulary is closed to downstream plugins
  (`KNOWN_SESSION_EVENT_TYPES` is a generated set with no registration API, and
  append cannot write `ignorable`).
- Summarizer input: the child's **full** surface (inherited prefix + post-fork
  region) is fed to the model, with instructions delimiting the compaction target
  as the last M surface messages (M = region node count) and demanding that earlier
  established context be absorbed, not re-stated — no in-band marker text,
  preserving provider prefix caching.
- Parent-side write path: reuse the live agent if one exists in this process, else
  cold-resume it (`ctx.agents.resume`), append, flush; do not dispose afterward.
- Short-region fallback: a summary that would not shrink throws an error;
  TODO: v0.1.x error.message suggests rebase mode.

Acceptance:

1. Compaction covers exactly the post-fork region; the inherited prefix is untouched
   (verifiable by token counts before/after).
2. Parent context growth is bounded by the summary + conclusion, independent of child
   conversation length.
3. Squash succeeds when the child contains manually interrupted turns; the summary
   reflects the interruption honestly.
4. Squash succeeds when the parent is cold (host restarted) or live.
5. The parent log replays to a complete, valid request (model-visible means logged).
6. After squash, the child branch remains independently usable.

### v0.1.0+ — Ref hygiene & advanced merging (exploratory)

Candidate scope, deliberately unordered; each requires its own design note before work:

- Ref hygiene: move/rename/delete branch, dangling cleanup, optional fixed pointers
  (git-tag semantics). Update (2026-08-21, issue #23): rename/delete shipped as
  `/branch rename`/`/branch rm --yes` (v0.0.1) plus the branch-tab remove entry
  behind the official RiskConfirmation primitive (checkbox = `--yes` parity);
  dangling refs are removable from the demoted section the same way.
- Auto-review routing: intercept review-style follow-ups at `agent/pre-step` and
  redirect them into a fork, so the main branch's model never sees the question.
- Rebase: replay a child onto a parent's advanced head; requires stale-prefix
  detection and a conflict-resolution policy.
- Eventized registry: record branch mutations as session events for full replay
  consistency (audit-grade).

---

## 3. Engineering notes (cross-cutting)

- **Packaging:** npm package (or local `file:` dependency) added to the web profile's
  `dependencies` + `dsh.profile.bundles`. Avoid git dependencies (known to conflict
  with the profile's pnpm `onlyBuiltDependencies` whitelist).
- **Coordinates discipline:** dsh has two coordinate systems — event `seq` (log) and
  surface position (model-visible projection). Fork anchors are seqs; compaction
  ranges are surface positions. All conversions live in one helper, unit-tested.
- **Boundary discipline:** every fork/squash boundary is a closed turn end. Any closed
  turn — including manually interrupted ones — is a valid, balanced anchor (dsh
  guarantees pairing via synthetic closers). Open turns are never touched; wait for
  idle instead.
- **Compatibility:** declare the dsh session-event vocabulary version the plugin is
  built against; fail with a clear diagnostic on mismatch.
- **Testing:** every milestone ships replay tests (seed → rebuild → compare) using
  dsh's existing test-support fixtures; acceptance items above map 1:1 to test cases.

---

## 4. Changelog

- 2026-08-19 — Initial roadmap from design phase (research notes archived separately
  in Mnemon document `dsh-fork-fbe60543`; source-level evidence lives there, not here).
- v0.0.1 shipped — sync scope with implementation: command family is
  `/branch <name>`/`create`, `adopt`, `list`, `rm --yes`, `rename`;
  `/branch switch` deferred to v0.0.2 (needs GUI cooperation); registry
  storage clarified as the `dsh_session_fork` storage-domain (renamed from
  `dsh_fork`, 2026-08-20; record per workspace cwd, not one JSON file per
  workspace).
- 2026-08-21 — v0.0.3 squash scope locked (source-level evidence in Mnemon document
  `ca95142e`): vendored `compactNow` shell with an explicit post-fork region (native
  `compactRegion` requires an open turn; native `compactNow` would swallow the
  inherited prefix); the parent-appended checkpoint is itself the conclusion; merge
  provenance rides the checkpoint's plugin source (the official session-event
  vocabulary is closed to downstream plugins); a summary that would not shrink
  throws (rebase-mode hint deferred to v0.1.x).
- v0.0.3 shipped — sync scope with implementation: `/squash into <branch>` with
  the vendored compact engine (`src/vendor/compact.ts`, 2 surgeries) and the
  ensureSession kernel (`getOrResumeAgent` in `src/vendor/fork.ts`); pure logic
  in `src/squash.ts`, command wiring in `src/squash-command.ts`; acceptance
  items #1–#6 mapped 1:1 to tests (`tests/squash-e2e.test.ts`), 122 tests green;
  vendored against deepseek-harness@528c682e.
- 2026-08-21 — Issue #23 shipped: GUI remove branch. Host `removeBranch` RPC
  endpoint (the `/branch rm --yes` semantics over the RPC face; ref-only,
  dangling refs included) + branch-tab menu entry gated by the official
  RiskConfirmation primitive (acknowledgement checkbox = `--yes` parity,
  permission-presets pattern). Removal round trips carry the view's own
  sessionId for workspace resolution, so unresolvable dangling sessions are
  removable. 251 tests green.
