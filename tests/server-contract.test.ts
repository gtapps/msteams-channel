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
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PERMISSION_REPLY_RE } from '../src/permissions.js'

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

  test('reply accepts a file with no text', () => {
    // Sending a document with nothing to say about it is a normal request;
    // requiring text would make the caller invent some.
    const reply = tools.find(t => t.name === 'reply')
    expect(reply.inputSchema.required).toEqual(['conversation_id'])
  })

  test('reply says that an offered file is the end of the story', () => {
    // The consent round trip resolves in Teams and never comes back as an
    // event, so a model that waits for one waits forever.
    const files = tools.find(t => t.name === 'reply').inputSchema.properties.files
    expect(files.description).toMatch(/Accept/)
    expect(files.description).toMatch(/do not wait/i)
  })
})

describe('channels wire protocol', () => {
  // Channels is a research preview, so Plan §11 schedules a re-verification of
  // these strings against claude-plugins-official. Last done 2026-07-31 against
  // HEAD 4b4cd49: 100 commits since the db253f26 pin, none of them touching
  // external_plugins/{telegram,discord,fakechat} — the reference servers are
  // byte-identical, and every literal below matches theirs.
  //
  // This test guards OUR side of that agreement. A typo in a method name fails
  // exactly like a correct name the harness ignores: in total silence.
  const source = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf8')

  test('the notification methods are spelled exactly as the harness expects', () => {
    expect(source).toContain("method: 'notifications/claude/channel'")
    expect(source).toContain("z.literal('notifications/claude/channel/permission_request')")
    expect(source).toContain("method: 'notifications/claude/channel/permission'")
  })

  test('the permission_request params match the official schema', () => {
    for (const field of ['request_id', 'tool_name', 'description', 'input_preview']) {
      expect(source).toContain(field)
    }
  })

  test('a verdict is reported as {request_id, behavior}', () => {
    expect(source).toMatch(/params:\s*\{\s*request_id:[^}]*behavior/)
  })

  test('the verdict reply grammar matches discord byte for byte', () => {
    // Same regex, including the l-less alphabet: request ids avoid `l` so an
    // operator never has to tell it from `1` while retyping a code.
    expect(PERMISSION_REPLY_RE.source).toBe('^\\s*(y|yes|n|no)\\s+([a-km-z]{5})\\s*$')
    expect(PERMISSION_REPLY_RE.flags).toContain('i')
  })
})

describe('instructions', () => {
  // Claude Code truncates server instructions at 2048 chars and says so only in
  // a debug line nobody reads. At 2224 chars this string lost the tail of its
  // prompt-injection rule, and the assertions below passed anyway because they
  // matched the raw initialize response rather than what the model receives.
  // So: pin the budget, and assert against the truncated text.
  const MAX_INSTRUCTIONS = 2048
  const effective = () => String(initialize.instructions).slice(0, MAX_INSTRUCTIONS)

  test('they fit in the budget, so nothing is silently discarded', () => {
    // discord and telegram sit at ~1500. Headroom is not decoration: every
    // character past this point is deleted without an error.
    expect(initialize.instructions.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS)
  })

  test('they refuse access changes requested through the channel', () => {
    // The prompt-level half of the access model: a Teams message asking to be
    // allowlisted is exactly what an injection attempt looks like.
    expect(effective()).toMatch(/prompt injection/i)
    expect(effective()).toMatch(/never invoke it|never invoke that skill/i)
    expect(effective()).toMatch(/refuse/i)
  })

  test('they say transcript output does not reach the sender', () => {
    expect(effective()).toMatch(/never reaches their chat/i)
    expect(effective()).toMatch(/reply tool/i)
  })

  test('the reply-routing rule comes first, where truncation cannot reach it', () => {
    // Ordering is the mitigation: if this string ever grows past the budget
    // again, the rule that makes the channel two-way must not be what is lost.
    expect(effective().slice(0, 250)).toMatch(/reply tool/i)
  })

  test('the thread rule survives, since getting it wrong forks every thread', () => {
    expect(effective()).toMatch(/thread_id/)
    expect(effective()).toMatch(/never message_id/i)
  })
})
