# dsh-cc-ecosystem

[![Listed in dsh-market (via awesome-dsh-plugin)](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/dsh-market/dsh-market)

| 包 | 月下载 (npm `latest`) | 版本 |
|---|---|---|
| [dsh-cc-loader](https://www.npmjs.com/package/dsh-cc-loader) | ![](https://img.shields.io/npm/dm/dsh-cc-loader?style=flat) | ![](https://img.shields.io/npm/v/dsh-cc-loader?style=flat) |
| [dsh-cc-skills](https://www.npmjs.com/package/dsh-cc-skills) | ![](https://img.shields.io/npm/dm/dsh-cc-skills?style=flat) | ![](https://img.shields.io/npm/v/dsh-cc-skills?style=flat) |
| [dsh-cc-permissions](https://www.npmjs.com/package/dsh-cc-permissions) | ![](https://img.shields.io/npm/dm/dsh-cc-permissions?style=flat) | ![](https://img.shields.io/npm/v/dsh-cc-permissions?style=flat) |
| [dsh-cc-agents](https://www.npmjs.com/package/dsh-cc-agents) | ![](https://img.shields.io/npm/dm/dsh-cc-agents?style=flat) | ![](https://img.shields.io/npm/v/dsh-cc-agents?style=flat) |
| [dsh-cc-hooks](https://www.npmjs.com/package/dsh-cc-hooks) | ![](https://img.shields.io/npm/dm/dsh-cc-hooks?style=flat) | ![](https://img.shields.io/npm/v/dsh-cc-hooks?style=flat) |
| [dsh-cc-mcp](https://www.npmjs.com/package/dsh-cc-mcp) | ![](https://img.shields.io/npm/dm/dsh-cc-mcp?style=flat) | ![](https://img.shields.io/npm/v/dsh-cc-mcp?style=flat) |

Load Claude Code `.claude/` assets (skills, commands, rules, permissions, agents, hooks) into DeepSeek Harness as a DSH plugin ecosystem.

把 Claude Code 的 `.claude/` 资产(技能 / 命令 / 规则 / 权限 / 子代理 / hooks)以 DSH 插件生态的形式加载进 DeepSeek Harness。

> **设计核心**:一个**内存 IR 解析层**(`dsh-cc-loader`)把 `.claude` 解析成独立中间表示,不落盘、零写路径——单一事实来源永远是 `.claude` 原文,与 Claude Code 天然同步;每个 CC 组件对应一个独立插件包,可单独安装、独立演进。权限是**只读桥**:CC `settings.json` 的 allow/deny/ask 规则在 DSH 上强制,DSH 侧审批不写回 `.claude`。

## Packages

| 包 | 职责 | 状态 |
|---|---|---|
| [dsh-cc-loader](packages/cc-loader) | 共享解析层:`.claude`(项目 + 全局 `~/.claude`)→ 内存 IR;组件分类 DIRECT/ADAPTED/UNSUPPORTED/BLOCKED;权限规则语法解析与 deny→ask→allow 求值;agent 目录发现与分类;plugin.json 解析 + marketplace 发现 + plugin 根盘点(M4) | ✅ M1 / M4 |
| [dsh-cc-skills](packages/cc-skills) | 适配器:IR skills/commands → DSH skill provider;rules 按 CC `prependUserContext` 信封注入会话(仅顶层会话) | ✅ M1 |
| [dsh-cc-permissions](packages/cc-permissions) | 适配器:`tools/pre-execute` 门强制 CC 权限规则;裸名 deny 隐藏工具;`defaultMode=dontAsk` → 审批 never;`enableAllProjectMcpServers` → 项目 MCP 工具自动 allow(M4);**`allow` 规则自动应答 `approval/request`(含沙箱提升,CC 语义 = 免审批完整放行)** | ✅ M1.5 / M4 |
| [dsh-cc-agents](packages/cc-agents) | 适配器:`.claude/agents`(身份锚定子代理)→ 会话启动注入 agent 目录(CC @-mention 语义)+ `cc_agent` 派发工具(persona = 正文,`tools`/`disallowedTools` → toolFilter,`skills` 预载,`model` 经 `modelAliases` 映射);插件 agent 合并(plugin-<name>-<agent> 命名空间, M4c) | ✅ M2 / M4c |
| [dsh-cc-hooks](packages/cc-hooks) | 适配器:发现项目/全局/插件 `hooks.json` → 合并 → 经 `dsh-hook-protocol`(官方库)按 CC 语义运行(7 事件,command 型),per-session 发现突破官方桥进程级限制 | ✅ M2 |
| [dsh-cc-mcp](packages/cc-mcp) | 适配器:发现 CC MCP 配置(项目根 `.mcp.json` + 插件 `.mcp.json`/plugin.json 内联 `mcpServers`)→ 经官方 `@modelcontextprotocol/sdk` 运行时注册为 DSH 工具(项目级 `mcp__<server>__<tool>`,插件级 `mcp__plugin_<name>_<server>__<tool>` CC 官方命名);env 值运行时展开不落盘;lazy 连接 + idle 回收 + `.mcp.json` 热重载 | ✅ M3 |

M4(plugin.json / marketplace / plugin 命名空间 / enableAllProjectMcpServers)已完成;**6 包已发布 npm**(dsh-cc-loader / dsh-cc-skills / dsh-cc-agents / dsh-cc-hooks / dsh-cc-mcp @ **v0.2.0**,dsh-cc-permissions @ **v0.3.0**),`npm i dsh-cc-loader dsh-cc-skills dsh-cc-permissions dsh-cc-agents dsh-cc-hooks dsh-cc-mcp`;规划中:M5 `dsh-cc-misc` + `dsh-cc` 全家桶 meta 包;LSP 桥接(mcpls)研究完成,实现待生态需求确认后启动。

## DSH 兼容性

> **最低要求:DSH `0.1.5-rc.2`**(下列破坏性变更使其无法在更早宿主上运行)。

| 本仓库版本 | 最低 dsh 版本 | 说明 |
|---|---|---|
| `v0.2.x`(cc-permissions `v0.3.x`) | **0.1.5-rc.2** | 修复 `Session.events` 移除与 `CallId` 改名;插件依赖改用 peerDependencies |
| `v0.1.x`(cc-permissions `v0.2.x`) | 0.1.0-rc.7 | 仅适用于 0.1.2-alpha.4 之前的宿主,**已不再支持** |

### v0.2.0 / cc-permissions v0.3.0 破坏性变更

DSH 是 developer preview,每个版本都可能破坏兼容。本次升级(0.1.1-rc.2 → 0.1.5-rc.2)修复了三处宿主契约变更:

| # | 变更 | 受影响插件 | 修复 |
|---|---|---|---|
| 1 | `Session.events` **已被移除**(自 0.1.2-alpha.4)。旧代码 `[...session.events]` 抛 `agent.session.events is not iterable`,`session.events[seq]` 抛 `Cannot read properties of undefined (reading 'NN')` | cc-skills(rules 去重)、cc-hooks(`lastTurn` / `lastAssistantMessage`)、cc-permissions(approval 自动应答) | 新增集中兼容边界 `sessionEvents()` / `sessionEventAt()` / `sessionLastEvent()`(导出自 `dsh-cc-loader`):优先 `snapshotEvents()` / `eventAt()`,仅在旧宿主回退到 `session.events` |
| 2 | `@deepseek-ai/dsh-llm` 的 `CallId` **改名为 `ToolCallId`**(0.1.5 已不导出 `CallId`) | cc-hooks(`executors.js` 的 mcp_tool / agent 执行器) | `import { ToolCallId }` |
| 3 | `@deepseek-ai/dsh-host-apiproxy` **包已移除** | 本仓库未使用 | 无需改动(排查确认) |
| 4 | `SessionPersistence` **公开契约没有** `locate`(只有 `create`/`open`/`flush`/`stat`/`list`);JSONL 后端那个 `locate` 是 TypeScript `private`。旧代码 `ctx.get('sessionPersistence')?.locate(h)?.path` 的 `?.` 只保护**服务**、不保护**方法**,服务存在但后端无该方法时同步抛 `TypeError: …locate is not a function`,而该表达式在每个 hook payload 构造器(`base()`)里被**急切求值** → SessionStart / PreToolUse / Stop / SessionEnd 等全部失效 | cc-hooks(`base()` / `compactPayload()`) | 抽出 `transcriptPath(ctx, session)`:先 `typeof persistence?.locate !== 'function'` 判定,再 `try/catch`;不可用时退化为 `''`——与官方桥 `hooks-claude-code` 的硬编码 `transcript_path: ''` 一致,而可用时仍保留该字段 |

同时修正了**依赖声明**。DSH profile 使用 `nodeLinker: hoisted` + `autoInstallPeers: false`,其设计意图是让缺失的 peer 回落到宿主安装(`profiles/node_modules` 的扁平 fallback 层),从而**全进程共享宿主的单份 SDK 实例**:

- **宿主提供的 SDK**(`@deepseek-ai/dsh-llm`、`dsh-subprocess`、`schemastery`、`cordis`)→ 声明为 **peerDependencies**(`^0.1.5-rc.2` / `^3.18.1`),不带自己副本。此前它们是正式 dependencies,导致 profile 里被装进一份**旧 SDK 0.1.0-rc.8**,插件实际跑在旧 SDK 上,且进程内存在两份 `dsh-llm`(品牌类型 / 身份判断可能失效)。
- **宿主不保证提供的包**(`@deepseek-ai/dsh-hook-protocol`)→ 声明为正式 **dependencies**。该包自身**零运行时依赖**(只有 `import type`,无 `instanceof` 跨模块检查),因此即便是私有副本也完全惰性、不会造成实例身份问题;而缺失它会导致 ESM 具名导入在模块求值期抛 `SyntaxError`,宿主**启动即崩**(无优雅降级),防御性地自带副本是更安全的一侧。
- 各包同时把这些包列入 `devDependencies`,使仓库内 `npm test` 可独立复现。

**实测**:在干净的 profile 中安装本版本后,`@deepseek-ai/dsh-llm` 与 `@deepseek-ai/schemastery` 均解析到**宿主**的 0.1.5-rc.2 副本,profile 内不再出现第二份 SDK。

### 本地开发:跨包改动必须链接

本仓库无 workspace 管理,各包从 registry 安装 `dsh-cc-loader`。这意味着对 `packages/cc-loader/src` 的改动**默认对适配器包的测试不可见**(它们跑在上次发布的 loader 上)——`npm run link` 把各依赖包的 `node_modules/dsh-cc-loader` 指向本工作树,CI 已在安装后执行该步骤。安装依赖后需重新运行 `npm run link`。


## 实装与发布

- **[安装技能(另一台电脑实装经验总结)](DSHCCECO-INSTALL-SKILL.md)**:完整的热挂载步骤 —— junction hub 依赖解析、`cordis.patch.yml` `file:///` 挂载(含 `?v=N` 热更新)、宿主 Loader 树验证(`pluginInventory/list`)、逐插件行为验证、M4 插件目录(`pluginRoots`)配置。
- **npm 发布**:`v0.2.0` 起 6 包统一为 `dsh-cc-loader` / `cc-skills` / `cc-agents` / `cc-hooks` / `cc-mcp` **v0.2.0** + `cc-permissions` **v0.3.0**(见 [CHANGELOG.md](CHANGELOG.md));发布由 `.github/workflows/release.yml` 在推 `v*` tag 时按依赖顺序执行(`dsh-cc-loader` **必须先发**,其余包 `^0.2.0` 依赖它),依赖仓库 Secret `NPM_TOKEN`;本机 npm 源为镜像时手动发布需 `--registry=https://registry.npmjs.org`,开 2FA 的账号需 granular token + 2FA bypass。

## 支持的 CC 权限语义(与 Claude Code 一致)

- 规则语法 `Tool` / `Tool(spec)`:Bash/PowerShell 命令 glob(`*`、`:*` 后缀、词边界)、Read/Edit gitignore 路径锚定(`//` 绝对、`~/` 家目录、`/` 相对 settings 源)、`WebFetch(domain:…)`、`mcp__server__tool`、`Agent(name)`、`Skill(name)`、`Tool(param:value)`
- 求值顺序 **deny → ask → allow**,特异性不改变顺序;裸工具名 deny 从上下文移除工具
- Bash 复合命令拆分(`&& || ; | &` 等)、wrapper 剥离(`timeout`/`nice`/`nohup`…)、前置 env 剥离;PowerShell 别名规范化(`del`/`rm`/`ri` → `Remove-Item`)
- Read deny 同时拦 Edit/Write 工具与 Bash 文件命令(`cat`/`head`/`tail`/`sed`…)
- Windows 路径 POSIX 化(`C:\Users\alice` → `/c/Users/alice`,规则写 `//c/**`)
- Bash 与 PowerShell 是**独立工具**(`Bash(rm -rf *)` 不覆盖 pwsh),规则各自生效

## 支持的 CC agents 语义

- `.claude/agents/*.md`(项目 > 全局优先级):frontmatter 支持官方 16 字段(`name`/`description`/`tools`/`disallowedTools`/`model`/`skills`/`background`/`initialPrompt`/`maxTurns`/`effort`/`memory`/`color`/`permissionMode`/`mcpServers`/`hooks`/`isolation`)+ 社区扩展 `context`;正文 = 系统提示词
- `cc_agent` 派发:persona 通道注入身份;`tools` 白名单 → `toolFilter.allow`,`disallowedTools` 黑名单 → `toolFilter.deny`(CC 桶名如 `Read`/`Bash` 自动展开为 DSH 工具名);`skills` 预载全文;`model` 只经 `modelAliases` 映射(CC 模型名不直传)
- 分类:`isolation: worktree` → BLOCKED 不出现在目录;`hooks`/`mcpServers`/`permissionMode` → UNSUPPORTED 忽略并报告(CC 对插件 agent 同样禁止)

## 安装

> **推荐**:新机器按 [DSHCCECO-INSTALL-SKILL.md](DSHCCECO-INSTALL-SKILL.md) 的 junction hub + `cordis.patch.yml` 热挂载(已在另一台电脑实装验证)。

```sh
# 先装共享库,再装插件
dsh plugin --profile <name> add dsh-cc-loader dsh-cc-skills dsh-cc-permissions dsh-cc-agents dsh-cc-hooks dsh-cc-mcp
```

本地 patch 挂载(Web profile 热更新)见各包 README;Windows 绝对路径必须 `file:///` 前缀。

**开发期(本仓库工作树)**:各包从 registry 安装 `dsh-cc-loader`,因此改完 `packages/cc-loader/src` 后必须 `npm run link` 把依赖指向本工作树,否则适配器测试仍跑在上次发布的 loader 上。

> **HMR 提示**:改插件源码后需重启 GUI 生效(hmr watcher 只可靠监视 profile 目录内文件);`cordis.patch.yml` 覆盖已存在条目(bundle 里的)要用非 insert 顶层条目按 id 定位,`- insert:` 只追加不覆盖。

## 验证

- 单元测试:`node --test test/` — 共 **210 用例全绿**(含 loader、agents、hooks、mcp、permissions、plugin、LSP,以及本次新增的 session 形状回归:<br>`packages/cc-loader/test/session-compat.test.mjs`(17)、`packages/cc-skills/test/rules-dedup.test.mjs`(5)、`test/hooks-session-shape.test.mjs`(5)、`test/hooks-transcript-path.test.mjs`(7))
- **两种 Session 形状**均有回归覆盖:0.1.5 形状(`snapshotEvents()` / `eventAt()` / `seq`,**无** `events` 属性)与旧形状(`events` 数组)。回归测试经过**变异验证**:把兼容层退回"只读 `session.events`"后,全部 5 个 0.1.5 形状用例失败、而旧形状用例仍通过
- **依赖解析实测**:在干净 profile 安装本版本后,`@deepseek-ai/dsh-llm` 与 `@deepseek-ai/schemastery` 解析到**宿主**的 0.1.5-rc.2 副本(profile 内不再有第二份 SDK),`@deepseek-ai/dsh-hook-protocol` 为自带的 0.1.5-rc.2 副本
- 端到端验证:各包自带 smoke test(`packages/cc-mcp/test/mcp-smoke.test.mjs`、`packages/cc-permissions/test/gate.test.mjs`、`packages/cc-skills/test/scope.test.mjs`、`packages/cc-agents/test/persona.test.mjs`)
- 真实插件实测:obra/superpowers v6.3.0 → 14 技能零警告,`plugin-superpowers-*` 命名空间 + 斜杠调用 + 模型调用全部验证通过

## License

MIT — `dsh-cc-skills` 为 [dsh-claude-compat](https://github.com/biedongbin/dsh-claude-compat)(MIT, © biedongbin) 的派生;`dsh-cc-loader` 的发现逻辑亦源自该基座。hooks 语义基于官方 `@deepseek-ai/dsh-hook-protocol`。
