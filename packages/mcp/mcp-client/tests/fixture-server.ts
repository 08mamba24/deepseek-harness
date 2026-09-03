/**
 * Minimal MCP server over stdio for e2e testing of the dsh-mcp-client plugin.
 * Registers controlled tools with predictable behavior for asserting edge cases.
 *
 * Run: node fixture-server.ts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer(
  { name: 'fixture-server', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
)

server.registerTool('add', {
  title: 'Add Tool',
  description: 'Adds two numbers.',
  inputSchema: { a: z.number().describe('First number'), b: z.number().describe('Second number') },
}, async args => ({
  content: [{ type: 'text', text: String(args.a + args.b) }],
}))

server.registerTool('greet', {
  title: 'Greet Tool',
  description: 'Greets a person by name.',
  inputSchema: { name: z.string().describe('Name to greet') },
}, async args => ({
  content: [{ type: 'text', text: `Hello, ${args.name}!` }],
}))

server.registerTool('fail', {
  title: 'Fail Tool',
  description: 'Always returns an error.',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: 'Something went wrong' }],
  isError: true,
}))

server.registerTool('image', {
  title: 'Image Tool',
  description: 'Returns an image content block.',
  inputSchema: {},
}, async () => ({
  content: [
    { type: 'text', text: 'Here is an image:' },
    { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', mimeType: 'image/png' },
    { type: 'text', text: 'End of image.' },
  ],
}))

server.registerTool('crash', {
  title: 'Crash Tool',
  description: 'Replies, then exits the server process (crash-recovery test).',
  inputSchema: {},
}, async () => {
  // Exit AFTER the response flushes so the caller observes a clean result
  // followed by a transport close, like a real post-reply crash.
  setTimeout(() => process.exit(7), 25)
  return { content: [{ type: 'text', text: 'crashing' }] }
})

// Dotted name: legal in MCP, illegal in the DeepSeek function-name contract.
// Exercises the bridge's normalize-and-hash public-name path end to end.
server.registerTool('admin.reset', {
  title: 'Admin Reset Tool',
  description: 'Tool with a dotted name (normalization test).',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: 'reset done' }],
}))

// Stable marker for the ACP cold-start readiness e2e (startup-readiness.e2e.ts):
// the first model request must already see this tool when the fixture's
// listTools window was delayed.
server.registerTool('ready_probe', {
  title: 'Ready Probe',
  description: 'Stable marker proving this fixture registered before the first model request.',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: 'ready' }],
}))

// The host owns this process: exit on stdio EOF instead of lingering without a
// transport, so a killed ACP host never leaks this child.
process.stdin.on('end', () => { process.exit(0) })
process.stdin.on('close', () => { process.exit(0) })

// Optional artificial delay over the whole connect→listTools window for the
// ACP cold-start readiness e2e; defaults to no delay for every other suite.
const listToolsDelayMs = Number(process.env.STARTUP_RACE_LIST_TOOLS_DELAY_MS ?? '0')
if (listToolsDelayMs > 0) await new Promise(resolve => setTimeout(resolve, listToolsDelayMs))

const transport = new StdioServerTransport()
await server.connect(transport)
