# dsh-cc-ecosystem

[![Listed in dsh-market (via awesome-dsh-plugin)](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/dsh-market/dsh-market)

把你 Claude Code 的 `.claude/` 资产原样搬进 DeepSeek Harness —— 技能、斜杠命令、规则、权限、子代理、hooks、MCP 全部照常工作,不需要改写任何配置。

Load your Claude Code `.claude/` assets (skills, commands, rules, permissions, agents, hooks, MCP) into DeepSeek Harness as-is — no config rewriting.

> **你的 `.claude` 永远是唯一事实来源。** 插件只读它、从不写回:改配置就是改 `.claude`,与 Claude Code 天然同步,两边不会各有一套。

## 装什么给你什么

| 能力 | 说明 |
|---|---|
| **技能 / 斜杠命令 / 规则** | `.claude/skills`、`.claude/commands` 与 rules 直接可用,支持项目级与全局 `~/.claude` |
| **权限规则** | CC `settings.json` 的 `allow` / `deny` / `ask` 在 DSH 上照常强制,求值顺序与 Claude Code 一致 |
| **子代理** | `.claude/agents/*.md` 变成 DSH 可派发的 agent(正文即系统提示词,`tools` / `model` / `skills` 等 frontmatter 生效) |
| **Hooks** | 项目 / 全局 / 插件里的 `hooks.json` 原样运行,command、http、mcp_tool、prompt、agent 五类处理器都支持 |
| **MCP 服务器** | 项目根 `.mcp.json` 与插件内联的 `mcpServers` 自动注册为 DSH 工具,并附带 `/mcp` 管理面板(状态、重连、工具列表、按工作区启停) |
| **Claude Code 插件** | `plugin.json` 与 marketplace 也能读:插件的技能 / 命令 / agent / hooks / MCP 以 `plugin-<插件名>-<组件>` 命名空间并入 |

## 安装

> **务必带上版本号。**不带版本号会被解析到一个**更旧的**版本,而且安装过程照样报成功 —— 原因见 [为什么要带版本号](#为什么要带版本号)。

一条命令装齐(**推荐**):

```sh
dsh plugin --profile <name> add "dsh-cc-ecosystem@$(npm view dsh-cc-ecosystem version)"
```

Web GUI 里同样是填 `包名@版本号`;版本号先查出来:

```sh
npm view dsh-cc-ecosystem version     # 例:0.3.4
```

也可以只装需要的部分:

```sh
dsh plugin --profile <name> add "dsh-cc-skills@$(npm view dsh-cc-skills version)" "dsh-cc-mcp@$(npm view dsh-cc-mcp version)"
```

`dsh-cc-loader` 是下面几个包共用的解析层,会作为依赖自动装上,通常不必单独安装。

### 为什么要带版本号

pnpm 11 起默认开启 **`minimumReleaseAge`**(1440 分钟 = 1 天,见 [pnpm 官方文档](https://pnpm.io/supply-chain-security)):**发布不满 24 小时的版本,解析器不选它**,而是安静地留在或退到一个更旧的、已经"成熟"的版本上,**退出码依旧是 0**。所以"安装成功"并不等于装上了最新版 —— 装完请用 GUI 徽章或 `pnpm list` 核对实际版本。

同一个包、同一时刻的实测差别(`dsh-cc-ecosystem` 发布 4 小时时):

| 输入 | 实际装到 | 为什么 |
|---|---|---|
| `dsh-cc-ecosystem` / `dsh-cc-ecosystem@latest` | **0.3.3** | dist-tag 不豁免,0.3.4 被挡 |
| `dsh-cc-ecosystem@^0.3.4` | 0.3.4 | 该范围内只剩 0.3.4 一个候选,被自动豁免 —— **但下一版就失效** |
| `dsh-cc-ecosystem@0.3.4` | 0.3.4 | 精确版本,**只有这种写法是稳的** |

**升级同理**:装过旧版的用户,不带版本号再点一次安装**不会升级**。重复带版本号的安装即可。

若不想受这条策略约束,可在 profile 的 `pnpm-workspace.yaml` 里设 `minimumReleaseAge: 0`(全局关闭,慎用),或用 `minimumReleaseAgeExclude` 逐版本豁免 —— 后者按版本钉死,**每发一版都要补一次**,容易腐烂。

### 各包一览

| 包 | 作用 |
|---|---|
| [**dsh-cc-ecosystem**](https://www.npmjs.com/package/dsh-cc-ecosystem) | 全家桶:一条命令装齐下面全部 |
| [dsh-cc-skills](https://www.npmjs.com/package/dsh-cc-skills) | 技能、斜杠命令、rules |
| [dsh-cc-permissions](https://www.npmjs.com/package/dsh-cc-permissions) | CC 权限规则强制 |
| [dsh-cc-agents](https://www.npmjs.com/package/dsh-cc-agents) | 子代理目录 + `cc_agent` 派发 |
| [dsh-cc-hooks](https://www.npmjs.com/package/dsh-cc-hooks) | Claude Code hooks |
| [dsh-cc-mcp](https://www.npmjs.com/package/dsh-cc-mcp) | MCP 服务器 + `/mcp` 管理面板 |
| [dsh-cc-loader](https://www.npmjs.com/package/dsh-cc-loader) | 共享解析层(自动安装,非插件) |

从本地 checkout 热挂载(不发布到 npm 的开发流程)见 [DSHCCECO-INSTALL-SKILL.md](DSHCCECO-INSTALL-SKILL.md)。

## DSH 版本要求

| 你的 DSH 版本 | 用哪个 |
|---|---|
| `0.1.5-rc.2` 或 `0.2.0-rc.2` | **`v0.3.4`(当前)** —— 一条版本线同时兼容这两代 |
| `0.1.0-rc.7` ~ `0.1.1-rc.2` | `v0.1.x`(已停止维护) |

用 `0.2.0` 就必须是 `v0.3.1` 或更新:更早的版本会被 DSH 的插件安装检查直接拒绝。
`v0.3.4` 让 `.claude/rules` 的子目录真正被读到、把 `.claude` 当作项目根标记(没有 git 仓库的项目也能定位),并修掉 Windows 上 command hook 的三处失效 —— 详见 [CHANGELOG](CHANGELOG.md)。
`v0.3.3` 让 Claude Code 读得了、但 YAML 不严格的 frontmatter 不再被静默丢弃 —— 此前这类 agent / 技能 / 斜杠命令会整个消失。
`v0.3.2` 修掉了 0.2.0 上的四处静默失效(括号规则、SessionStart、消息 source、session 读取)。

## 支持的权限语义

与 Claude Code 一致,包括容易做错的那几处:

- 规则语法 `Tool` / `Tool(spec)`:Bash、PowerShell 命令 glob(`*`、`:*` 后缀、词边界)、Read/Edit 的 gitignore 路径锚定(`//` 绝对、`~/` 家目录、`/` 相对)、`WebFetch(domain:…)`、`mcp__server__tool`、`Agent(name)`、`Skill(name)`
- 求值顺序 **deny → ask → allow**;裸工具名的 deny 会直接把该工具从上下文移除
- Bash 复合命令会拆分(`&& || ; | &`),wrapper 与前置 env 会剥离(`timeout` / `nice` / `nohup` …);PowerShell 别名会规范化(`del` / `rm` → `Remove-Item`)
- Read 的 deny 同时拦住 Edit/Write 与 Bash 文件命令(`cat` / `head` / `sed` …)
- Windows 路径 POSIX 化(`C:\Users\alice` → `/c/Users/alice`,规则写 `//c/**`)
- **Bash 与 PowerShell 是独立工具**,`Bash(rm -rf *)` 不会覆盖 PowerShell,两者规则各自生效

## 已知限制

- **Hooks 事件未全覆盖**:Claude Code 的 31 个 hook 事件中,11 个有对应扩展点会真正触发;其余 20 个会被解析但不会运行(DSH 侧还没有对应的挂载点)。
- **子代理的部分字段不生效**:`isolation: worktree` 的子代理不会出现在目录里;`hooks`、`mcpServers`、`permissionMode` 会被忽略并给出提示(Claude Code 对插件里的 agent 也是同样处理)。
- **LSP 桥接(mcpls)尚未实现**,还在调研阶段。

## License

MIT

`dsh-cc-skills` 派生自 [dsh-claude-compat](https://github.com/biedongbin/dsh-claude-compat)(MIT,© biedongbin),`dsh-cc-loader` 的发现逻辑亦源自该基座;hooks 语义基于官方 `@deepseek-ai/dsh-hook-protocol`。
