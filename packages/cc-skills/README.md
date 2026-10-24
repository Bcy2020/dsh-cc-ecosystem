# dsh-cc-skills

> [!IMPORTANT]
> **Only upgrade to this version when upgrading DSH to `0.1.5-rc.2` or later.**
> It binds to the 0.1.5 host contracts (`snapshotEvents()` / `eventAt()`,
> `ToolCallId`, `^0.1.5-rc.2` peer ranges) and **does not work on older DSH**.
> If your DSH is still `0.1.0-rc.7`–`0.1.1-rc.2`, **do not upgrade** — stay on
> `v0.1.x` (cc-permissions `v0.2.x`). The two lines are mutually exclusive.

Load Claude Code's `.claude/` skills, commands and rules into DSH.

Fork of [dsh-claude-compat](https://github.com/biedongbin/dsh-claude-compat) (MIT, © biedongbin),
extended with **global user-level discovery** (`~/.claude`) alongside the original
project-level scan.

## What it does

- **Skills**: every `.claude/skills/**/SKILL.md` on the session's project chain —
  from the cwd up to the git root, home excluded — plus `~/.claude/skills/**`.
- **Commands**: `.claude/commands/*.md` → user-invocable skills (`/name`).
- **Rules**: `.claude/rules/**` and `~/.claude/rules/**` are injected once per
  session as a user-role `<system-reminder>` (Claude Code `prependUserContext`
  envelope), under a `# claudeRules` heading.

Skills stop at the git root; **rules walk the whole ancestor chain to the
filesystem root, root-first**. That asymmetry is Claude Code's own (its
`getProjectDirsUpToHome` vs. the memory/rules walk) and is copied deliberately
rather than unified.

Entries merge in Claude Code's order — the user dir first, then project roots
near → far — and **same-named entries are not deduplicated**: DSH breaks a tie by
rank, so the adapter assigns ranks by POSITION in that list (`skillRank` sets the
base).

## Install

The version is pinned deliberately: pnpm 11 withholds releases younger than 24 h, so a bare package name silently installs an older one and still reports success. See [why the version is pinned](../../README.md#为什么要带版本号).

<!-- versions:begin -->
```sh
dsh plugin --profile <name> add dsh-cc-skills@0.5.0
```
<!-- versions:end -->

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `enableSkills` | `true` | Surface skills/commands |
| `enableRules` | `true` | Inject rules |
| `enableGlobal` | `true` | Also scan `~/.claude` |
| `globalClaudeDir` | `<home>/.claude` | Global Claude dir override |
| `skillRank` | `150` | Base rank; ranks are assigned by POSITION in Claude Code's merge order |
| `rulesMaxBytes` | `65536` | Rules injection size cap |

## License

MIT — original work © biedongbin (dsh-claude-compat), extensions © dsh-cc ecosystem.
