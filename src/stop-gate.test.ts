import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decide, evaluateStop } from './stop-gate.js'
import type { Event } from './impact.js'

const graph = fileURLToPath(new URL('../test/fixtures/graph.json', import.meta.url))
const root = dirname(dirname(graph))
const opts = { graph, ignoreGit: true }

const write = (file: string): Event => ({ kind: 'write', path: `${root}/${file}`, content: '', output: '' })
const ran = (command: string, output = 'Tests  2 passed (2)'): Event => ({ kind: 'command', command, output })

describe('decide', () => {
  it('allows a turn with no writes', () => {
    expect(decide([ran('ls')], opts).kind).toBe('allow')
  })

  it('allows when only non-code files were written', () => {
    const note: Event = { kind: 'write', path: `${root}/NOTES.md`, content: '', output: '' }
    expect(decide([note], opts).kind).toBe('allow')
  })

  it('allows when no test reaches the writes', () => {
    expect(decide([write('src/orphan.ts')], opts).kind).toBe('allow')
  })

  it('allows when no graph is found', () => {
    expect(decide([write('src/cart.ts')], { cwd: '/', ignoreGit: true }).kind).toBe('allow')
  })

  it('blocks when a reaching test never ran', () => {
    const result = decide([write('src/cart.ts')], opts)
    expect(result.kind).toBe('block')
    if (result.kind !== 'block') return
    expect(result.reason).toContain('3 of 3 test file(s)')
    expect(result.reason).toContain('src/cart.test.ts')
  })

  it('reports only the unverified subset', () => {
    const result = decide([write('src/cart.ts'), ran('npx vitest run src/cart.test.ts')], opts)
    expect(result.kind).toBe('block')
    if (result.kind !== 'block') return
    expect(result.reason).toContain('2 of 3 test file(s)')
    expect(result.reason).toContain('src/checkout.test.ts')
    expect(result.reason).not.toContain('src/cart.test.ts (')
  })

  it('allows once every reaching test ran green', () => {
    const command = 'npx vitest run src/cart.test.ts src/checkout.test.ts src/other.test.ts'
    expect(decide([write('src/cart.ts'), ran(command)], opts).kind).toBe('allow')
  })

  it('does not count a failed run', () => {
    const command = 'npx vitest run src/cart.test.ts src/checkout.test.ts src/other.test.ts'
    expect(decide([write('src/cart.ts'), ran(command, '1 failed')], opts).kind).toBe('block')
  })
})

describe('evaluateStop', () => {
  it('allows when the turn was already continued by a stop hook', () => {
    const result = evaluateStop({ transcript_path: 'ignored', stop_hook_active: true }, opts)
    expect(result.kind).toBe('allow')
    expect(result.reason).toContain('already continued')
  })

  it('allows when the payload carries no transcript', () => {
    expect(evaluateStop({}, opts).kind).toBe('allow')
  })

  it('allows when the transcript cannot be read', () => {
    expect(evaluateStop({ transcript_path: '/nowhere/s.jsonl' }, opts).kind).toBe('allow')
  })
})
