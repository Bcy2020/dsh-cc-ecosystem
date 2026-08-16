# dsh-cc-mcp

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
