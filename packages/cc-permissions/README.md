# dsh-cc-permissions

Enforce Claude Code permission rules in DSH.

Reads `.claude/settings.json` (user `~/.claude`, project, and `settings.local.json`)
through the shared [dsh-cc-loader](../cc-loader) parse layer and folds the rules
**deny → ask → allow** on every tool call, exactly like Claude Code:

- `Tool` bare deny removes the tool from the model's context (per-agent hide)
- `Tool(spec)` scoped rules match commands, paths, domains, params, MCP tools
- Bash compound commands are split; wrappers (`timeout`, `nice`, `nohup`…) and
  leading env assignments are stripped before matching
- Read deny rules also gate Edit/Write tools and Bash file commands
  (`cat`, `head`, `tail`, `sed`…)
- `ask` rules route through DSH's approval service

## Read-only bridge

CC `settings.json` is a **read-only source**. DSH-side approvals ("don't ask
again") are stored in DSH's own config and are never written back to
`.claude/settings.local.json` — CC, Codex and DSH have different permission
semantics, so cross-tool permission sync is intentionally out of scope
(community `agents` / `cc-suite` do not sync permissions either).

## Install

```sh
dsh plugin --profile <name> add dsh-cc-permissions
```

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `hideDeniedTools` | `true` | Bare-name deny → per-agent `ctx.tools.restrict` |
| `enableDefaultMode` | `true` | `defaultMode=dontAsk` → approval policy `never` |
| `homeDir` | `<home>` | Home dir for `~/.claude/settings.json` |
| `projectRootMarkers` | `['.git']` | Project root discovery |

## License

MIT.
