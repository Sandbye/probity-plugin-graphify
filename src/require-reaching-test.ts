import { basename, dirname, join } from 'node:path'
import type { Rule } from '@nizos/probity'
import { findGraphFile, isTestFile, loadGraph, reachingTests, relativize } from './graph.js'

export type RequireReachingTestOptions = {
  /** Reverse traversal depth in the code graph. Default 2. */
  depth?: number
  /** Explicit graph.json. Default: nearest graphify-out/graph.json above the written file. */
  graph?: string
  testFile?: RegExp
  /** Where to suggest the missing test. Default: sibling `<name>.test.<ext>` (`test_<name>.py` for Python). */
  suggest?: (file: string) => string
}

/**
 * Blocks a write to a source file that no test reaches in the code graph.
 * `enforceTdd` asks whether a failing test was observed; this asks whether
 * any test at all depends on the file about to change. Together they make
 * the failing test have to be a related one.
 *
 * Passes for test files, for files the graph does not know (new files:
 * `enforceTdd` owns that case), when no graph is found, and when a test
 * newer than the graph exists: written this session and naming the file,
 * or already on disk at the suggested path.
 */
export function requireReachingTest(options: RequireReachingTestOptions = {}): Rule {
  const suggest = options.suggest ?? defaultSuggest

  return async function requireReachingTest(action, ctx) {
    if (action.kind !== 'write') return { kind: 'pass' }

    const graphFile = options.graph ?? findGraphFile(dirname(action.path))
    if (!graphFile) return { kind: 'pass', reason: 'no graphify-out/graph.json found' }
    let graph
    try {
      graph = loadGraph(graphFile)
    } catch (error) {
      return { kind: 'pass', reason: `probity-graphify: ${String(error)}` }
    }

    const file = relativize(graph, action.path)
    if (isTestFile(file, options.testFile)) return { kind: 'pass' }
    if (!graph.nodesByFile.has(file)) return { kind: 'pass', reason: 'file unknown to graph' }
    if (reachingTests(graph, [file], options).length > 0) return { kind: 'pass' }

    // The graph lags the session: a test added a moment ago is not in it yet.
    const suggested = suggest(file)
    if ((await ctx?.readFile?.(join(graph.root, suggested)))?.kind === 'present') return { kind: 'pass' }
    const stem = basename(file).replace(/\.[^.]+$/, '')
    for (const event of (await ctx?.history?.()) ?? []) {
      if (event.kind !== 'write' || !isTestFile(relativize(graph, event.path), options.testFile)) continue
      if (event.content.includes(stem)) return { kind: 'pass' }
    }

    return {
      kind: 'violation',
      reason: [
        `No test reaches ${file} in the code graph, so nothing would catch a regression here.`,
        `Add one in ${suggest(file)}, run it to a failing assertion, then make this change.`,
      ].join('\n'),
    }
  }
}

function defaultSuggest(file: string): string {
  const py = file.match(/^(.*\/)?([^/]+)\.py$/)
  if (py) return `${py[1] ?? ''}test_${py[2]}.py`
  return file.replace(/\.([cm]?[jt]sx?)$/, '.test.$1')
}
