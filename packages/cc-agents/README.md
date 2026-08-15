# dsh-cc-agents

Load Claude Code **"first kind" agents** (`.claude/agents/*.md`) into DSH as
delegatable subagents with identity anchoring.

## What it does

CC agents are identity-anchored subagents: a frontmatter block
(`name` / `description` / `tools` / `disallowedTools` / `model` / `skills` /
`background` / `initialPrompt` …) plus a Markdown body that is the agent's
system prompt. DSH's subagent seam has no pre-registered agent directory, so
this adapter provides both halves:

1. **Catalog injection** — at every session start, a user-role message lists
   the available agents (`name: description`), reproducing CC's @-mention
   semantics: the model *sees* which agents exist and when to delegate.
2. **`cc_agent` delegation tool** — the model calls
   `cc_agent(agent, description, prompt)`; the adapter:
   - looks the agent up in the loaded IR catalog,
   - starts a subagent via `ctx.subagents.start(provider, …)` with
     `persona` = the agent body (DSH's native identity channel),
   - scopes the child's tools with `toolFilter` from `disallowedTools`
     (applied first) then `tools` (CC semantics; buckets like `Read`/`Bash`
     expand to DSH tool names, `mcp__…` names pass through),
   - preloads `skills` (frontmatter skill names → full skill bodies),
   - maps `model` → `agentOptions.model`, `background` → background job,
   - maps `initialPrompt` → prompt prefix.

## Config

| key | default | meaning |
|---|---|---|
| `provider` | `spawn` | `ctx.subagents` provider to delegate on (`spawn` / `fork`) |
| `toolName` | `cc_agent` | model-facing tool name |
| `injectCatalog` | `true` | inject agent catalog into session start |
| `enableRunInBackground` | `true` | expose `run_in_background` |
| `maxDepth` | `3` | absolute delegation-depth cap |
| `enableGlobal` | `true` | include global `~/.claude/agents` |
| `globalClaudeDir` | `~/.claude` | override global dir |

## Scope precedence

Project `.claude/agents/` beats global `~/.claude/agents/` on name clashes
(fail loud — a warning is logged). Plugin agents arrive with the plugin source
(M4).

## Classification (from dsh-cc-loader)

- `DIRECT` — delegatable.
- `ADAPTED` — delegatable with degraded fields (`memory`, unknown fields).
- `UNSUPPORTED` — fields DSH cannot honor (`hooks` / `mcpServers` /
  `permissionMode` — CC itself forbids these on plugin agents); the agent
  still delegates without them.
- `BLOCKED` — `isolation: worktree`; never offered for delegation.

## Install

```sh
dsh plugin --profile <p> add dsh-cc-agents
```

Dev checkout (hot user layer, `file:///` required on Windows):

```yaml
- insert:
    - id: cc-agents
      name: 'file:///C:/Users/.../packages/cc-agents/src/index.js'
      config: { provider: spawn }
```

## Requirements

- `@deepseek-ai/dsh-subagent` with an in-process provider (`spawn`) registered.
- `@deepseek-ai/dsh-jobs` + `@deepseek-ai/dsh-tool-jobs` only for background
  runs.

## License

MIT. Shared parse layer is `dsh-cc-loader` (MIT, part of this repo).
