/**
 * .env loading, shared between the server process and the `send` CLI.
 *
 * Credentials come from this file only — never argv, which is world-readable
 * in /proc on Linux. Values already present in the environment win, so an
 * operator's shell export overrides the file.
 *
 * Extracted rather than imported from `server.ts` because that module starts
 * the listener and installs shutdown handlers on import — the same reason
 * `chunk.ts` was pulled out of it.
 */

import { readFileSync } from 'fs'

export function loadEnvFile(path: string): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const value = m[2].trim().replace(/^["']|["']$/g, '')
    if (process.env[m[1]] === undefined) process.env[m[1]] = value
  }
}
