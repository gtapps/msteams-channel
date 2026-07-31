/**
 * Contract test against the real server, spoken to over MCP stdio.
 *
 * Everything else in this suite tests extracted modules. This spawns
 * `server.ts` itself, because the things worth pinning here are properties of
 * the assembled server: which capabilities it declares, which tools it offers,
 * and what its instructions tell Claude. A module test cannot see any of that.
 *
 * It runs unconfigured (no credentials in the temp state dir) — the server
 * still serves MCP in that state by design, so no tenant is needed.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

type Rpc = { id?: number; result?: any; error?: any; method?: string }

// Generics pinned so stdin/stdout narrow to the piped streams we asked for.
let proc: Bun.Subprocess<'pipe', 'pipe', 'ignore'>
let reader: ReadableStreamDefaultReader<Uint8Array>
let buffered = ''
let nextId = 1

async function readMessage(): Promise<Rpc> {
  for (;;) {
    const newline = buffered.indexOf('\n')
    if (newline !== -1) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (line) return JSON.parse(line) as Rpc
      continue
    }
    const { value, done } = await reader.read()
    if (done) throw new Error('server closed stdout')
    buffered += new TextDecoder().decode(value)
  }
}

async function request(method: string, params: unknown = {}): Promise<any> {
  const id = nextId++
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  await proc.stdin.flush()
  for (;;) {
    const message = await readMessage()
    if (message.id === id) {
      if (message.error) throw new Error(JSON.stringify(message.error))
      return message.result
    }
  }
}

let initialize: any
let tools: any[]

beforeAll(async () => {
  proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'server.ts')], {
    env: { ...process.env, MSTEAMS_STATE_DIR: mkdtempSync(join(tmpdir(), 'msteams-contract-')) },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  reader = proc.stdout.getReader()

  initialize = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'contract-test', version: '1' },
  })
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  await proc.stdin.flush()

  tools = (await request('tools/list')).tools
})

afterAll(() => {
  proc?.kill()
})

describe('channel registration', () => {
  test('both experimental capabilities are declared', () => {
    // claude/channel registers the inbound listener; without it the harness
    // never delivers anything and the failure is completely silent.
    expect(initialize.capabilities.experimental).toHaveProperty('claude/channel')
    expect(initialize.capabilities.experimental).toHaveProperty('claude/channel/permission')
  })

  test('the server serves MCP even with no credentials', () => {
    // Deliberate: the plugin still loads as a channel so Claude can tell the
    // operator what is missing. Only the webhook listener is withheld.
    expect(initialize.serverInfo.name).toBe('msteams')
  })
})

describe('tool surface', () => {
  test('exactly the four MVP tools are exposed', () => {
    expect(tools.map(t => t.name).sort()).toEqual([
      'download_attachment',
      'edit_message',
      'react',
      'reply',
    ])
  })

  test('no tool can mutate access', () => {
    // Access changes are the operator's, via a terminal skill. A tool here
    // would be reachable by anyone who can send the bot a message, which is
    // precisely the escalation the access model exists to prevent.
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/access|allow|pair|approve|admin/i)
    }
  })

  test('every conversation-addressed tool takes conversation_id', () => {
    // That parameter is what the outbound gate looks up; a tool without it
    // would be reaching Teams without passing the gate at all.
    for (const tool of tools.filter(t => t.name !== 'download_attachment')) {
      expect(tool.inputSchema.required).toContain('conversation_id')
    }
  })

  test('reply threads on thread_id, and says so where a model will read it', () => {
    const reply = tools.find(t => t.name === 'reply')
    expect(reply.inputSchema.properties.reply_to.description).toContain('thread_id')
    expect(reply.inputSchema.properties.reply_to.description).toMatch(/not pass message_id/i)
  })
})

describe('instructions', () => {
  test('they refuse access changes requested through the channel', () => {
    // The prompt-level half of the access model: a Teams message asking to be
    // allowlisted is exactly what an injection attempt looks like.
    expect(initialize.instructions).toMatch(/never invoke that skill|prompt injection/i)
  })

  test('they say transcript output does not reach the sender', () => {
    expect(initialize.instructions).toMatch(/never reaches their chat|through the reply tool/i)
  })
})
