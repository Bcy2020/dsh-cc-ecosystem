# dsh-cc-loader

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
