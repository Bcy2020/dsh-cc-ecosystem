# Changelog

本仓库遵循 [Conventional Commits](https://www.conventionalcommits.org/);版本号按各包独立递增。

> [!IMPORTANT]
> **`v0.3.1` 起同时兼容 DSH `0.1.5-rc.2` 与 `0.2.0-rc.2` —— 双宿主,一条版本线。**
> `v0.3.0` 只绑定 0.1.5 的宿主契约,在 0.2.0 上会被安装闸直接拒绝
> (`Plugin … is incompatible with dsh 0.2.0-rc.2`)。
> DSH 仍停留在 `0.1.0-rc.7` ~ `0.1.1-rc.2` 的用户**请勿升级到 `v0.3.x`**,继续使用 `v0.1.x`
> (cc-permissions `v0.2.x`);`v0.3.1` 起不再需要为新旧宿主维护两条版本线。

## v0.3.3 — 非严格 YAML frontmatter 不再被丢弃

**协同发版**:`dsh-cc-loader` / `cc-skills` / `cc-agents` / `cc-hooks` / `cc-mcp` / `dsh-cc-ecosystem` **0.3.3**,
`cc-permissions` **0.4.3**。代码改动只在 `dsh-cc-loader`,其余六包随家族同步升版。

- **Claude Code 读得了、DSH 却整个丢弃的 frontmatter 现在能正常加载**([#9]) —— `parseFrontmatter` 一遇 `yaml.parse` 抛错就 `return undefined`,调用方只报一句 `skipped: no frontmatter`,于是**文件在 DSH 里等于不存在**。最常见的触发写法是**未加引号的 `description` 里出现了第二个 `: `** —— 社区 agent 文件在 `<example>` 块里写 `Context: …` / `user: '…'` 就会这样。实测同样会丢整个文件的还有:值换行且续行有缩进、用 Tab 缩进、同一个 key 写两遍、值以 `*` 开头。
  现在严格解析失败时退回**逐行 `key: value`** 读取,并把降级**报进 `warnings`**(附上 YAML 的原始报错行),不再静默。技能、斜杠命令、子代理、插件内组件共用这一个解析器,四类一起受益。
  两处实现取舍值得记住:值**一律保持字符串**,否则 `description: 2024` 会被转成数字、被 `stringField` 拒绝,等于拿「丢文件」换了「丢字段」;而 Claude Code 文档里本就是逗号分隔的五个字段(`tools` / `disallowedTools` / `skills` / `allowed-tools` / `disallowed-tools`)会**按逗号切开**,否则 `tools: Read, Grep, Glob` 会变成一个叫 `"Read, Grep, Glob"` 的假工具名 —— 文件救回来了,agent 却没有工具。
- **顺带修掉同一段告警管道里的两条既有缺陷** —— 都是在接这条新告警时撞出来的,不修的话新提示要么看不见、要么看两遍:
  - `loadClaude` 把 `mergeAgentCatalog` 的返回值又 push 回它自己刚填充过的那个数组 → **每条 agent 告警打印两遍**;
  - `collectClaudeDir` 忽略了调用方传进来的告警收集器、自己新建一个又没人合并 → **skill 与 command 的告警被整个丢弃**(包括既有的 `skipped: name not kebab-case` 之类)。
- **仍未覆盖**:整块 frontmatter 里连一行 `key: value` 都读不出来时,文件依旧被丢弃,提示依旧是 `no frontmatter`。对这类文件该措辞是准的,但对「有 frontmatter、只是 YAML 不严格」的文件曾经是误导。

**测试**:`packages/cc-loader/test/frontmatter-lenient.test.mjs`(11 例,含经 `discoverAgents` 与 `loadClaude` 的端到端;覆盖报告里的原始形状、其余几种严格 YAML 失败、逗号列表拆分、字符串不被数字化,以及「真的读不出来」仍返回 undefined)。做了**变异验证** —— 把兜底退回旧行为有 6 例转红、去掉逗号拆分有 2 例转红。全仓库 296 例。

## v0.3.2 — 修复 0.2.0 上四处静默失效

**协同发版**:`dsh-cc-loader` / `cc-skills` / `cc-agents` / `cc-hooks` / `cc-mcp` / `dsh-cc-ecosystem` **0.3.2**,
`cc-permissions` **0.4.2**。

这四处缺陷在 0.2.0 上都是**静默**失败 —— 不抛错、日志里一个字都没有、插件照常加载。全部在真机 0.2.0 profile 上复现并验证过,不只是单元测试。

- **含方括号的权限规则让每一轮都失败**([#8]) —— glob 转换把任何 `[...]` 原样当正则字符类,于是文件名叫 `[11-04-54]` 的规则会生成 `1-0` 这种反向区间,`new RegExp` 抛 `Range out of order in character class`;而规则在**每个工具调用**上都要编译,所以一条坏规则拖垮整个权限闸,连无关命令一起拦。
  字符类本来就只是 **path 方言**的特性(文件头注释一直这么写):现在只在 path 模式里解析 `[...]`,命令与域名模式里 `[` 是普通字符;即便在 path 模式,不是合法正则的类(如 `[11-04-54]`)也降级成字面量而不是抛错。
- **`agent/session-start` 在 0.2.0 被移除**([#7]) —— 0.2.0 把边界挪到 `agent/created` 并补上了 `source`。两代的名字**不是别名**:0.1.5 的 `agent/created` 只有 `{agent}`,没有 `source`,直接改名会把 `source` 悄悄丢掉(而 SessionStart hook 的载荷需要它)。
  新增 `packages/cc-loader/src/session-start-compat.js` 统一拥有这个边界:双监听、只对带 `source` 的载荷动作,两代都恰好触发一次。它同时给出 0.2.0 所需的两个保证 —— 永不返回处理器的 promise、永不让抛错逃逸,因为 0.2.0 的 `agent/created` 是**串行**事件,监听器拒绝会否决会话发布。
- **注入消息用了已退役的 V3 source**(发版后真机验证才暴露)—— 0.2.0 的会话格式 v4 准入门校验**每一条**持久化消息的 `source`:`kind` 必须是非空字符串**且不等于 `'plugin'`**,否则抛 `format v4 message requires a producer-owned source kind`,**整轮失败**。
  cc-hooks(3 处)与 cc-agents(1 处)一直在用 V3 的 `{kind:'plugin', plugin:…}`,于是每条注入路径都是地雷 —— SessionStart 上下文、hook 注入的上下文、prompt/agent hook 结果、以及 cc-agents 的目录提醒。
  新增 `packages/cc-loader/src/message-source.js` 集中产出合规 source,并加了一条扫描全部包源码的漂移守卫。
- **cc-hooks 在事件边界裸解引用 `agent.session`**(发版后真机验证才暴露)—— 0.2.0 先 announce agent、后挂 session,所以 `agent.session` 此时可能还是 `undefined`。SessionStart 监听器的第一行就抛,而兼容边界按设计吞掉它(监听器不能否决会话发布),于是处理器死在那一行、`runPoint` 根本没机会跑。
  表现为**插件正常加载、其它 hook 点全正常,只有 SessionStart 静默全死** —— 真机会话里 SessionStart 的 `hook/invoked` 一条都没有。

**发布流程**:`release.yml` 末尾新增 npmmirror 同步步骤 —— 发布后逐个等待版本在官方 registry 可见,再显式触发镜像同步。v0.3.1 时镜像漏了 `dsh-cc-loader`(其余六个都依赖它),安装卡了四小时。

**未包含**:[#2](https://github.com/Bcy2020/dsh-cc-ecosystem/issues/2)(Windows 上 `Bash(...)` 规则不覆盖 pwsh)、[#9](https://github.com/Bcy2020/dsh-cc-ecosystem/issues/9)(非严格 YAML frontmatter 的 agent 被丢弃)、[#10](https://github.com/Bcy2020/dsh-cc-ecosystem/issues/10)(Windows 上 command hook 不运行)、[#11](https://github.com/Bcy2020/dsh-cc-ecosystem/issues/11)(rules 不递归 / `.claude` 不作项目根标记),均仍未修复。

[#7]: https://github.com/Bcy2020/dsh-cc-ecosystem/issues/7
[#8]: https://github.com/Bcy2020/dsh-cc-ecosystem/issues/8
[#9]: https://github.com/Bcy2020/dsh-cc-ecosystem/issues/9

## v0.3.1 — 双宿主支持 + 全家桶 meta 包

**协同发版**:`dsh-cc-loader` / `cc-skills` / `cc-agents` / `cc-hooks` / `cc-mcp` **0.3.1**,
`cc-permissions` **0.4.1**,新增 `dsh-cc-ecosystem` **0.3.1**。DSH 0.2.0 换掉了插件安装路径
并新增一道兼容闸,本次让全部 7 个包同时通过新旧两代宿主。

- **新增 `dsh-cc-ecosystem`(全家桶)**:一条命令装齐 loader + 五个适配器 ——
  `dsh plugin --profile <name> add dsh-cc-ecosystem`(Web GUI 粘贴包名同理)。
  为什么必须单独一个包:DSH 把 `dsh.profile.bundles` 与 **profile 的直接依赖**对账,
  传递依赖不进 `bundles`、其 patch 永不加载 —— 装全家桶时五个适配器都是它的传递依赖,
  所以只有它自己的 patch 能挂载它们。因此它的 `cordis.patch.yml` 是五个适配器各自 patch 的
  **副本**;新增 `test/umbrella.test.mjs`(5)逐行比对两份配置,任何 config 漂移即失败
  (已做变异验证:改动一个值即可让该断言失败)。本包不声明 `dsh-*` peer —— 适配器的兼容性
  由宿主顺着 patch 里插入的行逐个读出并校验,再加一道闸只会产生第二份可能互相打架的判定。
- **通过 0.2.0 的兼容闸**:0.2.0 的安装路径新增 `evaluatePluginCompatibility` —— 对每个
  `@deepseek-ai/dsh` / `dsh-*` 开头的 peer,用 `semver.satisfies(runtime, range,
  { includePrerelease: true })` 对照**运行时版本**,不满足即在安装前拒绝。`dsh-llm` 与
  `dsh-subprocess` 的 peer 范围由 `^0.1.5-rc.2` 放宽为 `^0.1.5-rc.2 || ^0.2.0-rc.2`
  (cc-skills / cc-agents / cc-hooks / cc-mcp)。这四个包此前在 0.2.0 上会报
  `Plugin … is incompatible with dsh 0.2.0-rc.2: peerDependencies {…}`。
  cc-permissions 与 cc-loader 不含 `dsh-*` peer,不受这道闸影响。
- **`dsh-cc-loader` 现在可作插件安装**:0.2.0 的插件管理器拒绝任何未声明 `dsh.bundle` 的包
  (`… declares no dsh.bundle`)。loader 是纯库、不贡献任何插件行,因此声明一个内容为 `[]`
  的空 patch:它通过宿主的每一道校验(`dsh.bundle` 须是对象、`patch` 须是非空字符串、解析后
  的文件须在包目录内且存在、顶层须是 YAML 数组),并激活一个不插入任何行的空层。
  `dsh.bundle.patch` 允许是字符串或字符串数组,空数组合法。
- **修复 cc-hooks 在 0.2.0 上 command hook 崩溃**:宿主 shell 执行器接口由 `run(spec)`
  变为 `(await execute(spec)).result()`。两版 `dsh-hook-protocol` 的 `runHook` 除这一行外
  **逐字节相同**,所以任何依赖版本范围都只能满足其中一代(钉 0.2.x 坏 0.1.x,钉 0.1.x 坏
  0.2.x)。cc-hooks 改为自己持有这次调用,按 `execute` / `run` 特性探测
  (`src/shell-compat.js`,与 loader 的 `session-compat.js` 同一模式);请求形状、超时、
  stdin 封装与错误语义与原实现逐字保持一致,两代宿主行为相同。新增
  `test/hooks-shell-compat.test.mjs`(8 用例)分别覆盖两代形状、`execute` 直接返回结果、
  两者皆缺与执行器抛错时的降级。

## v0.3.0 — dsh-cc-mcp 管理面板(`/mcp`)

**协同发版**:`dsh-cc-loader` / `cc-skills` / `cc-agents` / `cc-hooks` / `cc-mcp` **0.3.0**,
`cc-permissions` **0.4.0**(其余 5 包无代码改动,仅随家族升版并同步 `dsh-cc-loader ^0.3.0` 依赖范围)。
最低 dsh 版本仍为 `0.1.5-rc.2`,宿主契约未变。

- **`/mcp` 面板(Web GUI)**:`dsh-cc-mcp` 现在为每个 MCP 服务器维护一行状态
  (`ready` / `error` / `disabled` / `skipped` / `checking`)与工具清单。斜杠命令 `/mcp`
  打开面板:列表页给出服务器 / 类型 / 状态,失败的行有 **Connect** 按钮(点击重连,
  仍失败则再弹一次自消失提示),已连接的行点 ✓ 可重新自检;点任意一行进入详情页,
  显示 `Connected · N tools`、配置来源、该服务器的**工具列表**,以及
  **Disable/Enable** 按钮 —— 禁用后该服务器的工具从模型上下文消失,新会话同样继承;
  再次点击即可恢复。
- **宿主 MCP 行纳入面板**:profile 里那些 `@deepseek-ai/dsh-mcp-client` 行(如 github /
  biorxiv / fetch / chrome-devtools-edge)也会列出,类型为 `host`,状态与工具清单取自
  宿主当前真实暴露的工具。对它们的操作**按工作区生效、且不改写 profile 配置**:
  - **Disable** = 用 `tools.restrict({ deny })` 只在**本工作区**的各会话里隐藏该行的
    `mcp__<server>__*` 工具(宿主行本身不动,其他工作区不受影响),Enable 时调用
    `restrict` 返回的撤销器恢复;
  - **Connect** = 该行暴露不出工具时(它自己连接失败/仍在启动),由本插件用**该行自己的
    配置**连上去,在该会话的 scope 内注册工具把能力补回来(状态标 `adopted`),Disable
    即撤销这份注册。
  - 新配置 `manageHostRows`(默认 `true`)可关掉这部分。
- **状态改为按工作区落盘**:禁用/隐藏决定写在 `<项目根>/.dsh/cc-mcp-state.json`
  (无项目根时回落到 `$DSH_HOME/cc-mcp-state.json`,也可用 `statePath` 固定路径)。
  因此「在这个工作区禁用 github」不会影响别的项目;`.mcp.json` 与 Claude Code 设置依旧只读。
- **会话开始的自检**:进入会话时后台逐个连接各 MCP(与对话并行),失败的服务器以
  **自动消失的提示框**报出(每个失败只报一次,会话切换/重连不会重复弹)。
- **传输**:面板走插件自己在宿主 `webServer` 上注册的同源路由 `/cc-mcp/*`(与官方插件市场
  dshmarket 同一约定):POST 带 `x-cc-mcp` 头、校验 `Origin === Host`、只收 JSON、4 KiB 上限。
  **不用** `ctx.connection.rpc` —— 实测该服务对 profile 顶层插件不可见
  (`ctx.inject(['connection'])` 永不触发),那条路根本挂不上路由。
- **迟到接管(late wiring)**:`agent/created` 只覆盖插件激活后新建的会话,而宿主重启会在
  用户层插件挂载前恢复上次会话,这类会话改为按需接管:面板/命令用宿主 `ctx.agents`
  注册表解析活 agent,`/mcp` 命令直接接管调用者;接管时等待首轮自检完成,首次打开面板
  看到的是已定型的行而不是转圈。
- **热挂载的两个坑已在代码里规避**(见 `src/index.js` 注释与 DSHCCECO-INSTALL-SKILL.md):
  - 非 `insert` 的补丁条目里 `name` 只是**断言**,与目标行不同会**整条跳过** —— 挂本地
    checkout 必须「`- id: <原行>` + `disabled: true`」再 `- insert:` 一个新行;
  - DSH 热挂载只重新 import **入口 URL**,相对导入的 `manage.js` / `register.js` 会被
    Node 的 ESM 缓存留住 → 新旧混用。现在相对导入继承入口的 `?v=N`,三个模块永远同批加载。
- **`/mcp` 宿主命令**:`/mcp <任意参数>` 与 CLI/headless 场景输出文本版状态报告
  (`/mcp` 裸调用在 GUI 里打开面板);`POST /cc-mcp/diag` 返回路由注册状态、已接管会话
  与当前可见的 `mcp__*` 工具,用于支持与测试。
- **新增浏览器半边** `client/index.js`:手写 classic script(懒 CJS 包装,零 `require`、
  零构建步骤),通过 `package.json` 的 `dsh.client` + `exports["./client"]` 被宿主扫描并
  按需加载。这是在 DSH 里为**仓库外**插件提供 Web UI 的受支持路径。
- **新配置**:`enableManager`(默认 `true`,注册 `/mcp` 命令与面板路由)、
  `manageHostRows`(默认 `true`)、`statePath`(默认空 = 按工作区)。
- **修复**:`watchProject: false` 时卸载 agent 会在 `detachWatcher` 上抛
  `Cannot read properties of null`(旧代码只在 `undefined` 上做了保护)。
- **已知限制**:插件热重载后,上一实例在**会话 scope** 内注册过的工具(例如项目 `.mcp.json`
  里已连上的服务器)可能残留到该会话被回收为止——面板会把这类行标成 `skipped` 并列出可见
  工具;宿主重启或开新会话即干净。这也是 `skipped` 的判据(该命名空间已被别的层注册)。
- **测试**:`packages/cc-mcp/test/mcp-manager.test.mjs`(29 例:投影/持久化/真实 stdio MCP
  端到端、失败上报、Connect 重试、禁用启用、**宿主行的列出/按工作区隐藏/按需接管**、
  宿主命令、卸载回收、**迟到接管**、**路由安全边界**)、
  `packages/cc-mcp/test/client-bundle.test.mjs`(9 例打包与传输契约)、
  `packages/cc-mcp/test/client-panel.dom.test.mjs`(6 例真实 DOM 面板交互);根 `npm test`
  已纳入(共 249 例)。

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
