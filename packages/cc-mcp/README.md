# dsh-cc-mcp

> [!IMPORTANT]
> **Only upgrade to this version when upgrading DSH to `0.1.5-rc.2` or later.**
> It binds to the 0.1.5 host contracts (`^0.1.5-rc.2` peer ranges for
> `dsh-subprocess` / `schemastery`) and **does not work on older DSH**. If your
> DSH is still `0.1.0-rc.7`–`0.1.1-rc.2`, **do not upgrade** — stay on `v0.1.x`.
> The two lines are mutually exclusive.

Load Claude Code MCP server configs into DeepSeek Harness as **runtime-registered
tools** — no config-row writes, no restarts for config changes.

把 Claude Code 的 MCP 配置(`.mcp.json` / plugin.json 内联 `mcpServers`)以运行时注册工具的形式加载进 DSH。

## What it does

| Source | Tool namespace | Notes |
|---|---|---|
| Project root `.mcp.json` | `mcp__<server>__<tool>` | DSH-native name, same as `dsh-mcp-client` rows |
| Plugin root `.mcp.json` / `plugin.json` inline | `mcp__plugin_<name>_<server>__<tool>` | Official CC plugin naming (e.g. `mcp__plugin_asana_asana__asana_create_task`) |

- **Dual-form parsing** (shared `dsh-cc-loader`): accepts both the
  `{"mcpServers": {...}}` wrapper (project level / community plugins) and the
  bare server map (official plugin form).
- **Transports**: `stdio` (command) and `http` (url → streamable-http) register
  as tools. `sse` / `ws` are reported as unsupported (DSH has no such
  transport) and never crash anything.
- **Env secrets stay out of configs**: `${NAME}` placeholders are kept verbatim
  in the IR and expanded at runtime from `process.env`; `${CLAUDE_PLUGIN_ROOT}`
  expands to the plugin directory. Nothing is written to disk.
- **Lazy connections**: tool schemas register eagerly (the model must see the
  list), the actual server process connects on first call, and disconnects
  after `idleTimeoutMs` without calls. Dead connections reconnect on the next
  call.
- **Hot reload**: editing the project `.mcp.json` rebuilds running sessions'
  project MCP surface (~1 s).
- **Conflict semantics**: a server already provided by a preset/host
  `dsh-mcp-client` row is skipped by default; `"override": true` in the server
  entry forces the project/plugin connection (agent layer shadows upper
  layers).
- **Management panel (`/mcp`)**: every server keeps a status row
  (connected / failed / disabled / provided-by-host) with its tool list. The
  Web GUI's `/mcp` command opens a panel over those rows: a failed server shows
  a **Connect** button, a connected one can be re-checked, each row opens a
  detail view with the server's tools, and **Disable** hides that server from
  the model until you enable it again. The session's start-up self-check reports
  failures as auto-dismissing toasts.
- **Host MCP rows are listed too** (`manageHostRows`, on by default): the
  profile's own `@deepseek-ai/dsh-mcp-client` instances (github, fetch, …) appear
  with the tools the host really exposes. Acting on them is **workspace-scoped and
  never rewrites the profile config**: Disable hides that row's `mcp__<server>__*`
  tools for this workspace only (via the platform's `tools.restrict({ deny })`,
  lifted again on Enable), and Connect adopts a row that exposes nothing by
  connecting with that row's own config and registering its tools inside the
  session scope.

## Trust model ⚠️

`.mcp.json` is **executable project content** — the same trust as
`package.json` scripts. Installing this plugin enables that. Children run with a
scrubbed environment (credential-shaped and stale `DSH_*` variables dropped),
mirroring the official bridge.

## Install (dev / local checkout)

```sh
# in packages/cc-mcp: install deps (official MCP SDK + shared loader)
npm install

# user patch layer (hot, no bundle reconcile):
# append to ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: cc-mcp
      name: 'dsh-cc-mcp'
      config:
        enableProject: true
        pluginRoots: []          # absolute paths to plugin dirs (future M4 feeds this)
        idleTimeoutMs: 300000
        toolCallTimeoutMs: 60000
        watchProject: true
```

