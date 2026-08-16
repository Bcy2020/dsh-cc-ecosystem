# Hook fixture matrix — INDEX

- 31 events × 5 types × 5 variants = 775 combos; sampled 465 (60.0%, 3-of-5 per (event, type)).
- special fixtures: 12 (S01..S12).

| event | `command` | `http` | `mcp_tool` | `prompt` | `agent` |
| --- | --- | --- | --- | --- | --- |
| `SessionStart` | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) |
| `Setup` | F4 F5 F1 (15×) | F5 F1 F2 (15×) | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) |
| `UserPromptSubmit` | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) | F1 F2 F3 (15×) |
| `UserPromptExpansion` | F5 F1 F2 (15×) | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) |
| `PreToolUse` | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) | F1 F2 F3 (15×) | F2 F3 F4 (15×) |
| `PermissionRequest` | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) |
| `PermissionDenied` | F4 F5 F1 (15×) | F5 F1 F2 (15×) | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) |
| `PostToolUse` | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) | F1 F2 F3 (15×) |
| `PostToolUseFailure` | F5 F1 F2 (15×) | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) |
| `PostToolBatch` | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) | F1 F2 F3 (15×) | F2 F3 F4 (15×) |
| `Notification` | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) |
| `MessageDisplay` | F4 F5 F1 (15×) | F5 F1 F2 (15×) | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) |
| `SubagentStart` | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) | F1 F2 F3 (15×) |
| `SubagentStop` | F5 F1 F2 (15×) | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) |
| `TaskCreated` | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) | F1 F2 F3 (15×) | F2 F3 F4 (15×) |
| `TaskCompleted` | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) |
| `Stop` | F4 F5 F1 (15×) | F5 F1 F2 (15×) | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) |
| `StopFailure` | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) | F1 F2 F3 (15×) |
| `TeammateIdle` | F5 F1 F2 (15×) | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) |
| `InstructionsLoaded` | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) | F1 F2 F3 (15×) | F2 F3 F4 (15×) |
| `ConfigChange` | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) |
| `CwdChanged` | F4 F5 F1 (15×) | F5 F1 F2 (15×) | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) |
| `DirectoryAdded` | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) | F1 F2 F3 (15×) |
| `FileChanged` | F5 F1 F2 (15×) | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) |
| `WorktreeCreate` | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) | F1 F2 F3 (15×) | F2 F3 F4 (15×) |
| `WorktreeRemove` | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) |
| `PreCompact` | F4 F5 F1 (15×) | F5 F1 F2 (15×) | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) |
| `PostCompact` | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) | F1 F2 F3 (15×) |
| `Elicitation` | F5 F1 F2 (15×) | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) |
| `ElicitationResult` | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) | F1 F2 F3 (15×) | F2 F3 F4 (15×) |
| `SessionEnd` | F1 F2 F3 (15×) | F2 F3 F4 (15×) | F3 F4 F5 (15×) | F4 F5 F1 (15×) | F5 F1 F2 (15×) |

coverage per event/type: 465 matrix fixtures, all 31 events & 5 types present.
