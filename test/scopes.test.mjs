// Scope-resolution tests (cc-loader/src/scopes.js) — Claude Code's per-component
// discovery model. There is no "project root": each component walks on its own,
// so the interesting assertions are the DIFFERENCES between the walks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, parse, resolve, sep } from 'node:path'
import {
  findGitRoot, boundedAncestors, fullAncestors, claudeJsonProjectKey,
  readClaudeJsonScopes, settingsPaths,
} from '../packages/cc-loader/src/scopes.js'
import { loadClaude } from '../packages/cc-loader/src/load.js'
import { Config as SkillsConfig } from '../packages/cc-skills/src/index.js'
import { Config as AgentsConfig } from '../packages/cc-agents/src/index.js'
import { Config as PermissionsConfig } from '../packages/cc-permissions/src/index.js'
import { Config as HooksConfig } from '../packages/cc-hooks/src/index.js'
import { Config as McpConfig } from '../packages/cc-mcp/src/index.js'

function tmpTree() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-scopes-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** mkdir -p for each (already absolute) path given. */
const mkdirp = (...paths) => {
  for (const path of paths) mkdirSync(path, { recursive: true })
}

/** A skill bundle CC reads: a SKILL.md with the two required fields. */
function skill(dir, name, description = 'a skill') {
  mkdirp(dir)
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`)
}

function rule(dir, file, text = '# rule\n') {
  mkdirp(dir)
  writeFileSync(join(dir, file), text)
}

// ─── findGitRoot ─────────────────────────────────────────────────────────────

test('findGitRoot: nearest ancestor carrying .git, inclusive of cwd', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirp(join(dir, 'repo', 'a', 'b'), join(dir, 'repo', '.git'))
    assert.equal(await findGitRoot(join(dir, 'repo', 'a', 'b')), join(dir, 'repo'))
    assert.equal(await findGitRoot(join(dir, 'repo')), join(dir, 'repo'), 'a repo root is its own root')
  } finally { cleanup() }
})

test('findGitRoot: a .git FILE counts (worktrees and submodules)', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirp(join(dir, 'wt', 'sub'))
    writeFileSync(join(dir, 'wt', '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n')
    assert.equal(await findGitRoot(join(dir, 'wt', 'sub')), join(dir, 'wt'))
  } finally { cleanup() }
})

test('findGitRoot: undefined outside any repository', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirp(join(dir, 'plain', 'sub'))
    assert.equal(await findGitRoot(join(dir, 'plain', 'sub')), undefined)
  } finally { cleanup() }
})

// ─── bounded ancestors (skills, commands, agents) ────────────────────────────

test('boundedAncestors: cwd → git root INCLUDED, nothing above it', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirp(join(dir, 'outer'), join(dir, 'repo', 'a', 'b'), join(dir, 'repo', '.git'))
    assert.deepEqual(
      await boundedAncestors(join(dir, 'repo', 'a', 'b'), { homeDir: dir }),
      [join(dir, 'repo', 'a', 'b'), join(dir, 'repo', 'a'), join(dir, 'repo')],
    )
  } finally { cleanup() }
})

test('boundedAncestors: home is EXCLUDED', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    // Home carries a .claude (as the real one does); a git repo sits inside it.
    mkdirp(join(dir, 'home', '.claude'), join(dir, 'home', 'scratch'), join(dir, 'home', 'scratch', 'repo', '.git'))
    const dirs = await boundedAncestors(join(dir, 'home', 'scratch', 'repo'), { homeDir: join(dir, 'home') })
    assert.deepEqual(dirs, [join(dir, 'home', 'scratch', 'repo')])
    assert.ok(!dirs.includes(join(dir, 'home')), 'home must never be a project dir')
  } finally { cleanup() }
})

test('boundedAncestors: with no repository the walk runs up to just below home', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirp(join(dir, 'home', 'x', 'y'))
    assert.deepEqual(
      await boundedAncestors(join(dir, 'home', 'x', 'y'), { homeDir: join(dir, 'home') }),
      [join(dir, 'home', 'x', 'y'), join(dir, 'home', 'x')],
      'no git boundary → bounded only by home (CC does the same)',
    )
  } finally { cleanup() }
})

// ─── full ancestors (rules, .mcp.json) ───────────────────────────────────────

test('fullAncestors: cwd → filesystem root, the root itself EXCLUDED', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirp(join(dir, 'a', 'b'))
    const dirs = fullAncestors(join(dir, 'a', 'b'))
    assert.equal(dirs[0], join(dir, 'a', 'b'), 'nearest first')
    assert.ok(dirs.includes(dir), 'every intermediate ancestor is present')
    const { root } = parse(dirs[0])
    assert.ok(!dirs.includes(root), `the filesystem root (${root}) must not be included`)
    assert.equal(join(dirs[dirs.length - 1], '..'), root, 'the walk stops one level below the root')
  } finally { cleanup() }
})

test('fullAncestors: reversing it gives CC\'s root-first reading order', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirp(join(dir, 'a', 'b'))
    const rootFirst = fullAncestors(join(dir, 'a', 'b')).slice().reverse()
    assert.equal(rootFirst[rootFirst.length - 1], join(dir, 'a', 'b'), 'cwd is read last')
    assert.equal(rootFirst[0], rootFirst.slice().sort((x, y) => x.length - y.length)[0], 'outermost is read first')
  } finally { cleanup() }
})

// ─── the difference between the two walks IS the model ───────────────────────

test('a .claude above the git root is read for RULES but not for SKILLS', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    //   outer/.claude/{skills,rules}      ← above the repository
    //   outer/repo/.git
    //   outer/repo/.claude/{skills,rules}
    //   outer/repo/pkg                    ← the session cwd
    skill(join(dir, 'outer', '.claude', 'skills', 'outer-skill'), 'outer-skill')
    rule(join(dir, 'outer', '.claude', 'rules'), 'outer.md')
    mkdirp(join(dir, 'outer', 'repo', '.git'))
    skill(join(dir, 'outer', 'repo', '.claude', 'skills', 'repo-skill'), 'repo-skill')
    rule(join(dir, 'outer', 'repo', '.claude', 'rules'), 'repo.md')
    mkdirp(join(dir, 'outer', 'repo', 'pkg'))

    const ir = await loadClaude({
      cwd: join(dir, 'outer', 'repo', 'pkg'),
      homeDir: dir,
      enableGlobal: false,
    })
    const skillNames = ir.components.skills.map((s) => s.name)
    assert.deepEqual(skillNames, ['repo-skill'], 'skills stop at the git root')
    assert.deepEqual(
      ir.components.rules.map((r) => r.name),
      ['outer.md', 'repo.md'],
      'rules walk the full chain, root-first',
    )
  } finally { cleanup() }
})

test('every discovered entry carries the scope it came from', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirp(join(dir, 'repo', '.git'))
    skill(join(dir, 'repo', '.claude', 'skills', 'a-skill'), 'a-skill')

    const ir = await loadClaude({ cwd: join(dir, 'repo'), homeDir: dir, enableGlobal: false })
    const [entry] = ir.components.skills
    assert.equal(entry.source, 'project-claude')
    assert.equal(entry.baseDir, join(dir, 'repo', '.claude'), 'baseDir is the .claude dir that contributed it')
    assert.equal(entry.rank, undefined, 'no numeric rank — position is the priority')
  } finally { cleanup() }
})

// ─── ~/.claude.json ──────────────────────────────────────────────────────────

// The key is a forward-slash path. These two build their inputs with the
// platform's own path primitives, so they assert the same thing on both CI legs
// — which of the two directories is chosen, and that no backslash survives. The
// exact Windows spelling is pinned separately, below, because it is the one
// `~/.claude.json` on a Windows machine actually contains.

/** The forward-slash form the key is supposed to be. */
const slashKey = (path) => resolve(path).replaceAll('\\', '/')

test('claudeJsonProjectKey: the git root, forward-slashed', () => {
  const repo = join('work', 'repo')
  const key = claudeJsonProjectKey(join(repo, 'pkg'), repo)
  assert.equal(key, slashKey(repo))
  assert.ok(!key.includes('\\'), 'the key must not carry backslashes')
  assert.ok(!key.endsWith(`${sep}pkg`), 'the key is the root, not the session directory')
})

test('claudeJsonProjectKey: outside a repository the key is the PARENT of cwd', () => {
  const here = join('work', 'scratch', 'here')
  const key = claudeJsonProjectKey(here, undefined)
  assert.equal(key, slashKey(dirname(here)))
  assert.ok(!key.endsWith(`${sep}here`), 'the key is the parent, not the directory itself')
})

test('claudeJsonProjectKey: the spelling a Windows ~/.claude.json actually holds', {
  skip: process.platform !== 'win32' ? 'windows-only path grammar' : false,
}, () => {
  assert.equal(claudeJsonProjectKey('C:\\work\\repo\\pkg', 'C:\\work\\repo'), 'C:/work/repo')
  assert.equal(claudeJsonProjectKey('C:\\work\\scratch\\here', undefined), 'C:/work/scratch')
})

test('readClaudeJsonScopes: user from the top level, local from projects[<key>]', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirp(join(dir, 'home'), join(dir, 'repo', '.git'))
    writeFileSync(join(dir, 'home', '.claude.json'), JSON.stringify({
      mcpServers: { fromUser: { command: 'user-cmd' } },
      projects: {
        [claudeJsonProjectKey(join(dir, 'repo'), join(dir, 'repo'))]: {
          mcpServers: { fromLocal: { command: 'local-cmd' } },
          history: [{ display: 'unrelated per-project state' }],
        },
      },
    }))
    const found = await readClaudeJsonScopes(join(dir, 'repo'), { homeDir: join(dir, 'home') })
    assert.equal(found.present, true)
    assert.deepEqual(Object.keys(found.user), ['fromUser'])
    assert.deepEqual(Object.keys(found.local), ['fromLocal'])
    assert.equal(found.error, undefined)
  } finally { cleanup() }
})

test('readClaudeJsonScopes: a missing file is not an error', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirp(join(dir, 'home'), join(dir, 'repo'))
    const found = await readClaudeJsonScopes(join(dir, 'repo'), { homeDir: join(dir, 'home') })
    assert.equal(found.present, false)
    assert.equal(found.user, undefined)
    assert.equal(found.error, undefined)
  } finally { cleanup() }
})

test('readClaudeJsonScopes: malformed JSON is reported, never thrown', async () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirp(join(dir, 'home'), join(dir, 'repo'))
    writeFileSync(join(dir, 'home', '.claude.json'), '{ not json')
    const found = await readClaudeJsonScopes(join(dir, 'repo'), { homeDir: join(dir, 'home') })
    assert.equal(found.present, true)
    assert.match(found.error, /invalid JSON/)
  } finally { cleanup() }
})

// ─── settings: fixed locations anchored on cwd ───────────────────────────────

test('settingsPaths: project/local are anchored on the CWD, never an ancestor', () => {
  const { dir, cleanup } = tmpTree()
  try {
    mkdirp(join(dir, 'home'), join(dir, 'repo', '.claude'), join(dir, 'repo', 'sub'))
    const paths = settingsPaths(join(dir, 'repo', 'sub'), { homeDir: join(dir, 'home') })
    assert.equal(paths.user, join(dir, 'home', '.claude', 'settings.json'))
    assert.equal(paths.project, join(dir, 'repo', 'sub', '.claude', 'settings.json'))
    assert.equal(paths.local, join(dir, 'repo', 'sub', '.claude', 'settings.local.json'))
    assert.ok(
      !paths.project.startsWith(join(dir, 'repo', '.claude')),
      'the repository root settings file must NOT be picked up from a subdirectory',
    )
  } finally { cleanup() }
})

// ─── the retired model must not come back ────────────────────────────────────

for (const [name, Config] of [
  ['cc-skills', SkillsConfig],
  ['cc-agents', AgentsConfig],
  ['cc-permissions', PermissionsConfig],
  ['cc-hooks', HooksConfig],
  ['cc-mcp', McpConfig],
]) {
  test(`${name}: no projectRootMarkers config (there is no project root)`, () => {
    assert.equal(Config({}).projectRootMarkers, undefined)
  })
}