Windows absolute paths in `pluginRoots` need `file:///`? No — these are plain
directory paths inside the config, not module specifiers.

## Config

| Field | Default | Meaning |
|---|---|---|
| `enableProject` | `true` | read `<projectRoot>/.mcp.json` per session |
| `pluginRoots` | `[]` | extra plugin directories to scan (`.mcp.json` + `plugin.json`) |
| `idleTimeoutMs` | `300000` | idle disconnect (0 = never) |
| `toolCallTimeoutMs` | `60000` | per-call timeout |
| `watchProject` | `true` | hot-reload the project `.mcp.json` |
| `projectRootMarkers` | `['.git', '.dsh', '.claude']` | directory names that mark a project root when walking up from the session cwd; the first ancestor containing any marker wins. `.dsh` / `.claude` let projects without a `.git` repo still resolve their root |
| `enableManager` | `true` | register the `/mcp` command and the panel's `/cc-mcp` route |
| `manageHostRows` | `true` | list the profile's `@deepseek-ai/dsh-mcp-client` rows in the panel (disabling one only hides its tools in this workspace) |
| `statePath` | `''` (→ `<projectRoot>/.dsh/cc-mcp-state.json`) | explicit state-file override; empty keeps decisions per workspace (machine-wide file only when the session has no project root) |

## Management panel

`/mcp` (bare) opens the panel in the Web GUI; `/mcp <anything>` prints the text
report instead, and the same report is what a headless/CLI session gets.

| Status | Meaning | Panel |
|---|---|---|
| `ready` | connected and its tools are visible | ✓ — click to re-check |
| `error` | the connection failed (host rows say whether Connect can adopt it) | `Connect` button, error text in the detail view |
| `disabled` | disabled in this workspace | `Enable` button |
| `skipped` | another layer already registers this tool prefix | shown as host-provided, with the visible tools |
| `checking` | a check/connect is in flight | spinner |

| Scope | Where it comes from | Disable does |
|---|---|---|
| `Project` | `<projectRoot>/.mcp.json` | unregister this plugin's tools for that server |
| `Plugin` | `pluginRoots` (plugin `.mcp.json` / `plugin.json`) | same, under `mcp__plugin_<plugin>_<server>__` |
| `Host` | the profile's `dsh-mcp-client` rows | hide that row's tools **for this workspace only** (`tools.restrict({ deny })`, lifted on Enable) — the profile config is never rewritten |

`Connect` on a host row that exposes no tools **adopts** it: this plugin connects
with that row's own config and registers the tools inside the session scope, so a
row whose own connection failed still gives this workspace working tools.

Decisions are remembered in `<projectRoot>/.dsh/cc-mcp-state.json` (per workspace;
`$DSH_HOME/cc-mcp-state.json` only for sessions without a project root), which is
the **only** file this plugin writes — your `.mcp.json`, the profile config and
Claude Code settings are never touched. Add `.dsh/` to the project's `.gitignore`
if you do not want to share the choices.

## Try the panel locally

A throwaway project config used to exercise the panel end to end (one server that
connects, one that fails so `Connect` has something to do):

```json
{
  "mcpServers": {
    "cc-echo": { "command": "node", "args": ["<repo>/packages/cc-mcp/test/mcp-echo-server.mjs"] },
    "cc-flaky": {
      "command": "node",
      "args": [
        "<repo>/packages/cc-mcp/test/mcp-flaky-server.mjs",
        "<repo>/.cc-mcp-marker"
      ]
    }
  }
}
```

`cc-flaky` refuses to start until `<repo>/.cc-mcp-marker` exists; create it and
press **Connect** to watch the row flip to connected.

## Example

`<project>/.mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

Sessions in that project get `mcp__github__create_issue` etc. on first tool
list assembly.

## License

MIT — runtime registration pattern ported from
[dsh-project-mcp-bridge](https://github.com/KYinCode/dsh-project-mcp-bridge)
(MIT, © KYinCode); parsing lives in `dsh-cc-loader`.
