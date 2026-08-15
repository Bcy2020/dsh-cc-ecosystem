# DSH × Claude Code Plugin 加载生态 —— 设计文档

> 版本:0.2(策略定案:社区基座 + 拆分 + 补全 + 全家桶)
> 状态:基于源码与官方文档核实后的设计稿,尚未实现
> 关联研究目录:`../cc-plugin-study/`(克隆的 wshobson/agents 94 插件 + superpowers-marketplace 实测样本)
> DSH 源码依据:`D:/deepseek-harness/`(packages/subagent、packages/preset/agent-presets、docs/subsystems/subagent.md 等)

---

## 0. 一句话目标

**让 DSH 能像 Claude Code 加载 plugin 一样,加载 CC 的 `.claude` 与 `.claude-plugin` 生态(声明式 .md 资产包),并且把整套加载能力做成一组可独立安装、独立演进的 DSH 插件——每个 CC 组件(hooks、身份 agent、skills、MCP、LSP……)对应一个 DSH 插件,另配一个一键安装的全家桶包。**

这不是把 CC plugin "转换"成 DSH 插件(转换方案已否决),而是**以社区插件为基座(fork 拆分)、补全缺失组件,在 DSH 之上重建一个 CC 资产解释器/运行时**。

---

## 1. 事实基础(已核实)

### 1.1 Claude Code plugin 是什么

CC plugin = **纯声明式 Markdown/JSON 资产包**,给 agent(LLM)看,不给宿主软件加功能。实测结构(`wshobson/agents/plugins/agent-teams/`):

```
agent-teams/
├── .claude-plugin/
│   └── plugin.json          # {name, version, description, author, license} 极简元数据
├── agents/                  # 子代理定义:frontmatter + 系统提示词正文
├── commands/                # 斜杠命令:frontmatter + Markdown 指令
└── skills/                  # 技能:SKILL.md + references/
```

带运行时组件的插件另有:`hooks/hooks.json`(事件→命令)、`.mcp.json`(捆绑 MCP)、`.lsp.json`(语言服务器)、`monitors/`(后台监控)、`bin/`(可执行)等。

**关键性质**:
- 组件主体是 .md(frontmatter + 正文),由宿主运行时**解释**加载
- 功能 = 改变 agent 的输入/行为(prompt 工程与资产组织),不是宿主 API 调用
- 与 DSH 插件(Cordis 代码模块,注册工具/服务/事件/UI)**形态和功能上无任何关系,只是都叫 plugin**

### 1.2 CC plugin 完整组件清单(官方 Plugins reference + 实测)

| # | 组件 | 位置 | 本质 | 实测生态占比 |
|---|------|------|------|------|
| 1 | Skills | `skills/<name>/SKILL.md` | 技能:方法论/工具使用说明,模型可主动调用 | 49/94 |
| 2 | Commands | `commands/*.md` | 斜杠命令:扁平 Markdown,展开成 prompt | 54/94 |
| 3 | Agents | `agents/*.md` | 子代理:frontmatter + 系统提示词 | 83/94(最多) |
| 4 | Hooks | `hooks/hooks.json` | 生命周期事件处理器(31 事件) | 2/94 |
| 5 | MCP servers | `.mcp.json` | 捆绑 MCP 服务器,启用即自动启动 | 少数 |
| 6 | LSP servers | `.lsp.json` | 语言服务器(跳转定义/找引用/实时诊断) | 官方 11 种 |
| 7 | Workflows | `workflows/*.js` | 工作流脚本 | 新组件 |
| 8 | Output styles | `output-styles/*.md` | 输出风格定义 | 少 |
| 9 | Monitors | `monitors/monitors.json` | 后台常驻监控,stdout 每行通知 agent(实验) | 少 |
| 10 | Themes | `themes/*.json` | 配色主题(实验) | 少 |
| 11 | Executables | `bin/` | 可执行文件加入 Bash PATH | 少 |
| 12 | Settings | `settings.json` | 默认配置(仅 agent / subagentStatusLine) | — |

