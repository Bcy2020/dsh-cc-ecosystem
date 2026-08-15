# dsh-cc-skills

Load Claude Code's `.claude/` skills, commands and rules into DSH.

Fork of [dsh-claude-compat](https://github.com/biedongbin/dsh-claude-compat) (MIT, © biedongbin),
extended with **global user-level discovery** (`~/.claude`) alongside the original
project-level scan.

## What it does

- **Skills**: `<project>/.claude/skills/**/SKILL.md` + `~/.claude/skills/**/SKILL.md`
  surface as native DSH skills (slash trigger, `skill` tool, model catalog).
- **Commands**: `.claude/commands/*.md` → user-invocable skills (`/name`).
- **Rules**: `.claude/rules/*.md` (project first, then global) are injected once
  per session as a user-role `<system-reminder>` (Claude Code `prependUserContext`
  envelope).

Project entries outrank global ones via skill rank (project 150 < global 160;
lower ranks win duplicate names in DSH).

## Install

```sh
dsh plugin --profile <name> add dsh-cc-skills
```

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `enableSkills` | `true` | Surface skills/commands |
| `enableRules` | `true` | Inject rules |
| `enableGlobal` | `true` | Also scan `~/.claude` |
| `globalClaudeDir` | `<home>/.claude` | Global Claude dir override |
| `globalSkillRank` | `160` | Global rank (must be > project `skillRank` 150) |
| `projectRootMarkers` | `['.git']` | Project root discovery markers |
| `skillRank` | `150` | Project skill rank |
| `rulesMaxBytes` | `65536` | Rules injection size cap |

## License

MIT — original work © biedongbin (dsh-claude-compat), extensions © dsh-cc ecosystem.
