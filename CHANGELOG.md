# Changelog

本仓库遵循 [Conventional Commits](https://www.conventionalcommits.org/);版本号按各包独立递增。

> [!IMPORTANT]
> **`v0.2.x` 是 DSH 0.1.5 的兼容版本,不是功能版本 —— 只有把 DSH 升级到 `0.1.5-rc.2` 时才需要。**
> 它绑定 0.1.5 的宿主契约,**在旧版 DSH 上无法工作**。
> DSH 仍停留在 `0.1.0-rc.7` ~ `0.1.1-rc.2` 的用户**请勿升级到 `v0.2.x`**,继续使用 `v0.1.x`
> (cc-permissions `v0.2.x`)。两代版本号互斥,不存在同时兼容新旧宿主的版本。

## v0.2.1 — 版本策略声明(hotfix,无代码改动)

**只有升级 DSH 到 `0.1.5-rc.2` 时才需要使用这一代版本;旧宿主请留在上一代。**

`v0.2.0` 发布时 npm 包页面渲染的 README 里**没有**这条声明(npm 的版本内容不可覆盖),于是 `latest`
指向了一个"装到旧宿主上会坏"的版本却没有任何提示。本补丁把该声明写入根 README、6 个包 README
与 CHANGELOG,使其在 **npm 包页面**上可见。

- **代码与依赖范围与 `v0.2.0` 完全一致**,没有任何行为变化;已装 `v0.2.0` 的用户无需升级
- `dsh-cc-loader` 依赖范围仍为 `^0.2.0`(0.2.1 是文档补丁,兼容,无需强制升级 loader)

## v0.2.0 — DSH 0.1.5-rc.2 兼容(critical)

> **升级前提**:宿主 DSH 必须为 `0.1.5-rc.2` 或更高。
> **本版本不兼容更早的 DSH**(`0.1.0-rc.7` ~ `0.1.1-rc.2`)——
> 旧宿主请留在 `v0.1.x` / cc-permissions `v0.2.x`,**不要升级**。

**最低 dsh 版本:0.1.5-rc.2。** 本次为破坏性兼容修复 —— 旧版本插件在 DSH ≥ 0.1.2-alpha.4 上会启动失败或运行时抛错。

DSH 是 developer preview,官方声明每个版本都可能有破坏性变更。本次从 0.1.1-rc.2 升到 0.1.5-rc.2 修复了四处宿主契约问题。

### Breaking(宿主契约变更导致的必需修复)

- **`Session.events` 已被移除**(自 0.1.2-alpha.4)。旧代码在 0.1.5 上是致命的:
  - `[...session.events]` → `TypeError: agent.session.events is not iterable`
  - `session.events[seq]` → `TypeError: Cannot read properties of undefined (reading 'NN')`

  新增集中兼容边界并导出自 `dsh-cc-loader`:
  - `sessionEvents(session)` — 优先 `snapshotEvents()`,回退旧 `events`
  - `sessionEventAt(session, seq)` — 优先 `eventAt(seq)`,回退旧 `events[seq]`
  - `sessionLastEvent(session, predicate)` — 逆序扫描取最新匹配

  改造的调用点:`cc-skills` rules 去重、`cc-hooks` 的 `lastTurn` / `lastAssistantMessage`、`cc-permissions` 的 `approval/request` 自动应答。

- **`@deepseek-ai/dsh-llm` 的 `CallId` 改名为 `ToolCallId`** —— 0.1.5 已不导出 `CallId`。ESM 具名导入不存在的符号是**模块求值期 SyntaxError**,`dsh-cc-hooks` 根本 import 不进来。已改为 `ToolCallId`(品牌类型构造器,语义等价)。

- **`SessionPersistence` 公开契约没有 `locate`**(只有 `create`/`open`/`flush`/`stat`/`list`;JSONL 后端那个是 TS `private`)。旧代码 `ctx.get('sessionPersistence')?.locate(h)?.path` 的 `?.` 只保护**服务**、不保护**方法**,服务存在但后端无该方法时同步抛 `TypeError: …locate is not a function`,而该表达式在每个 hook payload 构造器(`base()`)里**急切求值** → SessionStart / PreToolUse / Stop / SessionEnd 等全部失效。改为 `transcriptPath(ctx, session)`:`typeof` 判定 + `try/catch`,不可用时退化为 `''`(与官方桥 `hooks-claude-code` 的硬编码一致),可用时仍保留该字段。

- **`@deepseek-ai/dsh-host-apiproxy` 包已移除** —— 排查确认本仓库未引用,无需改动。

### Fixed(依赖声明)

DSH profile 使用 `nodeLinker: hoisted` + `autoInstallPeers: false`,设计意图是让缺失的 peer 回落到宿主安装(`profiles/node_modules` 扁平 fallback 层),全进程共享宿主单份 SDK 实例。

- `@deepseek-ai/dsh-llm` / `dsh-subprocess` / `schemastery` / `cordis` 从 **dependencies 改为 peerDependencies**。此前它们是正式 dependencies,导致 profile 里被装进一份**旧 SDK 0.1.0-rc.8**,插件实际跑在旧 SDK 上,且进程内存在两份 `dsh-llm`(品牌类型 / 身份判断可能失效 —— 当时能跑纯属解析巧合,pnpm 一 prune 就会崩)。
- `@deepseek-ai/dsh-hook-protocol` **保留为正式 dependencies**。实测该包**零运行时依赖**(只有 `import type`,无 `instanceof` 跨模块检查),私有副本完全惰性;而缺失它会导致宿主启动即崩,防御性自带副本是更安全的一侧。
- 各包补充 `devDependencies`,使仓库内 `npm test` 可独立复现。
- 各包 `dsh-cc-loader` 依赖范围升至 `^0.2.0`。

### Added

- `scripts/link-local.mjs`(`npm run link`):把各依赖包的 `node_modules/dsh-cc-loader` 指向本工作树。此前对 `packages/cc-loader/src` 的改动对适配器包测试**不可见**(它们跑在上次发布的 loader 上)—— 这正是本类跨包破坏能溜进线上 profile 的盲区。CI 已在安装后执行该步骤。
- 回归测试(34 个新用例,总计 210):
  - `packages/cc-loader/test/session-compat.test.mjs` — 兼容边界单元测试(两种 Session 形状 + 全量畸形输入)
  - `packages/cc-skills/test/rules-dedup.test.mjs` — rules 去重在两种形状下均只注入一次
  - `test/hooks-session-shape.test.mjs` — `lastTurn` / `lastAssistantMessage` 两种形状,经真实 `apply()` 驱动
  - `test/hooks-transcript-path.test.mjs` — `transcript_path` 在无 `locate` / 抛错 / 畸形返回下均不崩
  - 回归测试经过**变异验证**:把兼容层退回"只读 `session.events`"后,全部 5 个 0.1.5 形状用例失败、旧形状用例仍通过

### 验收证据

- 干净 profile 装入 6 个 tarball → **启动零错误**,5 个插件层全部挂载(composed tree 92 项)
- 真实对话 + 工具调用:`tool/call`(`pwsh echo`)→ `tool/result`(`isError:false`),日志**零错误签名**(无 `is not iterable` / 无 `Cannot read properties of undefined`)
- cc-skills rules **只注入一次**(session 日志 `user/message` 且 `source.kind==='cc-skills'` 计数 = 1)
- 依赖解析实测:profile 内 `@deepseek-ai/` 只剩 `dsh-hook-protocol` 一份;`dsh-llm` 与 `schemastery` 均解析到**宿主**的 0.1.5-rc.2

### 版本矩阵

| 包 | v0.1.x | v0.2.0 |
|---|---|---|
| dsh-cc-loader | 0.1.2 | **0.2.0** |
| dsh-cc-skills | 0.1.2 | **0.2.0** |
| dsh-cc-permissions | 0.2.2 | **0.3.0** |
| dsh-cc-agents | 0.1.2 | **0.2.0** |
| dsh-cc-hooks | 0.1.2 | **0.2.0** |
| dsh-cc-mcp | 0.1.2 | **0.2.0** |

发布顺序:`dsh-cc-loader` 必须先发(其余包依赖它)。
