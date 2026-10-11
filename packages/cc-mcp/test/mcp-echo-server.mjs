// Minimal stdio MCP server used by the dsh-cc-mcp adapter tests: exposes one
// "echo" tool and stays quiet on stderr.

import { appendFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

// Optional: with MCP_ECHO_PID_FILE set, append this process's pid on startup so
// a test can prove a server was spawned once rather than re-spawned. Unset (as
// in every other test) this writes nothing.
const pidFile = process.env.MCP_ECHO_PID_FILE
if (pidFile !== undefined && pidFile !== '') appendFileSync(pidFile, `${process.pid}\n`)

const server = new Server({ name: 'echo', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'echo',
    description: 'Echo the given text back',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text'],
    },
  }],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const text = req.params.arguments?.text ?? ''
  return { content: [{ type: 'text', text: `echo: ${text}` }] }
})

await server.connect(new StdioServerTransport())