**plugin.json 清单字段**(不只是元数据):
- 元数据:`name`(唯一,做命名空间)、`displayName`、`version`、`description`、`author`、`homepage`、`repository`、`license`、`keywords`、`metadata`、`defaultEnabled`
- 自定义路径:`skills` / `commands` / `agents` / `workflows` / `hooks` / `mcpServers` / `outputStyles` / `lspServers` / `experimental.themes` / `experimental.monitors`
- 高级:`userConfig`(启用时收集配置,`${user_config.KEY}` 注入 + `CLAUDE_PLUGIN_OPTION_<KEY>` 环境变量)、`channels`(消息通道,绑 MCP)、`dependencies`(插件间依赖,支持 semver)

**Hooks 完整事件面(31)**:SessionStart / Setup / UserPromptSubmit / UserPromptExpansion / PreToolUse / PermissionRequest / PermissionDenied / PostToolUse / PostToolUseFailure / PostToolBatch / Notification / MessageDisplay / SubagentStart / SubagentStop / TeammateIdle / TaskCreated / TaskCompleted / Stop / StopFailure / InstructionsLoaded / ConfigChange / CwdChanged / DirectoryAdded / FileChanged / WorktreeCreate / WorktreeRemove / PreCompact / PostCompact / Elicitation / ElicitationResult / SessionEnd

**Hook 动作类型(5)**:`command` / `http` / `mcp_tool` / `prompt`(LLM 评估) / `agent`(agentic 验证器)

**路径变量(3)**:`${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}`(持久目录) / `${CLAUDE_PROJECT_DIR}`

**marketplace.json**:索引 `{name, source(本地路径或 git URL), description, version, author, license, category}`

### 1.3 DSH 前置条件核查结论(源码级)

| CC 组件 | DSH 端对应物 | 结论 |
|---|---|---|
| Skills | `ctx.skills` | ✅ 原生支持,`SKILL.md` 格式互通 |
| Commands | DSH commands 系统 | ✅ 原生支持 |
| Agents(第一种:身份锚定) | **无直接对等物** | ⚠️ 见 1.4 |
| Agents(第二种:现场传 prompt) | `ctx.subagents.start()` + `tool-subagent` | ✅ 原生,参数就是 `{description, prompt}` |
| Hooks | `@deepseek-ai/dsh-hooks-claude-code`(DSH 官方 first-party 桥) | ✅ 官方:7/31 事件,仅 command 类型,configPath 进程级(补全点见 §3.3) |
| MCP servers | `dsh-mcp-client` 配置行 | ✅ 原生 |
| LSP servers | **无原生 LSP** | ⚠️ 可通过 LSP→MCP 桥走 MCP 通道(见 1.5) |
| Workflows / Output styles / Monitors / Themes | 无 | ❌ 跳过或降级映射 |
| `userConfig` | 无对应 | ❌ 需做成 DSH 配置 |
| `channels` / `dependencies` | 无 | ❌ 加载器自实现 |

### 1.4 关键核查:CC 第一种 agent(身份锚定型)在 DSH 中不存在

用户关心的核心前置条件,源码确认结论:

- DSH 的 subagent 工具参数为 `{description, prompt, run_in_background?}`(`packages/subagent/tool-subagent/src/index.ts:307`),即**现场传 prompt**(CC 第二种/Task 语义),**没有前置身份锚点**。
- 没有"预注册 agent 目录 + description 列表注入主上下文 + 模型自动选择"的机制(`listChildren()` 只是枚举已创建的运行中子代理)。
- 已有零件:
  - **persona**:`SubagentStartRequest.persona`(能力标志 `persona`),作为 scoped `deployment:persona` section 注入子代理系统提示词,shadow 部署级 persona → **可复用为身份锚定通道**
  - **agent-presets**(`ctx.agentPresets`,`agent.cordis.yml`):创建期挂载的预设组合,子代理继承父 preset(`composeFrom`)→ 偏"整 agent 配置",非"subagent 身份目录"
  - **派发通道**:`ctx.subagents.start()` 支持 persona/toolFilter/maxDepth/outputSchema

**结论:第一种 agent 需要加载器在 DSH 之上补"agent 目录 + 路由"层;身份注入复用 persona 通道。** 这是完全可行的,且不改 DSH 源码。

### 1.5 关键核查:LSP 可通过 MCP 桥接解决

