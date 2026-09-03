#!/usr/bin/env node
// Builds a graph with the graphify that is actually installed, then asserts
// this package can still read it. Unit tests use a checked-in fixture, so only
// this catches a graphify format change.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asGraphJson, loadGraph, reachingTests } from '../dist/index.js'

const repo = mkdtempSync(join(tmpdir(), 'probity-graphify-contract-'))
mkdirSync(join(repo, 'src'))
writeFileSync(join(repo, 'src/cart.ts'), 'export function total(n: number) {\n  return n * 2\n}\n')
writeFileSync(
  join(repo, 'src/checkout.ts'),
  "import { total } from './cart.js'\n\nexport function pay(n: number) {\n  return total(n)\n}\n",
)
writeFileSync(
  join(repo, 'src/cart.test.ts'),
  "import { total } from './cart.js'\n\nit('doubles', () => {\n  expect(total(2)).toBe(4)\n})\n",
)
writeFileSync(
  join(repo, 'src/checkout.test.ts'),
  "import { pay } from './checkout.js'\n\nit('pays', () => {\n  expect(pay(2)).toBe(4)\n})\n",
)

execFileSync('graphify', ['extract', repo, '--code-only', '--no-cluster'], { stdio: 'inherit' })

const graphFile = join(repo, 'graphify-out', 'graph.json')
asGraphJson(JSON.parse(readFileSync(graphFile, 'utf8')), graphFile)
const graph = loadGraph(graphFile)

const checks = [
  ['a test reaching the edited file at depth 1', () => reachingTests(graph, ['src/cart.ts'], { depth: 1 }).some((h) => h.file === 'src/cart.test.ts')],
  ['a transitive test at depth 2', () => reachingTests(graph, ['src/cart.ts'], { depth: 2 }).some((h) => h.file === 'src/checkout.test.ts')],
  ['no test reaching an unknown file', () => reachingTests(graph, ['src/nope.ts']).length === 0],
]

let failed = 0
for (const [label, check] of checks) {
  let ok = false
  try {
    ok = check()
  } catch (error) {
    console.error(`  error: ${String(error)}`)
  }
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`)
  if (!ok) failed++
}

if (failed > 0) {
  console.error(`\n${failed} contract check(s) failed: graphify's graph.json no longer reads as expected.`)
  process.exit(1)
}
console.log('\ngraph.json contract holds.')
