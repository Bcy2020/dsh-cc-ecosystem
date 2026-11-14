# 端到端验证报告

这里存放社区在真实工作流里对 `dsh-cc-hooks` 的验证报告。

## 怎么提交

1. fork 本仓库（或直接用 GitHub 网页编辑器）。
2. 复制 [`TEMPLATE.md`](TEMPLATE.md) 为 `<你的 GitHub 用户名>.md`。
3. 按实际运行结果填写，然后开 PR。

合并后你的名字会出现在本仓库的贡献者列表里。不会用 git 也没关系：把填好的报告作为评论贴到征集 issue 里，我代为提交，文件里仍署你的名字。

## 规则

- 只写事件名、版本号、退出码和必要的日志片段。**不要**贴 token、cookie、完整环境变量或完整项目路径（可以打码）。
- 报告对应 `dsh-cc-hooks@0.7.0` 及以后的版本，并注明 DSH 版本与操作系统。
- **「没触发」也是有效结果**，按模板标注即可。下面这些事件当前没有接线，不触发属于预期，不是 bug。

## 当前接线状态（16/31）

已接线：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`Stop`、`SubagentStart`、`SubagentStop`、`SessionEnd`、`PreCompact`、`PostCompact`、`PermissionRequest`、`PermissionDenied`、`CwdChanged`、`StopFailure`、`InstructionsLoaded`。

未接线（配置了也不会执行，属预期）：`Setup`、`UserPromptExpansion`、`PostToolBatch`、`Notification`、`MessageDisplay`、`TaskCreated`、`TaskCompleted`、`TeammateIdle`、`ConfigChange`、`DirectoryAdded`、`FileChanged`、`WorktreeCreate`、`WorktreeRemove`、`Elicitation`、`ElicitationResult`。

另有 `CwdChanged` 与 `StopFailure` 依赖宿主入口（`/cd`、模型路由失败），当前 DSH 上一般触发不了；未测到属正常。

## 汇总看板

| 事件 | 已确认人次 | 报告 |
|---|---|---|
| `SessionStart` | 0 | |
| `UserPromptSubmit` | 0 | |
| `PreToolUse` | 0 | |
| `PostToolUse` | 0 | |
| `PostToolUseFailure` | 0 | |
| `Stop` | 0 | |
| `SubagentStart` | 0 | |
| `SubagentStop` | 0 | |
| `SessionEnd` | 0 | |
| `PreCompact` | 0 | |
| `PostCompact` | 0 | |
| `PermissionRequest` | 0 | |
| `PermissionDenied` | 0 | |
| `CwdChanged` | 0 | |
| `StopFailure` | 0 | |
| `InstructionsLoaded` | 0 | |