- Claude Code 的 LSP 是 2026 年才内置的新功能(built-in LSP tool + Code Intelligence 插件),**不是 MCP**。
- 但存在成熟的 **LSP→MCP 桥**生态:`mcpls`(universal bridge,零配置多语言)、`agent-lsp`(单二进制,65 工具 / 30 语言)、`mcp-lsp-bridge`、`lsp-mcp` 等。这些桥是 MCP 服务器,内部拉起语言服务器进程,把 LSP 能力包装成 MCP 工具。
- 因此 CC `.lsp.json` 的映射路径:**加载器把语言 + 项目根传给桥 → 桥自动拉起对应语言服务器 → 注册为 DSH 的 `dsh-mcp-client` 行**。DSH 零新代码。
- 限制:桥大多按内置语言映射路由,不直接读 `.lsp.json` 的自定义 `{language → {command,args}}` 配置;冷门/自定义语言服务器需看桥是否支持自定义启动配置,否则降级为"跳过并报告"。

---

## 2. 生态架构:社区基座 + 拆分 + 补全 + 全家桶

**策略定案(用户方向)**:
1. **基座**:采用社区插件 `dsh-claude-compat`(MIT)为基座,fork 为 `dsh-cc-skills`,不从头造
2. **拆分**:每个 CC 组件独立成插件包,可单独 `dsh plugin add`
3. **补全**:社区空白(agents、hooks 发现层、MCP 运行时、LSP、marketplace、misc)由我们实现
4. **全家桶**:`dsh-cc` meta 包一键安装全部 = 完全兼容,同时保留单装

来源决策三层:**first-party 官方包直接依赖**(不重造)、**忠实语义社区插件 fork 为基座**(带 MIT 署名)、**社区空白自己做**(补全)。

### 2.0 社区现状核查(2026-08 源码实测)

| 社区项目 | 覆盖 | 与我们的关系 |
|---|---|---|
| `biedongbin/dsh-claude-compat`(MIT,v0.2) | 项目级 `.claude/` 的 skills/commands/rules 运行时桥(单文件插件:skill provider + `agent/pre-step` 消息流注入,CC `prependUserContext` 信封) | **基座**:fork → `dsh-cc-skills` |
| `@deepseek-ai/dsh-hooks-claude-code`(DSH 官方) | CC hooks 配置原样运行,7/31 事件,仅 command 类型,configPath 进程级(无 per-session 发现) | **直接依赖**:`dsh-cc-hooks` 补发现层 + 扩展 |
| `sjh9714/dsh-movein` | 一次性搬家(链接/复制进 `~/.dsh`,非运行时加载);`.claude/agents` 有损转技能 | 互补(迁移场景),不依赖 |
| `YYTbit/dsh-plugin-claude-bridge` | memory/skills/config 桥 | 重叠少,记录取舍 |
| `truelove-dreamer/dsh-plugin-hooks` | 自创配置格式的 pre/post-tool hooks(**非 CC 格式**) | 不采用(语义不忠实) |
| `cms19859230182-lang/dsh-import` | Codex/CC/Cursor 导入 | 互补 |

**基座选择理由**:dsh-claude-compat 是唯一"运行时加载 `.claude` 资产"的忠实实现(其余是迁移/转换),MIT 可 fork,代码质量高(skill provider 契约、`prependUserContext` 信封、按会话 cwd 缓存都是对的),且只覆盖 3/12 组件 → 拆分与补全空间清晰。

