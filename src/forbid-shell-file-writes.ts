import type { Rule } from '@nizos/probity'
import { isShellWrite, SHELL_WRITE } from './changed.js'

export type ForbidShellFileWritesOptions = {
  /** Override the detection pattern. */
  match?: RegExp
  /** Commands to leave alone even when they look like a shell write. */
  allow?: RegExp
  reason?: string
}

const DEFAULT_REASON =
  'Edit files with the Write or Edit tool, not through the shell. A shell redirect or in-place script is invisible to the TDD and impacted-test rules, so it bypasses the checks that keep this change verified.'

/**
 * Blocks shell commands that write files (`cat > f`, a heredoc, `sed -i`,
 * an inline script calling write_text). Without this, an agent that prefers
 * the shell edits the tree while every write-gated rule sees an idle session.
 *
 * Applies to: command actions.
 */
export function forbidShellFileWrites(options: ForbidShellFileWritesOptions = {}): Rule {
  const match = options.match ?? SHELL_WRITE
  return function forbidShellFileWrites(action) {
    if (action.kind !== 'command') return { kind: 'pass' }
    if (options.allow?.test(action.command)) return { kind: 'pass' }
    const hit = match === SHELL_WRITE ? isShellWrite(action.command) : match.test(action.command)
    return hit ? { kind: 'violation', reason: options.reason ?? DEFAULT_REASON } : { kind: 'pass' }
  }
}
