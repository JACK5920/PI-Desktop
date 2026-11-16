# PI Memory plugin

Three-tier durable memory for PI-Desktop agents, implemented as a plugin plus
a small Host workspace-identity correction so a known no-project session cannot
fall back to a different visible project.

## Layout

- `main.js` - lifecycle, agent tools, panel channels, event subscriptions.
- `lib/text.js` - normalization, CJK bigram tokens, Jaccard, data escaping.
- `lib/store.js` - single-writer JSONL store, dedupe by key, archive/permanent
  purge semantics, tier-1 builder, controlled-block injection.
- `lib/recall.js` - scope filtering, multi-signal ranking, result dedupe.
- `skills/memory.md` - tells the agent when to use the memory tools.
- `panel/index.html` - memory console.

## Data

- Human-readable source of truth: `<workspace>/.pi/memory/store.md`.
- Legacy `.pi/memory/store.jsonl` is imported once when the Markdown store is
  first initialized, then cleared only after the Markdown write succeeds.
- Each memory body is ordinary Markdown inside a managed entry block. Edit the
  body between the start/end comments; metadata (including stable `id` and
  dedupe `key`) stays in the adjacent HTML comment. Do not remove the markers.
- Generated human-readable projections: `TIER1.md` and `MEMORY.md`.
- User-level layers: plugin `settings.json` (`profile`, `userMemory`).
- Structured global memories are stored in the plugin's persistent settings
  (`globalEntries`), shared across projects; the Markdown store is workspace
  scoped. Legacy workspace entries marked `scope: global` are moved into the
  global settings once on plugin load.
- `autoCaptureMemory` (default on) puts the verified-memory capture policy in
  the prompt; users can turn off proactive captures while retaining explicit
  remember requests and corrections.
- Injection: a `<!-- pi-memory:tier1:begin -->` / `end` block appended to
  `.pi/APPEND_SYSTEM.md`; user-authored content outside the block is preserved.
- `memory_forget` and panel **归档** retain history. `memory_purge` / **永久删除**
  removes the item from the store, managed projections, and plugin-managed
  recovery copies. A failed purge is retryable and is not success until all
  managed projections have been refreshed.
- Export includes user-level settings; import restores them only after
  validation. Previously exported files outside the plugin remain user-owned.
- The status count is **回合结束标记**, not extracted-memory tasks. The host's
  `session:turnEnded` event has no transcript, so this plugin does not perform
  automatic transcript extraction.
- The agent is instructed to remember verified reusable decisions, corrections,
  fixes, conventions, and pitfalls after substantive work. It chooses `project`
  for repository-specific knowledge and `global` only for cross-project user
  facts; it does not save every turn or raw transcript.
- **刷新常驻摘要** regenerates Markdown projections and the prompt block; no
  vector index is built. Recall is lexical/tag based, not semantic search.
- The Memory panel is the primary settings surface for capture/injection,
  summary budget, decay, and global profile. The similarly named host settings
  page fields were consolidated into the panel; existing persisted values are
  retained and merged with plugin defaults.
- Session-scoped entries are kept in the project store but are excluded from
  shared project projections and are recalled only by their owning session.
- With no project open, global settings-backed memories remain available for
  save/list/search/export; project/session writes are rejected clearly. Global
  memory is not injected into a workspace prompt until a project is open.

## Loading

Plugins -> Load development plugin -> select this directory -> review and
grant the declared permissions. `APPEND_SYSTEM.md` is read when the host
prepares a runtime launch. A changed prompt retires a cached runtime so the
**next prompt** is recomposed from the new file; it does not rewrite the prompt
of a model turn already in progress, and it does not require starting a new
chat session.

## Validate

From the plugin directory, with the repository toolchain installed:

```bash
pnpm pi-plugin check .
pnpm pi-plugin pack .
node --check main.js
```

When the pnpm shim is unavailable, the built CLI works directly from the
repository root, where `node_modules` is provisioned:

```bash
./node_modules/.bin/pi-plugin check <plugin-directory>
node packages/plugin-devkit/dist/cli.js pack <plugin-directory>
```

The plugin package itself is written to `dist/`, which is ignored by git.

## P0 limits

No automatic transcript extraction: `session:turnEnded` carries no message
body, so it only appends a marker to `pending.jsonl`. Writes go through
`memory_remember` or the panel. `pi.fs.writeText` is not atomic; read failures
are surfaced, malformed legacy JSONL or Markdown blocks writes/migration rather
than silently dropping data, and permanent purge is idempotent so a partial
failure can be reconciled by retrying it.

## Local regression tests

```bash
node --test test/memory.test.js
node --check main.js
node --check lib/store.js
node --check lib/recall.js
```
