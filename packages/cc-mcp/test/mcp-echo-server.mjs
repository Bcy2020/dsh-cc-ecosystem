// Minimal stdio MCP server used by the dsh-cc-mcp adapter tests: exposes one
// "echo" tool and stays quiet on stderr.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

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
