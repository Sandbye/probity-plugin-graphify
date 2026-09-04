#!/usr/bin/env node
// Selection recall against real history.
//
// Ground truth: when a commit changes source AND test files, the tests its
// author touched are tests a human judged relevant to that change. For each
// such commit, ask what the gate would have named from the source diff alone,
// and measure how much of that human judgement it recovers, and how many test
// files it would have made the agent run.
//
//   node demo/benchmark-recall.mjs <repo> [limit]
import { execFileSync } from 'node:child_process'
import { loadGraph, reachingTests } from '../probity-graphify/dist/graph.js'

const repo = process.argv[2]
const limit = Number(process.argv[3] ?? 60)
if (!repo) {
  console.error('usage: benchmark-recall.mjs <repo> [limit]')
  process.exit(1)
}

const git = (...args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean)

const graph = loadGraph(`${repo}/graphify-out/graph.json`)
const isTest = (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f)
const isSource = (f) => /^packages\/[^/]+\/(src|test)\/.*\.[cm]?[jt]sx?$/.test(f) && !isTest(f)

// Only commits whose source files still exist in the graph: the graph is built
// at HEAD, so a commit touching since-deleted files cannot be scored fairly.
const known = (f) => graph.nodesByFile.has(f)

const cases = []
for (const sha of git('log', '--format=%H', `-${limit * 6}`)) {
  const files = git('show', '--name-only', '--format=', sha)
  const sources = files.filter(isSource).filter(known)
  const tests = files.filter(isTest).filter(known)
  if (sources.length === 0 || tests.length === 0) continue
  if (sources.length > 20) continue // a sweeping refactor has no meaningful "relevant test"
  cases.push({ sha, sources, tests })
  if (cases.length >= limit) break
}

const allTests = [...graph.nodesByFile.keys()].filter(isTest)
console.log(`repo: ${repo}`)
console.log(`test files in graph: ${allTests.length}`)
console.log(`scored commits: ${cases.length}\n`)

for (const depth of [1, 2]) {
  let recovered = 0
  let expected = 0
  let selected = 0
  let perfect = 0
  let missedAll = 0
  for (const c of cases) {
    const predicted = new Set(reachingTests(graph, c.sources, { depth }).map((h) => h.file))
    const hits = c.tests.filter((t) => predicted.has(t))
    recovered += hits.length
    expected += c.tests.length
    selected += predicted.size
    if (hits.length === c.tests.length) perfect++
    if (hits.length === 0) missedAll++
  }
  const recall = ((recovered / expected) * 100).toFixed(0)
  const avgSelected = (selected / cases.length).toFixed(1)
  const share = ((selected / cases.length / allTests.length) * 100).toFixed(0)
  console.log(`depth ${depth}`)
  console.log(`  recall of author-chosen tests : ${recall}%  (${recovered}/${expected})`)
  console.log(`  commits with every test found : ${perfect}/${cases.length}`)
  console.log(`  commits with none found       : ${missedAll}/${cases.length}`)
  console.log(`  test files selected, average  : ${avgSelected}  (${share}% of the suite)\n`)
}

// Does symbol-level narrowing cost recall? Ranges come from the commit's own
// diff, so this is the seeding the gate would really have used.
for (const depth of [1, 2]) {
  let recovered = 0
  let expected = 0
  let selected = 0
  let missedAll = 0
  for (const c of cases) {
    const ranges = new Map()
    for (const src of c.sources) {
      const hunks = []
      for (const line of git('show', '-U0', '--format=', c.sha, '--', src)) {
        const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
        if (!m) continue
        const start = Number(m[1])
        const count = m[2] === undefined ? 1 : Number(m[2])
        hunks.push(count === 0 ? [Math.max(1, start), start + 1] : [start, start + count - 1])
      }
      if (hunks.length > 0) ranges.set(src, hunks)
    }
    const predicted = new Set(reachingTests(graph, c.sources, { depth, ranges }).map((h) => h.file))
    const hits = c.tests.filter((t) => predicted.has(t))
    recovered += hits.length
    expected += c.tests.length
    selected += predicted.size
    if (hits.length === 0) missedAll++
  }
  console.log(`depth ${depth}, seeded from the changed symbols`)
  console.log(`  recall                        : ${((recovered / expected) * 100).toFixed(0)}%  (${recovered}/${expected})`)
  console.log(`  commits with none found       : ${missedAll}/${cases.length}`)
  console.log(`  test files selected, average  : ${(selected / cases.length).toFixed(1)}\n`)
}

// The baseline a person would reach for without a graph.
let convRecovered = 0
let convExpected = 0
let convSelected = 0
for (const c of cases) {
  const predicted = new Set()
  for (const src of c.sources) {
    const stem = src.replace(/\.[cm]?[jt]sx?$/, '')
    for (const candidate of allTests) {
      if (candidate.startsWith(stem + '.')) predicted.add(candidate)
    }
  }
  convRecovered += c.tests.filter((t) => predicted.has(t)).length
  convExpected += c.tests.length
  convSelected += predicted.size
}
console.log('baseline: sibling file naming only (src/x.ts -> src/x.test.ts)')
console.log(`  recall                        : ${((convRecovered / convExpected) * 100).toFixed(0)}%  (${convRecovered}/${convExpected})`)
console.log(`  test files selected, average  : ${(convSelected / cases.length).toFixed(1)}`)
