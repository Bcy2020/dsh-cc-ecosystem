// Flaky stdio MCP server used by the dsh-cc-mcp manager tests: it refuses to
// start until its marker file exists, which lets a test drive the panel's
// Connect button through a real failure → success transition.
//
// argv[2] is the absolute marker path.

import { existsSync, writeFileSync } from 'node:fs'

const marker = process.argv[2]
if (typeof marker !== 'string' || marker === '') {
  process.stderr.write('mcp-flaky-server: missing marker path argument\n')
  process.exit(2)
}
if (!existsSync(marker)) {
  // Record the failed attempt so a test can prove the first launch happened.
  writeFileSync(`${marker}.attempted`, '1')
  process.exit(1)
}

await import('./mcp-echo-server.mjs')