**基座源码要点**(已读,拆分时全部复用):
- `ClaudeCompatSkillProvider`:list() 扫 `.claude/skills/**/SKILL.md`(递归≤3 层,名字扁平化 kebab-case)+ `.claude/commands/*.md`(扁平);get() 按需读正文
- rules 注入:`agent/pre-step` 监听,一次性注入 user-role `<system-reminder>`(# claudeMd 信封)到消息数组最前,按会话 cwd 缓存
- 边界:仅项目级(`findProjectRoot` 向上找 `.git` 等标记),**不含全局 `~/.claude`** ← 我们的补全点之一

### 2.1 插件包划分(定案)

| 包名 | 职责 | 来源 | 依赖 | 里程碑 |
|---|---|---|---|---|
| `dsh-cc-skills` | `.claude` + 插件 的 skills/commands/rules → DSH skill provider + 消息流注入 | **fork dsh-claude-compat** + 补全局 `~/.claude` | — | M1 |
| `dsh-cc-agents` | `.claude/agents` + 插件 agents → 目录 + persona 派发 | 补全 | skills(frontmatter 工具), subagents | M2 |
| `dsh-cc-hooks` | hooks.json 发现/合并 + 官方桥接线 + 事件扩展 | 补全(语义用官方桥) | **官方桥** | M2 |
| `dsh-cc-mcp` | `.mcp.json` → dsh-mcp-client 运行时行(env 不内联) | 补全 | — | M3 |
| `dsh-cc-lsp` | `.lsp.json` → LSP→MCP 桥(mcpls/agent-lsp) | 补全 | mcp | M3 |
| `dsh-cc-marketplace` | marketplace 安装/更新/缓存/CLI、userConfig | 补全 | loader | M4 |
| `dsh-cc-loader`(共享库) | plugin.json/marketplace 解析、组件清点、安全核查、兼容报告 | 自研纯解析 | — | M4 |
| `dsh-cc-misc` | monitors/output-styles/themes/settings/bin:报告/降级映射 | 补全 | — | M5 |
| `dsh-cc`(**全家桶 meta 包**) | dependencies 声明全部组件包,`dsh plugin add dsh-cc` = 完全兼容 | 自研 | 全部 | M5 |

> 依赖方向:组件包互不依赖(或仅依赖共享库/官方包),可独立安装、独立演进、独立卸载;`dsh-cc` 聚合一切。

### 2.2 加载核心(loader)职责

```
输入: marketplace 路径 / plugin 目录 / --plugin-dir 式直挂
  ↓ 发现
识别 .claude-plugin/plugin.json 或 .codex-plugin/plugin.json;marketplace.json 展开
  ↓ 解析(纯函数,零副作用)
组件清点:skills/commands/agents/hooks/mcp/lsp/workflows/output-styles/monitors/themes/bin/settings
每个组件标记:DIRECT(直接映射) / ADAPTED(改造映射) / UNSUPPORTED(无落点) / BLOCKED(安全问题)
  ↓ 注册
对每个支持组件,调用对应适配器插件的注册接口(ctx.ccLoader.registerComponent(...))
  ↓ 报告
输出兼容性报告(组件级 状态 + 原因),含源码映射与摘要
```

**安全模型(必守)**:
- plugin 是**未信任输入**:加载过程不执行插件内任何代码(不跑 lifecycle scripts / hooks / MCP / LSP / bin),只解释声明式资产
- 拒绝:路径逃逸(`../`)、内嵌凭据、危险 symlink(复用 dsh-compat 的核查思路)
- 运行时组件(hooks/MCP/LSP 的 command)以 DSH 进程权限执行 → 默认要求显式启用 + 可信 profile,安装时警告
- 秘密:`.mcp.json`/`.lsp.json` 中的 env 值不内联进生成配置,只登记名字,由用户经 DSH 凭据库绑定

### 2.3 命名空间(对齐 CC 语义)

CC 用 `plugin-name:skill/agent/command` 命名空间防冲突。DSH 加载器沿用:
- 技能 → `cc:<plugin>:<skill>` 或注册时带来源标记
- agent 目录项 → `cc:<plugin>:<agent>`(注入主上下文的名字)
- 命令 → `/<plugin>:<command>` 形式

冲突策略:同名插件/组件,**后加载者失败并报告**(fail loud,不静默覆盖),与 DSH 插件风格一致。

---

## 3. 组件映射细则

### 3.1 Skills / Commands(✅ 原生,P0)

- `skills/<name>/SKILL.md` → `ctx.skills` 注册(DSH 原生 skill,SKILL.md 格式互通,含 frontmatter description)
- `commands/*.md` → DSH 命令系统(斜杠命令)
- `$ARGUMENTS` 占位符 → 映射为 DSH 命令参数语义
- 插件根单 `SKILL.md`(无 skills/ 目录)→ 单技能插件

### 3.2 Agents(⚠️ 需补目录+路由层,P1)

CC 第一种 agent 的还原(加载器自实现,复用 persona 通道):

```
agents/<name>.md
  ├─ frontmatter: name / description / tools / disallowedTools / model / effort / maxTurns / skills / memory / background / isolation
  └─ 正文: 系统提示词

加载时:
  1. 解析 frontmatter + 正文
  2. 注册 agent 目录:把 {name, description} 列表注入主 agent 上下文
     (实现选项:自定义工具 / system-prompt section,见 4.2)
  3. 派发:主模型选定 agent 后,
     persona = 正文(系统提示词)      ← DSH 原生通道(SubagentStartRequest.persona)
     prompt  = 现场任务内容
     tools   = frontmatter.tools 转 toolFilter(需 provider toolFilter 能力)
     model   = frontmatter.model 转 agentOptions
     → ctx.subagents.start(name, request)
```

**CC 未支持的安全约束照搬**:plugin 自带 agent 不支持 hooks/mcpServers/permissionMode(CC 官方也禁止,保持同语义)。

### 3.3 Hooks(✅ 官方桥 + 我们补发现层,M2)

**决策:hook 语义不自己造**,直接依赖 DSH 官方 first-party 桥 `@deepseek-ai/dsh-hooks-claude-code`(+ 配套库 `@deepseek-ai/dsh-hook-protocol`)。

官方桥已做到的(源码核实,`packages/hooks/hooks-claude-code`):
- CC hooks 配置(`hooks.json` 或 settings 的 `hooks` key)**原样运行**,不转换
- 忠实还原:CC 逐事件 stdin payload、`${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PROJECT_DIR}` 替换、matcher/退出码语义、最严格折叠(deny > ask > allow)
- 已映射 7/31 事件:SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop、SubagentStart、SubagentStop(其余解析即跳过)
- 仅 `type: 'command'`;http/mcp_tool/prompt/agent 解析即跳过并警告

官方桥限制 = 我们的补全空间(`dsh-cc-hooks`):

| 限制 | 补全方案 |
|---|---|
| configPath 进程级,一份配置管整个进程,无 per-session/per-plugin 发现(`TODO(per-session-hook-config)`) | 发现项目 `.claude/hooks`、全局 `~/.claude/hooks`、各插件 `hooks/hooks.json` → 合并为桥配置,支持热重载 |
| 7/31 事件 | 基于 `dsh-hook-protocol` 库扩展更多事件点(视 DSH 事件面粒度) |
| 非 command 动作 | 能力分级报告(M3 起) |

路径变量:`${CLAUDE_PLUGIN_ROOT}` → 插件目录、`${CLAUDE_PROJECT_DIR}` → 会话 cwd、`${CLAUDE_PLUGIN_DATA}` → DSH 持久目录;命令经 shell 执行时**拒绝 ${user_config.*} 内联**(与 CC 同语义)。

### 3.4 MCP(✅ 原生,P1)

- `.mcp.json` / plugin.json 内联 → 生成 `dsh-mcp-client` 配置行
- env 值:不内联,登记名字 → DSH 凭据/配置引用
- 工具名保持 `mcp__server__tool` 语义(DSH 原生一致)
- 插件内 MCP 的命名空间引用(`mcp__plugin_<name>_<server>__<tool>`)→ 映射为 DSH 工具名

### 3.5 LSP(⚠️ 走 MCP 桥,P2)

```
.lsp.json { language → {command, args, extensionToLanguage} }
  ↓
适配器:语言 + 项目根 → LSP→MCP 桥(mcpls / agent-lsp)配置
  ↓
注册为 dsh-mcp-client 行 → agent 获得 mcp__*__get_hover / get_references / diagnostics
```

- 常见语言(Go/Python/TS/Rust 等):桥内置映射,零成本
- 自定义命令:桥支持自定义启动配置则透传,否则 UNSUPPORTED 报告
- 语言服务器二进制必须已在 PATH(与 CC 同要求,加载器不安装)

### 3.6 其余组件(P3,跳过+报告)

| 组件 | 处理 |
|---|---|
| Workflows | 报告;若 DSH workflow 引擎可承载则 ADAPTED(评估后) |
| Output styles | 报告(DSH 无输出风格系统) |
| Monitors | 报告(DSH 无后台监控;未来可映射为 background jobs) |
| Themes | 可降级映射 DSH Web UI 主题(评估后) |
| bin/ | 报告(不注入 DSH shell PATH,安全边界) |
| settings.json | 仅 agent/subagentStatusLine 两 key,DSH 侧无落点 → 报告 |

---

## 4. 关键设计决策(待定项)

### 4.1 资产来源:就地读取 vs 缓存复制
- **就地读取**(类似 CC `--plugin-dir` 与 skills-dir 插件):plugin 目录被 DSH 直接解释,改动即生效 → 开发友好,推荐默认
- **缓存复制**(类似 CC marketplace 安装):marketplace 安装的插件复制到 DSH 缓存,版本化 → 生产友好
- 决定:两种都支持;P0 先做就地读取,P2 做 marketplace 缓存

### 4.2 agent 目录注入方式(待定,实现时验证)
- 选项 A:自定义工具(如 `cc_agents`),模型查询可用 agent 列表后按名派发 → 显式,可控
- 选项 B:system-prompt section,把全部 agent 的 name+description 注入(类似 CC 的 @-mention 语义)→ 隐式,模型自动选择
- 倾向:B 为主(还原 CC 语义),A 作为可切换的显式模式

### 4.3 与现有 DSH 插件的边界(依赖策略定案)
- **first-party 官方包直接依赖**:`@deepseek-ai/dsh-hooks-claude-code` + `@deepseek-ai/dsh-hook-protocol`(随核心维护,不重造)
- **社区插件 fork 为基座**:`dsh-claude-compat`(MIT)→ `dsh-cc-skills`,保留版权署名
- **社区插件不采用**:`dsh-plugin-hooks`(自创格式,不忠实 CC)、`dsh-compat`(转换路线,与本生态运行时加载互不替代)
- **互补共存**:`dsh-movein`(一次性迁移)、`dsh-import`、`dsh-plugin-claude-bridge`(记录取舍)

### 4.4 双格式插件(DSH + CC 双形态)
生态中已有"同一能力双形态发布"的插件(如 pptfast、multimodal-bridge)。本生态的目标不是让它们统一,而是让 DSH 能直接消费 CC 形态。

---

## 5. 实现步骤(详见 IMPLEMENTATION.md 里程碑 M1–M5)

按"基座 → 拆分 → 补全 → 全家桶"推进:
- **M1** `dsh-cc-skills`:fork 社区基座(项目级 `.claude` 开箱即用)+ 补全局 `~/.claude` → 首个可演示
- **M2** `dsh-cc-agents` + `dsh-cc-hooks`:身份 agent(persona 派发)+ hooks 发现层(依赖官方桥)
- **M3** `dsh-cc-mcp` + `dsh-cc-lsp`:运行时 MCP 行 + LSP→MCP 桥
- **M4** `dsh-cc-loader` + `dsh-cc-marketplace`:plugin 格式与 marketplace 源
- **M5** `dsh-cc-misc` + `dsh-cc` 全家桶 + 安全审查/测试矩阵/发布

---

## 6. 验证方法

- **解析正确性**:对 `cc-plugin-study` 全部 94+ 插件跑 loader,输出兼容性报告,人工抽检
- **行为正确性**:加载 1-2 个代表性插件(skills 丰富如 `agent-teams`,带 hooks 如 `protect-mcp`),在 DSH 中实际调用 skill/agent/hook,验证语义
- **安全**:静态扫描插件(不执行),断言无路径逃逸/内联秘密;运行时组件默认禁用
- **回归**:DSH 版本升级时,加载器锁版本(对齐 dsh-compat 的 pin 做法)

---

## 7. 风险与开放问题

1. **agent 目录注入(A/B 方案)对模型行为的影响未实测** —— Phase 2 前做小实验验证
2. **hooks 事件语义差异**:CC 31 事件 vs DSH 事件流,逐事件对齐表需在实现中更新
3. **LSP 桥的 `.lsp.json` 自定义配置透传**:取决于桥能力,冷门语言可能只能报告
4. **marketplace 的 `command` source 与 link 模式**(CC 高级特性)暂不实现,P3 评估
5. **CC plugin 生态在快速演进**(2026 年新增组件如 monitors/workflows 还在实验期),加载器需容忍未知组件(报告而非崩溃)
