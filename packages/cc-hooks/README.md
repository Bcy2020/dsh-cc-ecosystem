# dsh-cc-hooks

Run **unmodified Claude Code command hooks** in DeepSeek Harness, with
**per-session / per-plugin discovery** — the gap the official bridge
(`@deepseek-ai/dsh-hooks-claude-code`) leaves open (its `configPath` is
process-level, read once at load; its own source carries the
`TODO(per-session-hook-config)`).

| 项 | 值 |
|---|---|
| 包名 | `dsh-cc-hooks` |
| 依赖 | `@deepseek-ai/dsh-hook-protocol`(官方共享协议层,peer)、`dsh-cc-loader`(file: 共享解析层) |
| 事件 | 7/31 官方桥映射集:SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SubagentStart / SubagentStop |
| 动作类型 | `command` 型(其余 http/mcp_tool/prompt/agent 解析即跳过 + 警告,与官方桥一致) |
| 宿主 DSH | 0.1.0-rc.x(协议 peer 钉 `0.1.0-rc.6`,npm 无 rc.5 发布) |

## 它做什么

每个会话按 **session cwd** 发现 hooks 配置并**合并**执行(CC 语义:多份配置
叠加,`mergeHookOutputs` 按 **deny > ask > allow** 最严格折叠):

1. 项目 `<projectRoot>/.claude/hooks/hooks.json`(`projectRoot` 由 cwd 向上按
   `.git` 等标记发现)
2. 用户 `~/.claude/hooks/hooks.json`(`enableGlobal` 可关)
3. 每个插件目录 `<pluginDir>/hooks/hooks.json`(`pluginDirs` 配置;该文件的
   `${CLAUDE_PLUGIN_ROOT}` 替换为对应插件根)

- **只读**:不写任何文件,单一事实来源永远是 `.claude` 原文(与
  `dsh-cc-loader` 生态一致)
- **每会话发现**:`agent/session-start` 预载 + `runPoint` 惰性兜底;改
  `hooks.json` 后**新会话自然生效**(会话内热重载不做,记录)
- **路径变量**:`${CLAUDE_PLUGIN_ROOT}`(解析期,按文件)、
  `${CLAUDE_PROJECT_DIR}`(运行期,按会话;默认 session workspace,同时导出
  `CLAUDE_PROJECT_DIR` 环境变量)、`${CLAUDE_PLUGIN_DATA}` 无 DSH 落点(记录)

## ⚠️ Windows 宿主:deny 请用结构化 stdout,别依赖 exit 2

DSH 的 shell 执行器(`dsh-pwsh-local`)以
`pwsh -NoProfile -NonInteractive -Command <hook command>` 运行 hook,而
**pwsh 7 的 `-Command` 把任何非零 native 退出码折叠成 1**。协议只有
`exit 2` 才是 deny → `exit 2` 到达时变成 `exit 1`(非阻断错误)→ **hook
静默放行**。官方桥 `@deepseek-ai/dsh-hooks-claude-code` 在 Windows 同样受此
影响(LESSONS 1.21)。

**hook 作者在 Windows 上应使用结构化 stdout JSON 通道**(CC 官方支持,且
exit 0 不受 pwsh 包装影响):

```js
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',          // 必须等于触发事件
    permissionDecision: 'deny',           // allow / deny / ask
    permissionDecisionReason: 'blocked',
  },
}))
process.exit(0)
```

## 安装

```sh
# 先装共享库,再装插件(本地开发 checkout 需包内 pnpm install + pnpm link ../cc-loader)
dsh plugin --profile <name> add dsh-cc-loader dsh-cc-hooks
```

本地 patch 挂载(Web profile 热更新,改完重启 GUI):

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml 追加
- insert:
    - id: cc-hooks
      name: 'file:///C:/Users/<you>/.../dsh-cc-ecosystem/packages/cc-hooks/src/index.js'
      config:
        enableGlobal: true
        # pluginDirs: ['C:/path/to/plugin-root', ...]
```

## 配置(Schema)

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `defaultTimeoutMs` | `600000` | 未设 timeout 的 hook 默认超时(CC 同值) |
| `stderrSummaryMaxChars` | `500` | `hook/result` 事件 stderr 摘要上限 |
| `pluginDirs` | `[]` | 插件根列表,扫 `<dir>/hooks/hooks.json` |
| `enableGlobal` | `true` | 是否加载 `~/.claude/hooks/hooks.json` |
| `globalClaudeDir` | `~/.claude` | 用户级目录覆盖(测试用) |
| `homeDir` | `os.homedir()` | 家目录覆盖(测试用) |
| `projectRootMarkers` | `['.git']` | 项目根向上发现标记 |
| `projectDir` | 会话 cwd | `CLAUDE_PROJECT_DIR` 覆盖值 |

## hooks.json 格式速查(CC 官方格式,直传 JSON)

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write",        // 可选;默认匹配所有;多值用 | 分隔
        "hooks": [
          { "type": "command", "command": "node scripts/guard.mjs", "timeout": 10000 }
          // type 还可能是 http / mcp_tool / prompt / agent —— 解析即跳过 + 警告
        ]
      }
    ],
    "PostToolUse": [
      { "matcher": "Read", "hooks": [{ "type": "command", "command": "echo $CLAUDE_PROJECT_DIR" }] }
    ]
  }
}
```

31 个事件中,协议只跑 command 型且只跑官方桥映射的 7 个;其余事件名在 JSON
里是普通 key,自然忽略(建议对未知事件名打 warn——当前按官方桥行为:静默忽略)。

## 与官方桥的差异

| 官方桥(进程级) | 本插件(per-session) |
|---|---|
| 加载时读一次 `configPath` | 每会话按 cwd 发现 + 缓存;新会话重读 |
| 只读一个文件 | 合并项目 + 全局 + 各插件 `hooks/hooks.json` |
| 配置变化需重启进程 | 新会话自然生效 |
| — | 项目级优先,插件最后(CC 作用域语义) |

决策映射(PreToolUse deny/ask、PostToolUse block+context、UserPromptSubmit
reject、Stop steer、SessionStart/Subagent* 注入)与官方桥逐点一致。

## 测试

```sh
node --test test/hooks-merge.test.mjs
```

覆盖:解析(settings/bare 形态、非 command 跳过、非法 matcher 抛错)、
`${CLAUDE_*}` 替换、三来源发现(项目/全局/插件)、跨源合并、协议折叠
(deny>ask>allow)、matcher 语义。

## License

MIT。接线语义镜像自 `@deepseek-ai/dsh-hooks-claude-code`(官方,随
deepseek-harness 维护);共享协议层 `@deepseek-ai/dsh-hook-protocol`(BSD-3-Clause
→ 官方 0.1.0-rc.6 线,按官方许可使用)。
