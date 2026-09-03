import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readTranscript } from './transcript.js'

function transcriptOf(...rows: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'pg-transcript-'))
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return path
}

const assistant = (...content: unknown[]) => ({ type: 'assistant', message: { content } })
const user = (...content: unknown[]) => ({ type: 'user', message: { content } })
const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input })
const result = (id: string, content: unknown) => ({ type: 'tool_result', tool_use_id: id, content })

describe('readTranscript', () => {
  it('returns nothing for a missing file', () => {
    expect(readTranscript('/nowhere/session.jsonl')).toEqual([])
  })

  it('reads a Bash call and attaches its output', () => {
    const path = transcriptOf(
      assistant(use('t1', 'Bash', { command: 'npx vitest run a.test.ts' })),
      user(result('t1', 'Tests  3 passed (3)')),
    )
    expect(readTranscript(path)).toEqual([
      { kind: 'command', command: 'npx vitest run a.test.ts', output: 'Tests  3 passed (3)' },
    ])
  })

  it('reads Write content and Edit new_string as the written text', () => {
    const path = transcriptOf(
      assistant(use('t1', 'Write', { file_path: '/r/src/a.ts', content: 'export const a = 1' })),
      user(result('t1', 'File written')),
      assistant(use('t2', 'Edit', { file_path: '/r/src/b.ts', old_string: 'x', new_string: 'y' })),
    )
    const events = readTranscript(path)
    expect(events[0]).toEqual({ kind: 'write', path: '/r/src/a.ts', content: 'export const a = 1', output: 'File written' })
    expect(events[1]).toEqual({ kind: 'write', path: '/r/src/b.ts', content: 'y', output: '' })
  })

  it('joins MultiEdit edits into the written text', () => {
    const path = transcriptOf(
      assistant(use('t1', 'MultiEdit', { file_path: '/r/src/a.ts', edits: [{ new_string: 'one' }, { new_string: 'two' }] })),
    )
    expect(readTranscript(path)[0]).toMatchObject({ kind: 'write', content: 'one\ntwo' })
  })

  it('flattens an array tool_result into text', () => {
    const path = transcriptOf(
      assistant(use('t1', 'Bash', { command: 'ls' })),
      user(result('t1', [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])),
    )
    expect(readTranscript(path)[0]).toMatchObject({ output: 'a\nb' })
  })

  it('skips malformed lines instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pg-transcript-'))
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, `not json\n${JSON.stringify(assistant(use('t1', 'Bash', { command: 'ls' })))}\n{"partial":`)
    expect(readTranscript(path)).toEqual([{ kind: 'command', command: 'ls', output: '' }])
  })

  it('keeps other tools as other', () => {
    const path = transcriptOf(assistant(use('t1', 'Read', { file_path: '/r/src/a.ts' })))
    expect(readTranscript(path)[0]).toMatchObject({ kind: 'other', tool: 'Read' })
  })
})
