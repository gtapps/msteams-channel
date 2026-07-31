/**
 * Outbound text chunking.
 *
 * Teams rejects messages longer than ~4000 characters, so a long reply has to
 * be split. Break on a newline when one sits in the back half of the window —
 * cutting at an earlier newline would waste most of the chunk and produce a
 * ragged stream of short messages.
 *
 * Lives here rather than in server.ts because server.ts runs the process on
 * import (it connects stdio and installs shutdown handlers), so importing it
 * from a test would start and then kill the test runner.
 */

export const TEAMS_MESSAGE_LIMIT = 4000

export function chunkText(text: string, limit = TEAMS_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}
