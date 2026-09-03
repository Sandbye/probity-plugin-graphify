import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asGraphJson,
  GraphFormatError,
  buildGraph,
  loadGraph,
  seedNodes,
  isTestFile,
  reachingFiles,
  reachingTests,
  relativize,
  type GraphJson,
} from './graph.js'

const json = JSON.parse(
  readFileSync(new URL('../test/fixtures/graph.json', import.meta.url), 'utf8'),
) as GraphJson
const graph = buildGraph(json, '/repo')

describe('isTestFile', () => {
  it.each([
    'src/cart.test.ts',
    'src/cart.spec.tsx',
    'test/integration/x.test.ts',
    'tests/test_cart.py',
    'pkg/cart_test.go',
  ])('matches %s', (path) => expect(isTestFile(path)).toBe(true))

  it.each(['src/cart.ts', 'src/testing-utils.ts', 'contest/x.ts', 'test/__testHelpers.tsx', 'test/fixtures/graph.json'])(
    'rejects %s',
    (path) => expect(isTestFile(path)).toBe(false),
  )
})

describe('relativize', () => {
  it('strips the graph root from absolute paths', () => {
    expect(relativize(graph, '/repo/src/cart.ts')).toBe('src/cart.ts')
  })
  it('leaves relative paths alone', () => {
    expect(relativize(graph, 'src/cart.ts')).toBe('src/cart.ts')
  })
})

describe('reachingFiles', () => {
  it('finds direct dependents at depth 1', () => {
    const files = reachingFiles(graph, 'src/cart.ts', { depth: 1 }).map((r) => r.file)
    expect(files.sort()).toEqual(['README.md', 'src/cart.test.ts', 'src/checkout.ts', 'src/other.test.ts'])
  })

  it('follows transitive dependents at depth 2', () => {
    const files = reachingFiles(graph, 'src/cart.ts', { depth: 2 }).map((r) => r.file)
    expect(files).toContain('src/checkout.test.ts')
  })

  it('never returns the seed file', () => {
    const files = reachingFiles(graph, 'src/cart.ts').map((r) => r.file)
    expect(files).not.toContain('src/cart.ts')
  })

  it('does not traverse forward edges', () => {
    const files = reachingFiles(graph, 'src/cart.ts').map((r) => r.file)
    expect(files).not.toContain('src/util.ts')
  })

  it('returns nothing for a file unknown to the graph', () => {
    expect(reachingFiles(graph, 'src/new.ts')).toEqual([])
  })

  it('spends depth on file boundaries only, so an intra-file call chain is free', () => {
    // checkout_pay calls cart_total, and checkout_test imports checkout: two
    // edges, one file boundary, so the test lands at depth 1 rather than 2.
    const hits = reachingTests(graph, ['src/cart.ts'], { depth: 1 })
    expect(hits.map((h) => h.file).sort()).toEqual(['src/cart.test.ts', 'src/other.test.ts'])
  })

  it('honours the relation filter', () => {
    const files = reachingFiles(graph, 'src/cart.ts', {
      depth: 1,
      relations: ['imports_from'],
    }).map((r) => r.file)
    expect(files.sort()).toEqual(['src/cart.test.ts', 'src/checkout.ts'])
  })
})

describe('reachingTests', () => {
  it('keeps only test files, shallowest depth wins', () => {
    const hits = reachingTests(graph, ['/repo/src/cart.ts', '/repo/src/checkout.ts'])
    const byFile = Object.fromEntries(hits.map((h) => [h.file, h.depth]))
    expect(byFile).toEqual({ 'src/cart.test.ts': 1, 'src/checkout.test.ts': 1, 'src/other.test.ts': 1 })
  })

  it('is empty for a file no test reaches', () => {
    expect(reachingTests(graph, ['src/orphan.ts'])).toEqual([])
  })
})

describe('asGraphJson', () => {
  it('accepts the current shape', () => {
    expect(asGraphJson({ nodes: [], edges: [] }).edges).toEqual([])
  })

  it('accepts an older graph that spells edges as links', () => {
    const parsed = { nodes: [{ id: 'a' }], links: [{ source: 'a', target: 'b', relation: 'calls' }] }
    expect(asGraphJson(parsed).edges).toHaveLength(1)
  })

  it('names the keys it found when the shape is unknown', () => {
    expect(() => asGraphJson({ vertices: [], arcs: [] }, 'g.json')).toThrow(GraphFormatError)
    expect(() => asGraphJson({ vertices: [], arcs: [] }, 'g.json')).toThrow(/vertices, arcs/)
  })

  it('rejects a non-object', () => {
    expect(() => asGraphJson('nope')).toThrow(GraphFormatError)
  })
})

describe('loadGraph', () => {
  it('throws GraphFormatError for a missing file', () => {
    expect(() => loadGraph('/nowhere/graphify-out/graph.json')).toThrow(GraphFormatError)
  })

  it('throws GraphFormatError for invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pg-graph-'))
    const file = join(dir, 'graph.json')
    writeFileSync(file, '{ not json')
    expect(() => loadGraph(file)).toThrow(GraphFormatError)
  })
})

describe('seedNodes', () => {
  it('seeds every node when no ranges are known', () => {
    expect(seedNodes(graph, 'src/cart.ts')).toEqual(['src_cart', 'src_cart_total', 'src_cart_other'])
    expect(seedNodes(graph, 'src/cart.ts', [])).toHaveLength(3)
  })

  it('seeds only the symbol a range touches, plus the file node', () => {
    expect(seedNodes(graph, 'src/cart.ts', [[10, 12]])).toEqual(['src_cart_total', 'src_cart'])
    expect(seedNodes(graph, 'src/cart.ts', [[41, 42]])).toEqual(['src_cart_other', 'src_cart'])
  })

  it('widens to the whole file for a change in the module header', () => {
    expect(seedNodes(graph, 'src/cart.ts', [[2, 3]])).toHaveLength(3)
  })

  it('widens to the whole file when a range matches no symbol', () => {
    expect(seedNodes(graph, 'src/checkout.ts', [[900, 901]])).toHaveLength(2)
  })

  it('is empty for a file the graph does not know', () => {
    expect(seedNodes(graph, 'src/nope.ts', [[1, 2]])).toEqual([])
  })
})

describe('reachingTests with ranges', () => {
  it('drops the tests that only reach the untouched symbol', () => {
    const ranges = new Map([['src/cart.ts', [[10, 12] as const]]])
    const hits = reachingTests(graph, ['src/cart.ts'], { depth: 1, ranges })
    expect(hits.map((h) => h.file)).toEqual(['src/cart.test.ts'])
  })

  it('keeps them when the touched symbol is the one they use', () => {
    const ranges = new Map([['src/cart.ts', [[41, 42] as const]]])
    const hits = reachingTests(graph, ['src/cart.ts'], { depth: 1, ranges })
    expect(hits.map((h) => h.file).sort()).toEqual(['src/cart.test.ts', 'src/other.test.ts'])
  })
})
