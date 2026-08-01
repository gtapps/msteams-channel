import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { stateDir } from '../src/state.js'

let saved: string | undefined
beforeEach(() => {
  saved = process.env.MSTEAMS_STATE_DIR
})
afterEach(() => {
  if (saved === undefined) delete process.env.MSTEAMS_STATE_DIR
  else process.env.MSTEAMS_STATE_DIR = saved
})

describe('state dir resolution', () => {
  test('defaults to user scope, beside the other channel plugins', () => {
    delete process.env.MSTEAMS_STATE_DIR
    expect(stateDir()).toBe(join(homedir(), '.claude', 'channels', 'msteams'))
  })

  test('MSTEAMS_STATE_DIR wins when set', () => {
    process.env.MSTEAMS_STATE_DIR = '/somewhere/else'
    expect(stateDir()).toBe('/somewhere/else')
  })

  test('re-reads the environment per call, so tests can repoint it', () => {
    process.env.MSTEAMS_STATE_DIR = '/first'
    expect(stateDir()).toBe('/first')
    process.env.MSTEAMS_STATE_DIR = '/second'
    expect(stateDir()).toBe('/second')
  })

  test('resolves without touching the filesystem', () => {
    // Creation (0700) belongs to server.ts. A helper that created directories
    // would make merely asking for status manufacture a shadowing state dir.
    process.env.MSTEAMS_STATE_DIR = join(homedir(), 'this-must-never-be-created')
    stateDir()
    expect(readdirSync(homedir())).not.toContain('this-must-never-be-created')
  })
})

// The skills are prose, so nothing can test that they *behave*. What is testable
// is that they still carry the resolve step and are allowed to run it — a skill
// told to run a command its frontmatter forbids gets the step silently skipped,
// which fails open into the split this whole change exists to prevent.
describe('skills resolve the state dir rather than hardcoding it', () => {
  const skills = readdirSync(join(import.meta.dir, '..', 'skills'))
  const read = (name: string) =>
    readFileSync(join(import.meta.dir, '..', 'skills', name, 'SKILL.md'), 'utf8')

  test('every skill carries the shared resolve one-liner', () => {
    for (const name of skills) {
      expect(read(name)).toContain('${MSTEAMS_STATE_DIR:-$HOME/.claude/channels/msteams}')
    }
  })

  test('every skill is allowed to run it', () => {
    for (const name of skills) {
      const frontmatter = read(name).split('---')[1] ?? ''
      expect(frontmatter).toContain('Bash(echo *)')
    }
  })

  // A skill may name the default path when explaining resolution, but never as a
  // path it reads or writes — so any line naming it must also name the override.
  test('no skill names the state path without naming the override', () => {
    for (const name of skills) {
      const offending = read(name)
        .split('\n')
        .filter(l => /(~|\$HOME)\/\.claude\/channels/.test(l))
        .filter(l => !l.includes('MSTEAMS_STATE_DIR'))
      expect({ skill: name, offending }).toEqual({ skill: name, offending: [] })
    }
  })
})
