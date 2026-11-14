# dsh-cc-ecosystem

English · [中文](README.md)

One install brings the whole [dsh-cc](https://github.com/Bcy2020/dsh-cc-ecosystem) ecosystem into a DSH profile: the shared parse layer plus all six Claude Code adapters, mounted in a single profile layer.

Version numbers are **pinned on purpose**: pnpm 11 refuses versions published less than 24 hours ago, so a bare package name silently installs the older version and still reports success — see [why the version number is required](../../README.en.md#up-and-running-in-30-seconds). In the Web GUI, paste the `name@version` line below straight into the input box.

<!-- versions:begin -->
```sh
dsh plugin --profile <name> add dsh-cc-ecosystem@0.6.1
```
<!-- versions:end -->

## What it mounts

| Package | What it does |
|---|---|
| [dsh-cc-loader](https://www.npmjs.com/package/dsh-cc-loader) | Shared parse layer (`.claude` → in-memory IR). **A pure library — it mounts no plugin lines**; the other six packages simply import it |
| [dsh-cc-skills](https://www.npmjs.com/package/dsh-cc-skills) | Skills / slash commands / rules |
| [dsh-cc-permissions](https://www.npmjs.com/package/dsh-cc-permissions) | Enforces Claude Code permission rules (deny → ask → allow) |
| [dsh-cc-agents](https://www.npmjs.com/package/dsh-cc-agents) | `.claude/agents` subagents + `cc_agent` dispatch |
| [dsh-cc-hooks](https://www.npmjs.com/package/dsh-cc-hooks) | All five kinds of Claude Code hooks |
| [dsh-cc-mcp](https://www.npmjs.com/package/dsh-cc-mcp) | Claude Code MCP config + the `/mcp` management panel |
| [dsh-cc-memory](https://www.npmjs.com/package/dsh-cc-memory) | Claude Code auto-memory (the `MEMORY.md` index plus memory files), read-only by default, writable if enabled |

## Why this needs to be its own package

DSH's `dsh plugin` reconciles `dsh.profile.bundles` against **the profile's own direct dependencies** — a dependency's dependencies (transitive ones) are never added to `bundles`, and their patches are never loaded. When you install `dsh-cc-ecosystem`, the six adapters are all transitive dependencies, so **only this package's own patch can mount them**.

That is why the six lines in this package's `cordis.patch.yml` are **copies** of each adapter's own patch. Two configurations would drift apart on their own, so [test/umbrella.test.mjs](../../test/umbrella.test.mjs) compares them line by line — any config drift fails the test (mutation-verified: changing a single value makes the assertion fail).

If you only want a few of them, install those packages directly — every adapter is a valid bundle on its own.

## Compatibility

Same as the rest of the family: **dual-host support for DSH `0.1.5-rc.2` and `0.2.0-rc.2`**.

This package declares no `dsh-*` peers of its own: each adapter's compatibility is read off the lines this patch inserts, and the host validates it through `bundleComponentManifests`. A second gate here would only produce a second, possibly conflicting verdict.

## License

MIT
