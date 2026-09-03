import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { requireReachingTest } from './require-reaching-test.js'

const graph = fileURLToPath(new URL('../test/fixtures/graph.json', import.meta.url))
const root = dirname(dirname(graph))
const write = (file: string) => ({ kind: 'write' as const, path: `${root}/${file}`, content: '' })

const rule = requireReachingTest({ graph })

describe('requireReachingTest', () => {
  it('ignores commands', async () => {
    expect((await rule({ kind: 'command', command: 'ls' })).kind).toBe('pass')
  })

  it('ignores writes to test files', async () => {
    expect((await rule(write('src/orphan.test.ts'))).kind).toBe('pass')
  })

  it('passes when a test reaches the file', async () => {
    expect((await rule(write('src/cart.ts'))).kind).toBe('pass')
    expect((await rule(write('src/checkout.ts'))).kind).toBe('pass')
  })

  it('passes for a file the graph does not know', async () => {
    expect((await rule(write('src/brand-new.ts'))).kind).toBe('pass')
  })

  it('passes when no graph is found', async () => {
    const result = await requireReachingTest()({ kind: 'write', path: '/nowhere/src/x.ts', content: '' })
    expect(result.kind).toBe('pass')
  })

  it('blocks a known file no test reaches and suggests where to add one', async () => {
    const result = await rule(write('src/orphan.ts'))
    expect(result.kind).toBe('violation')
    if (result.kind !== 'violation') return
    expect(result.reason).toContain('No test reaches src/orphan.ts')
    expect(result.reason).toContain('Add one in src/orphan.test.ts')
  })

  it('accepts a test written this session that names the file', async () => {
    const ctx = {
      history: async () => [
        { kind: 'write' as const, path: `${root}/src/orphan.test.ts`, content: "import { orphan } from './orphan.js'", output: '' },
      ],
    }
    expect((await rule(write('src/orphan.ts'), ctx)).kind).toBe('pass')
  })

  it('ignores a session test that does not name the file', async () => {
    const ctx = {
      history: async () => [
        { kind: 'write' as const, path: `${root}/src/other.test.ts`, content: "import { other } from './other.js'", output: '' },
      ],
    }
    expect((await rule(write('src/orphan.ts'), ctx)).kind).toBe('violation')
  })

  it('accepts a test already on disk at the suggested path', async () => {
    const ctx = { readFile: async () => ({ kind: 'present' as const, content: '' }) }
    expect((await rule(write('src/orphan.ts'), ctx)).kind).toBe('pass')
  })

  it('honours a custom suggestion', async () => {
    const custom = requireReachingTest({ graph, suggest: (f) => `spec/${f}` })
    const result = await custom(write('src/orphan.ts'))
    expect(result.kind).toBe('violation')
    if (result.kind !== 'violation') return
    expect(result.reason).toContain('Add one in spec/src/orphan.ts')
  })
})
