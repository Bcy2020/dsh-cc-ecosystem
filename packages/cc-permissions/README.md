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
- **`allow` rules answer the approval seam automatically** (see below)

## Allow = run without asking (approval seam)

In Claude Code an `allow` rule is the **complete gate**: the command runs without
any further question. DSH has a second layer below the permission fold — the
file sandbox. When `workspace-write` denies a file effect and the model retries
with `sandbox_permissions`, an `approval/request` is raised for the escalation;
without a bridge, that request would still hit the human answerer even though
the user already allowed the exact command.

`dsh-cc-permissions` bridges this: an `approval/request` (permission ask *or*
sandbox escalation) whose underlying tool call matches a CC `allow` rule is
answered `allowed-once` automatically — one-shot, rule-scoped, and read from
the **real tool arguments** in the session log (`tool/call` by `callId`, never
the model-written reason), mirroring the pattern of
[dsh-auto-approval-plugin](https://github.com/StyxNether/dsh-auto-approval-plugin).

- `Bash(pytest:*)` → the exact `pytest …` command may run outside the sandbox
  when escalated (CC semantics restored)
- deny/ask rules and unmatched calls always defer to the human answerer; the
  module only ever auto-grants, never auto-denies
- `enableAllProjectMcpServers: true` also covers project MCP tools
  (`mcp__<server>__<tool>`, not `mcp__plugin_…`)

Disable with `autoApproveAllowed: false` in the plugin config.

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
| `autoApproveAllowed` | `true` | `allow` rules auto-answer `approval/request` (incl. sandbox escalation) |
| `homeDir` | `<home>` | Home dir for `~/.claude/settings.json` |
| `projectRootMarkers` | `['.git']` | Project root discovery |

## License

MIT.
