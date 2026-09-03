import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent as AcpAgent,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk'

/**
 * ACP cold-start readiness integration suite (the startup-race handoff §8.1).
 *
 * Spawns the real `dsh-acp-demo` bin over stdio with a Loader tree whose
 * sibling `dsh-mcp-client` entries connect to fixture MCP servers with an
 * artificially delayed listTools window. The client connects as soon as the
 * process is spawned and drives `initialize → session/new → prompt` with no
 * artificial sleep. The first persisted `request/header` must already contain
 * every configured MCP tool:
 *
 * - before the fix the ACP transport serves initialize while the MCP sibling
 *   is still connecting, so the first header lacks the MCP tools (RED);
 * - after the fix `initialize` waits for the Loader tree to settle, so MCP
 *   registration precedes the first model request (GREEN).
 *
 * No LLM adapter is mounted on purpose: the turn reaches request composition
 * and fails with NO_ADAPTER AFTER the header row is persisted, so the fixture
 * captures the model-facing tool inventory without network access.
 */

const binScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
// Repo root is four levels up from packages/examples/acp-demo/tests.
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
// Shared with dsh-mcp-client's own e2e (its module resolution reaches the MCP
// SDK); STARTUP_RACE_LIST_TOOLS_DELAY_MS delays its connect→listTools window.
const fixtureServer = fileURLToPath(new URL('../../../mcp/mcp-client/tests/fixture-server.ts', import.meta.url))

interface McpEntry {
  serverName: string
  /** Delay applied before the fixture server connects (ms); omit to use a broken command. */
  delayMs?: number
  /** Override the fixture command to simulate a server that cannot start. */
  command?: string
}

interface Spawned {
  child: ChildProcessWithoutNullStreams
  client: ClientSideConnection
  stderr: string[]
  cwd: string
}

let spawned: Spawned | undefined
let workdir: string | undefined

afterEach(async () => {
  if (spawned !== undefined) {
    spawned.child.kill('SIGKILL')
    spawned = undefined
  }
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

function configFor(entries: McpEntry[], persistenceRoot: string): string {
  const mcp = entries.map((entry) => {
    const command = entry.command ?? process.execPath
    const args = entry.command === undefined ? [fixtureServer] : []
    const env = entry.delayMs === undefined
      ? '{}'
      : `{ STARTUP_RACE_LIST_TOOLS_DELAY_MS: '${entry.delayMs}' }`
    return `
- id: mcp-${entry.serverName}
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: stdio
    serverName: '${entry.serverName}'
    command: '${command}'
    args: [${args.map(arg => `'${arg}'`).join(', ')}]
    env: ${env}
    cwd: '${persistenceRoot}'
    failOnStartupError: true
`
  }).join('')
  return `
- id: llm-core
  name: '@deepseek-ai/dsh-llm'
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
- id: acp-agent
  name: '@deepseek-ai/dsh-acp-demo'
  config:
    provider: no-adapter
    model: no-adapter
    persona: 'You are a test agent.'
    workspaceContext: false
    persistenceRoot: '${join(persistenceRoot, 'sessions')}'
    persistenceCompression: 'none'
${mcp}`
}

async function boot(entries: McpEntry[]): Promise<Spawned> {
  workdir = await mkdtemp(join(tmpdir(), 'acp-startup-readiness-'))
  const cwd = workdir
  const configPath = join(cwd, 'cordis.yml')
  await writeFile(configPath, configFor(entries, cwd))
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, binScript, '--config', configPath],
    {
      cwd,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: repoTsconfig,
        // No adapter is mounted; the dummy key only satisfies env presence checks.
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'keyless-acp-startup-readiness',
        DSH_HOME: join(cwd, '.dsh'),
        DSH_AGENTS_HOME: join(cwd, '.agents'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => stderr.push(chunk))
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  )
  const makeClient = (_agent: AcpAgent): Client => ({
    sessionUpdate(_params: SessionNotification): Promise<void> {
      return Promise.resolve()
    },
    requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    },
  })
  const client = new ClientSideConnection(makeClient, stream)
  spawned = { child, client, stderr, cwd }
  return spawned
}

/** Drive one prompt to the model boundary, then read the first persisted request/header tools. */
async function firstHeaderTools(sessionRoot: string): Promise<string[]> {
  interface HeaderRow {
    type?: string
    data?: { header?: { tools?: { name: string }[] } }
  }
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const files = await walk(sessionRoot)
    for (const file of files) {
      if (!file.endsWith('session.jsonl')) continue
      const content = await readFile(file, 'utf8')
      for (const line of content.split('\n')) {
        if (line.length === 0) continue
        let row: HeaderRow
        try {
          row = JSON.parse(line) as HeaderRow
        } catch {
          continue
        }
        if (row.type !== 'request/header' || row.data?.header?.tools === undefined) continue
        return row.data.header.tools.map(tool => tool.name)
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('first request/header was not persisted in time')
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else files.push(path)
  }
  return files
}

async function connectAndPrompt(): Promise<void> {
  const { client, cwd } = spawned!
  // Deliberately no sleep: connect and drive the protocol as fast as the
  // wire allows, exactly like a cold-start client does.
  await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  const { sessionId } = await client.newSession({ cwd, mcpServers: [] })
  await expect(client.prompt({
    sessionId,
    prompt: [{ type: 'text', text: 'readiness probe' }],
  })).rejects.toThrow()
}

describe('dsh-acp-demo cold-start readiness (bin + Loader + stdio)', () => {
  it('serves the first model request with the delayed MCP server already registered', async () => {
    await boot([{ serverName: 'fixture', delayMs: 4000 }])
    await connectAndPrompt()
    const tools = await firstHeaderTools(join(spawned!.cwd, 'sessions'))
    expect(tools).toContain('mcp__fixture__ready_probe')
  }, 60_000)

  it('serves the first model request only after every MCP server registered, regardless of order', async () => {
    await boot([
      { serverName: 'early', delayMs: 2400 },
      { serverName: 'late', delayMs: 4200 },
    ])
    await connectAndPrompt()
    const tools = await firstHeaderTools(join(spawned!.cwd, 'sessions'))
    expect(tools).toContain('mcp__early__ready_probe')
    expect(tools).toContain('mcp__late__ready_probe')
  }, 60_000)

  it('fails initialize closed when a required MCP server cannot start', async () => {
    await boot([{ serverName: 'fixture', command: '/nonexistent-startup-race-command' }])
    // The tree cannot settle, so the connection must fail before any session
    // or prompt can be served.
    await expect(spawned!.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })).rejects.toThrow()
    expect(spawned!.stderr.join('')).toContain('mcp-client')
  }, 60_000)

  it('settles a pending initialize when the client disposes during readiness', async () => {
    await boot([{ serverName: 'fixture', delayMs: 4000 }])
    const initializing = spawned!.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    spawned!.child.stdin.destroy()
    await expect(initializing).rejects.toThrow()
  }, 60_000)
})
