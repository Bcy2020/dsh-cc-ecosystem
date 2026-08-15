# DSH × CC 兼容生态 —— 实现计划(社区基座版)

> 配套文档:`DESIGN.md`(架构与映射细则)
> 版本:0.2 — 策略更新:**社区基座 + 拆分 + 补全 + 全家桶**
> 本文给出可执行实现步骤:里程碑、包划分、接口草案、验收标准。

---

## 0. 策略与依赖图

**策略定案(用户方向)**:
1. **基座**:采用社区插件 `dsh-claude-compat`(MIT)为基座,fork 为 `dsh-cc-skills`(保留版权署名)
2. **拆分**:每个 CC 组件独立 npm 包,可单独 `dsh plugin add`
3. **补全**:社区空白(agents、hooks 发现层、MCP 运行时、LSP、marketplace、misc)由我们实现
4. **全家桶**:`dsh-cc` meta 包一键安装全部 = 完全兼容;单装保留

```
dsh-cc-skills ──────┐ (fork dsh-claude-compat + 补全局 ~/.claude)   M1
dsh-cc-agents ──────┤ (补全:persona 派发)                           M2
dsh-cc-hooks ───────┤ (补全:发现层;语义用官方桥)                     M2
dsh-cc-mcp ─────────┤ (补全:.mcp.json 运行时行)                      M3
dsh-cc-lsp ─────────┤ (补全:LSP→MCP 桥)                             M3
dsh-cc-marketplace ─┤ (补全:安装/更新/缓存/CLI)                      M4
dsh-cc-loader ──────┤ (共享库:plugin 解析/清点/安全/报告)             M4
dsh-cc-misc ────────┘ (补全:报告/降级)                               M5
        └── dsh-cc(全家桶 meta 包,依赖全部)                          M5
```

测试集(全程复用):`cc-plugin-study/agents`(94 插件)、`cc-plugin-study/superpowers-marketplace`,以及本机 `~/.claude` 实测。

---

## M1 — `dsh-cc-skills`(基座落地,首个可演示)

### 目标
社区基座 fork 落地 + 补全局用户级目录:项目/全局 `.claude` 的 skills/commands/rules 在 DSH 可用。

### 步骤
1. fork `biedongbin/dsh-claude-compat`(MIT,保留版权声明)→ 包名 `dsh-cc-skills`,`dsh` bundle 元数据对齐
2. 基座代码评审(已读 `src/index.js`),全部复用:
   - `ClaudeCompatSkillProvider`(list/get 契约、递归扫 skills≤3 层、名字扁平化 kebab-case、commands 扁平)
   - rules 注入(`agent/pre-step` + `createUserMessage`,`# claudeMd` 信封,按会话 cwd 缓存)
   - frontmatter 解析 / invocation policy / 项目根发现(向上找 `.git` 等标记)
3. **补全**:全局 `~/.claude`(用户级 skills/commands/rules)与项目级合并;rank 区分(项目 > 用户)
4. 发布 npm + `dsh plugin --profile <p> add dsh-cc-skills`

### 接口草案(继承基座 + 新配置项)

```ts
// 新增配置(基座 Config 之上)
globalClaudeDir: string        // 默认 ~/.claude,可禁用
globalSkillRank: number        // 默认 160(数值大于项目级 150 → 优先级更低,项目级优先)
enableGlobal: boolean          // 默认 true
```

### 验收
- [ ] 项目 `.claude/skills/**/SKILL.md` + `.claude/commands/*.md` 开箱即用(继承基座)
- [ ] 全局 `~/.claude/skills` / `commands` / `rules` 同样生效(补全)
- [ ] 同名冲突:项目级覆盖用户级(fail loud 记警告)
- [ ] rules 以 user-role `<system-reminder>` 信封注入、每会话一次、按 cwd 缓存(继承语义)
- [ ] 卸载插件全部回滚
- [ ] 基座 MIT 版权声明保留在 README/源码头

---

## M2 — 运行时组件:`dsh-cc-agents` + `dsh-cc-hooks`

### 2a. `dsh-cc-agents`(补全,核心难点)

`.claude/agents/*.md` + 插件 `agents/*.md` → 目录 + persona 派发(CC 第一种 agent)。

```
agents/<name>.md
  ├─ frontmatter: name / description / tools / disallowedTools / model / effort / maxTurns / skills / memory / background / isolation
  └─ 正文: 系统提示词

加载时:
  1. 解析 frontmatter + 正文(复用 dsh-claude-compat 的 frontmatter 解析思路)
  2. 注册 agent 目录:{name, description} 列表注入主上下文
     (方案 B:system-prompt section,还原 CC @-mention 语义 —— 倾向;方案 A:cc_agents 工具)
  3. 派发: ctx.subagents.start({
       persona: agent.systemPrompt,      // ← 身份锚定,DSH 原生通道
       prompt: taskPrompt,               // 现场任务
       toolFilter: toToolFilter(tools, disallowedTools),  // 需 provider toolFilter 能力
       agentOptions: { model },          // frontmatter.model
       label: `cc:<plugin>:<name>`,
     })
```

**注入方案小实验先行**:同任务 A/B 各跑 5 次,比较选中准确率与 token 开销,定案。

### 验收
- [ ] `~/.claude/agents/*.md` 与插件 agents 注册进目录
- [ ] 主模型按 description 自动选 agent(小实验通过)
- [ ] 子代理系统提示词 = agent 正文(persona 生效,空 prompt 也能跑)
- [ ] frontmatter.tools → toolFilter;model → agentOptions
- [ ] CC 官方禁止项(hooks/mcpServers/permissionMode)同样禁止

