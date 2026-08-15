# dsh-cc-ecosystem

Load Claude Code `.claude/` assets (skills, commands, rules, permissions, agents, hooks) into DeepSeek Harness as a DSH plugin ecosystem.

把 Claude Code 的 `.claude/` 资产(技能 / 命令 / 规则 / 权限 / 子代理 / hooks)以 DSH 插件生态的形式加载进 DeepSeek Harness。

> **设计核心**:一个**内存 IR 解析层**(`dsh-cc-loader`)把 `.claude` 解析成独立中间表示,不落盘、零写路径——单一事实来源永远是 `.claude` 原文,与 Claude Code 天然同步;每个 CC 组件对应一个独立插件包,可单独安装、独立演进。权限是**只读桥**:CC `settings.json` 的 allow/deny/ask 规则在 DSH 上强制,DSH 侧审批不写回 `.claude`。

## Packages

| 包 | 职责 | 状态 |
|---|---|---|
| [dsh-cc-loader](packages/cc-loader) | 共享解析层:`.claude`(项目 + 全局 `~/.claude`)→ 内存 IR;组件分类 DIRECT/ADAPTED/UNSUPPORTED/BLOCKED;权限规则语法解析与 deny→ask→allow 求值;agent 目录发现与分类 | ✅ M1 |
| [dsh-cc-skills](packages/cc-skills) | 适配器:IR skills/commands → DSH skill provider;rules 按 CC `prependUserContext` 信封注入会话(仅顶层会话) | ✅ M1 |
| [dsh-cc-permissions](packages/cc-permissions) | 适配器:`tools/pre-execute` 门强制 CC 权限规则;裸名 deny 隐藏工具;`defaultMode=dontAsk` → 审批 never | ✅ M1.5 |
| [dsh-cc-agents](packages/cc-agents) | 适配器:`.claude/agents`(身份锚定子代理)→ 会话启动注入 agent 目录(CC @-mention 语义)+ `cc_agent` 派发工具(persona = 正文,`tools`/`disallowedTools` → toolFilter,`skills` 预载,`model` 经 `modelAliases` 映射) | ✅ M2 |
| [dsh-cc-hooks](packages/cc-hooks) | 适配器:发现项目/全局/插件 `hooks.json` → 合并 → 经 `dsh-hook-protocol`(官方库)按 CC 语义运行(7 事件,command 型),per-session 发现突破官方桥进程级限制 | ✅ M2 |

规划中:M3 `dsh-cc-mcp` + `dsh-cc-lsp`、M4 loader/marketplace、M5 `dsh-cc-misc` + `dsh-cc` 全家桶 meta 包。

## 支持的 CC 权限语义(与 Claude Code 一致)

- 规则语法 `Tool` / `Tool(spec)`:Bash/PowerShell 命令 glob(`*`、`:*` 后缀、词边界)、Read/Edit gitignore 路径锚定(`//` 绝对、`~/` 家目录、`/` 相对 settings 源)、`WebFetch(domain:…)`、`mcp__server__tool`、`Agent(name)`、`Skill(name)`、`Tool(param:value)`
- 求值顺序 **deny → ask → allow**,特异性不改变顺序;裸工具名 deny 从上下文移除工具
- Bash 复合命令拆分(`&& || ; | &` 等)、wrapper 剥离(`timeout`/`nice`/`nohup`…)、前置 env 剥离;PowerShell 别名规范化(`del`/`rm`/`ri` → `Remove-Item`)
- Read deny 同时拦 Edit/Write 工具与 Bash 文件命令(`cat`/`head`/`tail`/`sed`…)
- Windows 路径 POSIX 化(`C:\Users\alice` → `/c/Users/alice`,规则写 `//c/**`)
- Bash 与 PowerShell 是**独立工具**(`Bash(rm -rf *)` 不覆盖 pwsh),规则各自生效

## 支持的 CC agents 语义

- `.claude/agents/*.md`(项目 > 全局优先级):frontmatter `tools`/`disallowedTools`/`model`/`skills`/`background`/`initialPrompt` + 正文 = 系统提示词
- `cc_agent` 派发:persona 通道注入身份;`tools` 白名单 → `toolFilter.allow`,`disallowedTools` 黑名单 → `toolFilter.deny`(CC 桶名如 `Read`/`Bash` 自动展开为 DSH 工具名);`skills` 预载全文;`model` 只经 `modelAliases` 映射(CC 模型名不直传)
- 分类:`isolation: worktree` → BLOCKED 不出现在目录;`hooks`/`mcpServers`/`permissionMode` → UNSUPPORTED 忽略并报告(CC 对插件 agent 同样禁止)

## 安装

```sh
# 先装共享库,再装插件(开发期本地 checkout 需在包内 pnpm link ../cc-loader)
dsh plugin --profile <name> add dsh-cc-loader dsh-cc-skills dsh-cc-permissions dsh-cc-agents dsh-cc-hooks
```

本地 patch 挂载(Web profile 热更新)见各包 README;Windows 绝对路径必须 `file:///` 前缀。

> **HMR 提示**:改插件源码后需重启 GUI 生效(hmr watcher 只可靠监视 profile 目录内文件);`cordis.patch.yml` 覆盖已存在条目(bundle 里的)要用非 insert 顶层条目按 id 定位,`- insert:` 只追加不覆盖。

## 验证

- 单元测试:`node --test test/loader.test.mjs`(36 用例)+ `test/agents.test.mjs`(7 用例)+ `test/hooks-merge.test.mjs`(11 用例)
- 真实项目验证:`node test/validate-demo.mjs`(对带真实 skill + 权限配置的项目做端到端求值)
- 端到端演示项目:`../cc-demo-project/`(真实 anthropics 技能 + 权限 + agents + hooks,README 含 11 组测试提示词与预期行为速查)

## License

MIT — `dsh-cc-skills` 为 [dsh-claude-compat](https://github.com/biedongbin/dsh-claude-compat)(MIT, © biedongbin) 的派生;`dsh-cc-loader` 的发现逻辑亦源自该基座。hooks 语义基于官方 `@deepseek-ai/dsh-hook-protocol`。
