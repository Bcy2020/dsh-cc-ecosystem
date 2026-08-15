# DSH 插件开发参考(本生态专用速查)

> 来源:DSH 官方文档(`docs/user/develop/basic/*`、`docs/cordis-tutorial/*`、`docs/cookbook/extension-cookbook.md`)+ 官方插件源码(`packages/hooks/hooks-claude-code`)+ 基座源码(`dsh-claude-compat`)
> 用途:本生态(dsh-cc-*)所有插件的开发基线。以官方文档/源码为准,此文件是速查与踩坑记录。

## 1. 插件是什么

插件 = 导出 `apply` 的模块(TS/JS 皆可)。框架加载时调用 `apply(ctx, config)`,你通过 `ctx` 注册能力;注册的一切(事件监听/工具/定时器)在插件卸载时**自动清理**,无需手动 remove。

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-cc-skills'        // 显示元数据(诊断用)
export const inject = ['skills']           // 依赖服务,就绪后才加载本插件;可空
export interface Config { enableGlobal: boolean; skillRank: number }
export const Config: Schema<Config> = Schema.object({
  enableGlobal: Schema.boolean().default(true),
  skillRank: Schema.number().default(160),
})
export function apply(ctx: Context, config: Config) {
  // 注册能力;需要手动清理的资源用 ctx.effect(() => () => cleanup())
}
```

- 三种形态:函数(默认)/ 对象(`{name, inject, apply}`)/ 类(`Service` 子类,向外提供服务时用)
- **配置原则**:凡不同部署取值可能不同的参数必须进 `Config`(无硬编码);schema 表达完备约束,非法配置加载即响亮失败
- **HMR**:改 `cordis.yml` 中 config → 旧实例卸载、新实例加载(注册自动清理)

## 2. 打包:组合包(bundle)

可安装包 = npm 包 + `dsh.bundle` 声明 + 一个 patch 层:

```
dsh-cc-skills/
├── package.json        # 声明 dsh.bundle
├── cordis.patch.yml    # profile 列出本 bundle 时应用的层
└── src/index.js        # patch 行引用的插件模块
```

```jsonc
// package.json
{
  "name": "dsh-cc-skills",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.js",
  "files": ["src", "cordis.patch.yml", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": { "yaml": "^2.0.0" },
  "peerDependencies": { "@deepseek-ai/dsh-skill": "*" /* 按需 */ }
}
```

```yaml
# cordis.patch.yml —— 插件行按包名引用(不是相对路径)
- insert:
    - id: cc-skills
      name: dsh-cc-skills
      config: {}          # 可带默认配置;用户可在自己 profile 覆盖整行
```

- **库(非插件)** 包不加 `dsh.bundle`,`dsh plugin` 只警告不激活层 —— 供插件 import 的共享代码用此格式(`dsh-cc-loader` 候选)
- 无 `dsh.bundle` 也非库的包:安装后不激活任何层

## 3. 安装与层顺序

```sh
dsh plugin --profile <name> add <pkg>          # npm 包
dsh plugin --profile <name> add ./path         # 本地 checkout
dsh plugin --profile <name> add github:you/x   # git 安装
```

生效配置叠加顺序(后应用层按行胜出,**整行 config 替换,非深合并**):
1. profile `dsh.profile.bundles` 各 bundle patch(按列表顺序)
2. profile 自己的 `cordis.patch.yml`
3. `$DSH_HOME/cordis.patch.yml`(机器级)
4. 每个 `--patch <path>` overlay

推论:patch 按 `id` 覆盖前面层的行时必须**重述全部键**;用户可在自己层覆盖我们的行 → 配置默认值要选用户大概率保留的。

**git 安装的坎**:拉的是源码,`build` 不自动跑 → ①作者提供自包含 `prepare` 脚本(如 `tsdown` 直接转译 src);②pnpm ≥10 要求用户在 profile 的 `pnpm-workspace.yaml` 显式 `allowBuilds: <pkg>: true` 才运行 git 依赖的 prepare。**npm 发布预构建产物则两者都不需要** → 本生态发布策略:npm 为主。

## 4. 本生态会用到的服务与事件(源码级)

| 能力 | 用法 | 参考 |
|---|---|---|
| skill provider | `ctx.skills.registerProvider(control => new P(ctx, control, config))`;P 实现 `list(options)`(按 `options.cwd` 发现)+ `get(candidate)`(按需读正文);`control.signal` 监听中止 | 基座 dsh-claude-compat 的 `ClaudeCompatSkillProvider` |
| subagent 派发 | `ctx.subagents.start(provider, { prompt, persona, toolFilter, agentOptions, label, parent, signal })`(persona = 身份锚定通道) | `docs/subsystems/subagent.md` |
| shell 执行 | `ctx.shell.run(...)`(hook/工具执行统一走它,自动套沙箱策略) | 官方桥 |
| `tools/pre-execute` | waterfall,返回 `{kind:'deny'|'ask'|'allow'}` 决策 | 官方桥 `PreToolUse` 映射 |
| `tools/post-execute` | waterfall,返回 `{kind:'block'|...}` + `additionalContexts` | 官方桥 `PostToolUse` 映射 |
| `agent/pre-step` | 改写/拒绝消息(规则注入、prompt 钩子) | 官方桥 `UserPromptSubmit`、基座 rules 注入 |
| `agent/session-start` | 会话起点(emit 型,detached 跑) | 官方桥 `SessionStart` |
| `agent/turn-stopping` | 停止边界,可 `agent.steer()` 强制继续 | 官方桥 `Stop` |
| `subagent/start` / `subagent/end` | 子代理生命周期(emit 型) | 官方桥 |
| 注入模型上下文 | `createUserMessage({content, source:{kind:'plugin',plugin:name}})` + `agent.inject(msg)` / 消息数组前插 | 官方桥 `PLUGIN_SOURCE`、基座 rules |

事件与决策类型全集:见 `docs/subsystems/core.md`(服务 API 区)与 `docs/event-producer-consumer.md`。

## 5. 官方桥结构(最完整参考样板)

`packages/hooks/hooks-claude-code/src/index.ts` 的骨架(我们 dsh-cc-hooks 直接依赖它,家族其他插件照此结构写):

1. `inject = ['shell']`(必需服务);其余服务用 `ctx.get(...)` 机会主义读取 → 部署可缺某些扩展点也能加载
2. `Config` = `configPath` + 替换根(pluginRoot/projectDir)+ 默认值(schema 内)
3. `apply`:加载时**解析一次**配置(失败仅 warn + 不注册,不崩启动)
4. 共享 runner `runPoint(point, matchQuery, payload, {agent, turn, signal})`:matcher 匹配 → 逐 hook 跑(`runHook(ctx.shell, ...)` 来自 `dsh-hook-protocol`)→ `mergeHookOutputs` 最严格折叠
5. 每事件 payload 按 **CC 方言**构造(`session_id/transcript_path/cwd/hook_event_name` + 事件字段)
6. 决策映射:deny/ask → typed decision;emit 型点(SessionStart/Subagent*)用 `createDetachedRuns()` 分离跟踪,dispose 时中止+排空
7. `ctx.effect(() => () => detached.drain())` 清理

## 6. 踩坑记录(来源:dsh-movein compat.md + 官方桥)

- **解析不到的包 → `dsh web` 启动直接致命失败**(不是警告):先装包,再写配置行
- **周边 npm dist-tag 落后核心**:`dsh-hooks-claude-code` 的 `latest` 可能是 `0.0.1-rc.x` 而 dsh 是 `0.1.0-rc.y` → **pin 与宿主 dsh 同版本**
- **`@deepseek-ai/dsh-hook-protocol` 是宿主不带的 peer**:只装桥不装 protocol 会启动失败 → 我们依赖桥时把 protocol 一并声明
- configPath 进程级:相对路径按启动 cwd 解析,不按会话 → dsh-cc-hooks 的补全点(见 DESIGN §3.3)
- git 安装不跑 build(见 §3)