### 2b. `dsh-cc-hooks`(补全发现层,语义用官方桥)

```
发现(我们的):~/.claude/hooks、<project>/.claude/hooks、各插件 hooks/hooks.json
  ↓ 合并
统一配置 → @deepseek-ai/dsh-hooks-claude-code(官方桥,CC 语义原样,不重造)
```

```ts
interface CcHooksAdapter {
  discover(cwd: string): Promise<HookConfig[]>   // 项目/全局/插件 hooks.json
  merge(configs: HookConfig[]): string           // 合并 → 桥的 configPath 内容
  reload(): void                                 // 热重载(桥配置更新)
}
```

### 验收
- [ ] 项目 `.claude/hooks/hooks.json` 的 PreToolUse/PostToolUse 语义正确(阻断/放行)
- [ ] 插件 `hooks/hooks.json` 发现并生效(每插件一份配置,突破桥的进程级限制)
- [ ] 7/31 事件之外的 hook 事件:报告不崩溃
- [ ] 非 command 动作:解析跳过 + 警告(官方桥行为)
- [ ] 依赖官方桥时 pin 与宿主 DSH 同版本(参考 dsh-movein 踩坑记录)

---

## M3 — `dsh-cc-mcp` + `dsh-cc-lsp`

### 3a. `dsh-cc-mcp`(补全)
`.mcp.json`(项目/插件)→ dsh-mcp-client 运行时配置行:
- env 值只登记名字不内联(秘密走 DSH 凭据/配置引用)
- 工具名保持 `mcp__server__tool` 语义
- 与用户已有 MCP 配置命名空间隔离

### 验收
- [ ] 生成配置行,env 不内联
- [ ] 启用后 DSH 工具列表出现 `mcp__<server>__<tool>`
- [ ] 与既有配置无冲突

### 3b. `dsh-cc-lsp`(补全,走 MCP 桥)
```
.lsp.json { language → {command, args} }
  ↓
语言 + 项目根 → LSP→MCP 桥(mcpls / agent-lsp,先验证 Windows 可用性)
  ↓
注册为 dsh-mcp-client 行 → agent 获得 mcp__*__get_hover / get_references / diagnostics
```
- 常见语言(Go/Python/TS/Rust)桥内置映射,零成本
- 自定义命令:桥支持自定义启动配置则透传,否则 UNSUPPORTED 报告
- 语言服务器二进制必须已在 PATH(与 CC 同要求,加载器不安装)

### 验收
- [ ] 含 .lsp.json 的测试插件加载后,DSH agent 能调 `get_hover`/`get_references`
- [ ] 不支持的语言在兼容报告中标注,不崩溃

---

## M4 — plugin 源:`dsh-cc-loader` + `dsh-cc-marketplace`

### `dsh-cc-loader`(共享库,纯解析)
```
packages/cc-loader/src/
├── manifest.ts       # plugin.json 解析 + schema 校验(容忍未知字段)
├── marketplace.ts    # marketplace.json 解析(source 本地/git/command 分类)
├── components.ts     # 组件清点:skills/commands/agents/hooks/mcp/lsp/...
├── classify.ts       # DIRECT / ADAPTED / UNSUPPORTED / BLOCKED + 原因
├── security.ts       # 静态安全核查:路径逃逸、内联秘密、危险 symlink(不执行)
└── report.ts         # 兼容性报告(md + json)
```

### `dsh-cc-marketplace`(补全)
- marketplace 安装/更新/卸载/缓存(`~/.dsh/cc-plugins/cache/<plugin>@<version>`)
- `userConfig` → DSH 配置面板(types: string/number/boolean/directory/file,sensitive 走凭据库)
- CLI:`dsh cc add <marketplace-url>` / `dsh cc list` / `dsh cc remove`
- 家族包获得 plugin 源支持(loader 的 `PluginInventory` 驱动各适配器)

### 验收
- [ ] `cc-plugin-study/agents` 全部 94 插件跑 inspect 无崩溃,报告含组件状态+原因
- [ ] `superpowers-marketplace` 正确展开(source=url 分类)
- [ ] 从 marketplace 安装→加载→更新→卸载全流程
- [ ] security 能检出:路径逃逸、settings 内联秘密、plugin 根外 symlink

---

## M5 — `dsh-cc-misc` + `dsh-cc` 全家桶 + 打磨

- `dsh-cc-misc`:monitors/output-styles/themes/settings/bin → 报告/降级映射(能映射的降级,不能的**跳过并报告**,不崩溃)
- `dsh-cc`:**meta 包**,dependencies 声明全部组件包;`dsh plugin add dsh-cc` 一键 = 完全兼容;单装仍可用
- 安全审查:加载全流程零执行(仅解释)、路径逃逸拒绝、秘密不落盘
- 全量测试矩阵:两个 marketplace 全插件跑报告,人工抽检 10 个
- 发布:每包独立 `pnpm build` + `dsh plugin add` 安装验证;文档定稿

---

## 并行与依赖

| 里程碑 | 可并行 | 前置 |
|---|---|---|
| M1 skills(基座 fork) | — | — |
| M2a agents | M2b hooks 可并行 | M1(frontmatter 工具) |
| M2b hooks | 同左 | 官方桥(pin 宿主 DSH 版本) |
| M3a mcp / M3b lsp | 互不阻塞 | — |
| M4 loader + marketplace | — | — |
| M5 misc + 全家桶 | — | M1–M4 |

## 首个可演示里程碑

**M1**:`dsh plugin add dsh-cc-skills` → 项目/全局 `.claude` 的 skills、commands、rules 全部在 DSH 生效(含新增的全局用户级补全)。第一轮迭代目标。
