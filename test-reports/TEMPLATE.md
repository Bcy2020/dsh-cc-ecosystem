# cc-hooks 端到端验证报告 — <你的 GitHub 用户名>

> 结果用 ✅ / ❌ / 未测 标注。证据一栏写日志里的关键字段，或贴 1–2 行脱敏后的 `hooks.log`。
> 「没触发」本身就是有价值的结果，照实写即可。

- 报告日期：
- DSH 版本：
- 操作系统：
- `dsh-cc-hooks` 版本 / 安装方式：
- 工作区（可打码，例如 `E:\work\demo`）：

## 结果

| 事件 | 结果 | 证据（关键字段 / 日志摘录） |
|---|---|---|
| `SessionStart` | | |
| `UserPromptSubmit` | | |
| `PreToolUse` | | |
| `PostToolUse` | | |
| `PostToolUseFailure` | | |
| `Stop` | | |
| `SubagentStart` | | |
| `SubagentStop` | | |
| `SessionEnd` | | |
| `PreCompact` | | |
| `PostCompact` | | |
| `PermissionRequest` | | |
| `PermissionDenied` | | |
| `CwdChanged` | | |
| `StopFailure` | | |
| `InstructionsLoaded` | | |

## 未接线事件的观察（可选）

如果你原本配置了下面这些事件，把实际表现写在这里。当前版本不触发它们是预期行为。

| 事件 | 表现 |
|---|---|
| | |

## 附件（截图）

截图放在 `test-reports/assets/<你的用户名>/`，在下面用相对路径引用；单张小于 2 MB，png / jpg。提交前请打码：token、cookie、完整路径、对话中的隐私内容。

**必须包含：**

1. 插件页：显示 `dsh-cc-hooks` 的版本与来源（证明跑的是哪个版本）。
   `![插件页](assets/<你的用户名>/plugin.png)`
2. 若测了 `PermissionRequest` / `PermissionDenied`：审批弹窗的截图。
   `![审批弹窗](assets/<你的用户名>/approval.png)`
3. `hooks.log` 的关键片段（截图或粘贴文本，二选一；文本请用代码块）。
   `![hooks.log](assets/<你的用户名>/hooks-log.png)`

**可选：** 会话里工具调用 / 终端输出的截图。

## 复现步骤

用 3–5 步写清你是怎么触发这些事件的，方便维护者重放：

1.
2.
3.

## 备注

- 遇到的问题：
- 其他：
