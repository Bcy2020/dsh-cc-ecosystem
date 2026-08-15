# dsh-cc-ecosystem

Load Claude Code `.claude/` assets (skills, commands, rules, permissions) into DeepSeek Harness as a DSH plugin ecosystem.

把 Claude Code 的 `.claude/` 资产(技能 / 命令 / 规则 / 权限)以 DSH 插件生态的形式加载进 DeepSeek Harness。

> **设计核心**:一个**内存 IR 解析层**(`dsh-cc-loader`)把 `.claude` 解析成独立中间表示,不落盘、零写路径——单一事实来源永远是 `.claude` 原文,与 Claude Code 天然同步;每个 CC 组件对应一个独立插件包,可单独安装、独立演进。权限是**只读桥**:CC `settings.json` 的 allow/deny/ask 规则在 DSH 上强制,DSH 侧审批不写回 `.claude`。

## Packages

| 包 | 职责 | 状态 |
|---|---|---|
| [dsh-cc-loader](packages/cc-loader) | 共享解析层:`.claude`(项目 + 全局 `~/.claude`)→ 内存 IR;组件分类 DIRECT/ADAPTED/UNSUPPORTED;权限规则语法解析与 deny→ask→allow 求值 | ✅ M1 |
| [dsh-cc-skills](packages/cc-skills) | 适配器:IR skills/commands → DSH skill provider;rules 按 CC `prependUserContext` 信封注入会话 | ✅ M1 |
| [dsh-cc-permissions](packages/cc-permissions) | 适配器:`tools/pre-execute` 门强制 CC 权限规则;裸名 deny 隐藏工具;`defaultMode=dontAsk` → 审批 never | ✅ M1.5 |

规划中:M2 `dsh-cc-agents`(persona 派发)+ `dsh-cc-hooks`(官方桥发现层)、M3 `dsh-cc-mcp` + `dsh-cc-lsp`、M4 loader/marketplace、M5 `dsh-cc` 全家桶 meta 包。

## 支持的 CC 权限语义(与 Claude Code 一致)

- 规则语法 `Tool` / `Tool(spec)`:Bash/PowerShell 命令 glob(`*`、`:*` 后缀、词边界)、Read/Edit gitignore 路径锚定(`//` 绝对、`~/` 家目录、`/` 相对 settings 源)、`WebFetch(domain:…)`、`mcp__server__tool`、`Agent(name)`、`Skill(name)`、`Tool(param:value)`
- 求值顺序 **deny → ask → allow**,特异性不改变顺序;裸工具名 deny 从上下文移除工具
- Bash 复合命令拆分(`&& || ; | &` 等)、wrapper 剥离(`timeout`/`nice`/`nohup`…)、前置 env 剥离;PowerShell 别名规范化(`del`/`rm`/`ri` → `Remove-Item`)
- Read deny 同时拦 Edit/Write 工具与 Bash 文件命令(`cat`/`head`/`tail`/`sed`…)
- Windows 路径 POSIX 化(`C:\Users\alice` → `/c/Users/alice`,规则写 `//c/**`)

## 安装

```sh
# 先装共享库,再装插件(开发期本地 checkout 需在包内 pnpm link ../cc-loader)
dsh plugin --profile <name> add dsh-cc-loader dsh-cc-skills dsh-cc-permissions
```

本地 patch 挂载(Web profile 热更新)见各包 README;Windows 绝对路径必须 `file:///` 前缀。

## 验证

- 单元测试:`node --test test/loader.test.mjs`(36 用例:规则解析 / 模式编译 / 求值 / IR 加载)
- 真实项目验证:`node test/validate-demo.mjs`(对带真实 skill + 权限配置的项目做端到端求值)

## License

MIT — `dsh-cc-skills` 为 [dsh-claude-compat](https://github.com/biedongbin/dsh-claude-compat)(MIT, © biedongbin) 的派生;`dsh-cc-loader` 的发现逻辑亦源自该基座。
