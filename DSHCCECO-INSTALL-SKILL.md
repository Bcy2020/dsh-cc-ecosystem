---
name: dsh-cc-ecosystem-install
description: |
  Install and hot-mount the dsh-cc-ecosystem plugin family (cc-loader, cc-skills, cc-permissions, cc-agents, cc-hooks, cc-mcp) into a running DeepSeek Harness (DSH) Web profile through the cordis.patch.yml file:/// layer — surfacing Claude Code .claude/ assets (skills, commands, rules, permissions, agents, hooks, MCP servers) and Claude Code plugins (plugin.json / .mcp.json / skills / agents, namespaced plugin-<plugin>-<component>) in DSH. Use whenever the user asks to install, hot-load, hot-mount, mount, or test this plugin family or their own DSH plugin from a local checkout, even if they do not name the plugin explicitly.
---
# Install dsh-cc-ecosystem into DSH (hot-mount)

把 dsh-cc-ecosystem 插件族（Claude Code `.claude/` 资产加载器 + Claude Code 插件加载器）热装载进正在运行的 DSH Web profile。全部步骤走 `cordis.patch.yml` 用户补丁层，不重建 bundle、不重启 GUI。

## 前提

- DSH_HOME 的 profile 目录：`~/.dsh/profiles/<profile>/`（Web GUI 通常用 `web`，如 `C:\Users\<you>\.dsh\profiles\web`）
- 插件本地 checkout 在工作区内，例如 `<workspace>\dsh-cc-ecosystem`
- 运行中的 DSH 实例的 profile node_modules（含全部 `@deepseek-ai/*`、`yaml`、`@modelcontextprotocol/*`）— 本机为 `~/.dsh/profiles/node_modules`
- 会话/验证工作区需要有 `.git` 项目根标记（插件按 `.git` 向上发现 `.claude`）；没有就建一个空 `.git` 目录

## 1. 依赖解析：junction hub（file:/// 挂载的必需步骤）

`file:///` 直接挂载的插件，其 `import` 按**插件文件位置向上**解析 node_modules，看不到 profile 已装的包。在 checkout 旁建 junction hub：

```powershell
# <workspace>\node_modules\ 下（缺的包，profile 里没有的）：
New-Item -ItemType Directory -Force -Path "<workspace>\node_modules\@deepseek-ai", "<workspace>\node_modules\@modelcontextprotocol" | Out-Null
New-Item -ItemType Junction -Path "<workspace>\node_modules\yaml" -Target "<profile-node_modules>\yaml" | Out-Null
New-Item -ItemType Junction -Path "<workspace>\node_modules\@modelcontextprotocol\sdk" -Target "<profile-node_modules>\@modelcontextprotocol\sdk" | Out-Null
New-Item -ItemType Junction -Path "<workspace>\node_modules\@deepseek-ai\dsh-hook-protocol" -Target "<dsh-checkout>\packages\hooks\hook-protocol" | Out-Null

# <checkout>\node_modules\ 下：
New-Item -ItemType Directory -Force -Path "<checkout>\node_modules" | Out-Null
New-Item -ItemType Junction -Path "<checkout>\node_modules\@deepseek-ai" -Target "<profile-node_modules>\@deepseek-ai" | Out-Null
New-Item -ItemType Junction -Path "<checkout>\node_modules\dsh-cc-loader" -Target "<checkout>\packages\cc-loader" | Out-Null
```

说明：
- `<profile-node_modules>` 指运行实例实际解析的 node_modules（本机 `~/.dsh/profiles/node_modules`）
- `dsh-hook-protocol` profile 里没有，junction 指向 DSH checkout 的 `packages/hooks/hook-protocol`
- `@deepseek-ai` 整目录 junction 覆盖所有 peer（schemastery / dsh-llm / dsh-subprocess…）

**验证解析**：逐个导入 5 个插件模块，全部成功才能继续：

```powershell
node --input-type=module -e "await import('file:///C:/.../packages/cc-skills/src/index.js').then(m=>console.log('ok',m.name))"
# 同理验证 cc-permissions / cc-agents / cc-hooks / cc-mcp
```

## 2. 写入 profile 的 cordis.patch.yml

在 `~/.dsh/profiles/<profile>/cordis.patch.yml` **追加** insert 条目（Windows 路径必须 `file:///` 前缀，且**必须带 `?v=N` 查询后缀**）：

