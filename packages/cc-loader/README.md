# dsh-cc-loader

> [!IMPORTANT]
> **Only upgrade to this version when upgrading DSH to `0.1.5-rc.2` or later.**
> `v0.2.0` adds the session event-log compatibility boundary
> (`sessionEvents` / `sessionEventAt` / `sessionLastEvent`) required by the
> 0.1.5 host. Earlier DSH releases do not have the readers it targets. If your
> DSH is still `0.1.0-rc.7`–`0.1.1-rc.2`, **do not upgrade** — stay on `v0.1.x`.
> The two lines are mutually exclusive.

Shared parse layer for the dsh-cc ecosystem: parses Claude Code `.claude/` assets (project + global `~/.claude`) **and Claude Code plugins** (`plugin.json` / `marketplace.json` / plugin root) into a standalone in-memory IR.

- **Memory IR, zero-write path**: nothing is written to disk; the source of truth stays the `.claude` files and plugin manifests themselves, so DSH stays in sync with Claude Code.
- **Component classification**: every component is DIRECT / ADAPTED / UNSUPPORTED / BLOCKED; unsupported and blocked components never reach the adapters.
- **Permission engine**: CC `settings.json` allow/deny/ask rule parsing and deny → ask → allow folding (bare names, command globs, path anchors, domains, params, skill/agent names).
- **Plugin discovery (M4)**: `parsePluginManifest`, `parseMarketplace`, `discoverPluginRoot` (single entry point inventorying a plugin's skills/commands/agents/mcp/lsp/hooks), `discoverMarketplace`, `pluginComponentName` (`plugin-<plugin>-<component>` DSH-safe namespacing).

Consumed by [dsh-cc-skills](../cc-skills), [dsh-cc-permissions](../cc-permissions), [dsh-cc-agents](../cc-agents), [dsh-cc-hooks](../cc-hooks) and [dsh-cc-mcp](../cc-mcp).

## Install

```sh
npm install dsh-cc-loader
```

## Quick use

```js
import { loadClaude } from 'dsh-cc-loader'

const ir = await loadClaude({ cwd: process.cwd(), pluginRoots: ['/path/to/my-plugin'] })
console.log(ir.report)              // DIRECT/ADAPTED/UNSUPPORTED counts
console.log(ir.components.plugins)  // per-plugin IR blocks
```

MIT — discovery logic derived from [dsh-claude-compat](https://github.com/biedongbin/dsh-claude-compat) (MIT, © biedongbin).
