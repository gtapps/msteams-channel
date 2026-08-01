/**
 * State-dir resolution, shared between the server process and the `send` CLI.
 *
 * User scope by default — the same convention the official discord and telegram
 * channel plugins use (`~/.claude/channels/<name>`), so this one sits beside
 * them. `MSTEAMS_STATE_DIR` relocates it for tests or a non-default install.
 *
 * The default must stay user scope. `.mcp.json` launches the server with
 * `--cwd ${CLAUDE_PLUGIN_ROOT}`, so an in-process `pwd` resolves to the *plugin*
 * directory rather than the project, while the operator skills' shell runs in the
 * project. A fixed user-scope path is the only rule both sides can reach the same
 * answer for without coordination — the skills resolve it identically in shell:
 *
 *     ${MSTEAMS_STATE_DIR:-$HOME/.claude/channels/msteams}
 *
 * Resolved per call rather than captured at import so tests can repoint it.
 * Kept free of I/O: creation (0700) stays in `server.ts`, mirroring the
 * `gate.ts` / `access.ts` pure-vs-stateful split.
 */

import { homedir } from 'os'
import { join } from 'path'

export function stateDir(): string {
  return process.env.MSTEAMS_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'msteams')
}