```yaml
- insert:
    - id: cc-skills
      name: 'file:///C:/.../packages/cc-skills/src/index.js?v=1'
      config:
        enableSkills: true
        enableRules: true
        enableGlobal: true
        # M4: Claude Code 插件目录(plugin.json / skills/ / commands/)。
        # 插件技能/命令以 plugin-<插件>-<组件> 命名暴露(如 plugin-superpowers-brainstorming)。
        pluginRoots: ['C:/.../my-plugin', 'C:/.../superpowers']
    - id: cc-permissions
      name: 'file:///C:/.../packages/cc-permissions/src/index.js?v=1'
      config:
        enabled: true
        hideDeniedTools: true
        # M4: settings.json 的 "enableAllProjectMcpServers": true 自动放行项目 MCP 工具
    - id: cc-agents
      name: 'file:///C:/.../packages/cc-agents/src/index.js?v=1'
      config:
        provider: spawn
        toolName: cc_agent
        injectCatalog: true
        # M4: 插件 agents/ 目录,以 plugin-<插件>-<代理> 命名暴露
        pluginRoots: ['C:/.../my-plugin']
    - id: cc-hooks
      name: 'file:///C:/.../packages/cc-hooks/src/index.js?v=1'
      config:
        enabled: true
        enableGlobal: true
        # 插件 hooks/hooks.json 目录(若插件带 hooks)
        pluginDirs: ['C:/.../my-plugin']
    - id: cc-mcp
      name: 'file:///C:/.../packages/cc-mcp/src/index.js?v=1'
      config:
        enableProject: true
        watchProject: true
        # 插件 .mcp.json / plugin.json 内联 mcpServers,工具名 mcp__plugin_<插件>_<server>__<tool>
        pluginRoots: ['C:/.../my-plugin']
```

要点：
- **URL 后缀 `?v=N` 是热更新的关键**：首次装载后若某插件不生效，或改了插件源码，把 N 递增（`?v=2`…）即可强制宿主按新 URL 重新 import；HMR 只监视 profile 目录内文件，源码本身不热更新
- 写 `~/.dsh/profiles/...` 在工作区之外，若被文件沙箱拒绝需要相应权限

## 3. 验证装载

**① 宿主 Loader 树（权威）**：POST `http://127.0.0.1:3080/api/pluginInventory/list`，`Content-Type: application/json`，body：

```json
{"type":"client-request","rpcId":"probe-1","method":"pluginInventory/list","payload":{"args":{}}}
```

5 个 `file:///...` 条目应全部 `enabled=true phase=active`。

**② 逐插件行为验证**（每个都测，不要只测一个）：

- **cc-skills**：会话技能目录出现 `~/.claude/skills` 的全局技能；`.claude/rules/*.md` 以 CC 信封注入上下文；配了 `pluginRoots` 时出现 `plugin-<插件>-<技能>` 命名空间技能，`/plugin-<插件>-<技能>` 可斜杠调用（补全为 DSH 前缀匹配，搜中间片段搜不到是正常行为）
- **cc-permissions**：`.claude/settings.json` 写规则后触发对应命令应被拒，例如 deny `"PowerShell(Write-Output CC_PERM_DENY_*)"` 后执行 `Write-Output CC_PERM_DENY_xxx` → `Error: denied by ...`；`enableAllProjectMcpServers: true` 时项目 MCP 工具（`mcp__*`）自动放行
- **cc-hooks**：工具调用后在会话日志出现 `hook/invoked` + `hook/result` 事件（hook 子进程在沙箱内**写文件会 EPERM**，验证触发看会话日志事件，不要靠 hook 落盘）
- **cc-agents**：出现 `cc_agent` 工具；配了 `pluginRoots` 时目录出现 `plugin-<插件>-<代理>`（需插件带 agents/）
- **cc-mcp**：项目根 `.mcp.json` 的服务器工具出现为 `mcp__<server>__<tool>`；插件目录的为 `mcp__plugin_<插件>_<server>__<tool>`（插件名取 plugin.json 的 `name`，无 manifest 才用目录名）

**③ 测试资产注意**：SKILL.md frontmatter 的 description 用 `|` 块标量；纯标量里 `冒号+空格`（如 `Marker: x`）会导致 YAML 解析失败、技能被静默跳过。

## 4. 会话要求

项目级发现按**会话 cwd** 进行：验证会话的 workspace 必须是插件 checkout 所在目录（或其子目录），且带 `.git` 标记，否则项目级 `.claude`（rules/hooks/settings/skills）发现不到。
