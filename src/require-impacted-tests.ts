import type { Rule } from '@nizos/probity'
import { findGraphFile, loadGraph } from './graph.js'
import {
  impactedTests,
  lastWriteIndex,
  planRun,
  unverified,
  verifyMessage,
  type Event,
  type ImpactOptions,
  type RunnerSpec,
} from './impact.js'

export type RequireImpactedTestsOptions = ImpactOptions & {
  /** Which commands this rule gates. Default: git commit. */
  before?: string | RegExp
  /** Explicit graph.json. Default: nearest graphify-out/graph.json above `cwd`. */
  graph?: string
  cwd?: string
  /** Suggested command; `{files}` is replaced with the impacted test files. */
  runner?: string | ((files: readonly string[]) => string)
  /** Per-family runners. Impacted files matching none are reported, not blocked. */
  runners?: readonly RunnerSpec[]
  /** How many impacted files to itemize in the block message. Default 12. */
  maxListed?: number
}

/**
 * Gates a command (default `git commit`) on the tests that reach this
 * session's writes having run green after the last code write. "Reach" is a
 * reverse traversal of the graphify code graph: a test file that imports,
 * calls or otherwise depends on a written file, directly or through
 * intermediates up to `depth` edges away. Written test files count as
 * impacted too.
 *
 * The block message names the exact files and a command to run them, so
 * the agent's next step is mechanical rather than a guess.
 *
 * Passes when the gated command does not match, nothing was written, no
 * graph is found, or no test reaches the writes.
 */
export function requireImpactedTests(options: RequireImpactedTestsOptions = {}): Rule {
  const before = options.before ?? /git commit/

  return async function requireImpactedTests(action, ctx) {
    if (action.kind !== 'command' || !matches(action.command, before)) return { kind: 'pass' }

    const history = ((await ctx?.history?.()) ?? []) as Event[]

    const graphFile = options.graph ?? findGraphFile(options.cwd ?? process.cwd())
    if (!graphFile) return { kind: 'pass', reason: 'no graphify-out/graph.json found' }
    // A graph we cannot read must not block the agent: Probity fail-closes on a
    // throwing rule, so an unreadable graph would block every commit.
    let graph
    try {
      graph = loadGraph(graphFile)
    } catch (error) {
      return { kind: 'pass', reason: `probity-graphify: ${String(error)}` }
    }

    const impacted = impactedTests(graph, history, options)
    if (impacted.length === 0) return { kind: 'pass' }

    const since = lastWriteIndex(history, graph, options.testFile)

    const outstanding = unverified(history, impacted, since, options, graph.root)
    if (outstanding.length === 0) return { kind: 'pass' }

    const plan = planRun(outstanding.map((hit) => hit.file), options)
    if (plan.gated.length === 0) {
      return { kind: 'pass', reason: `no configured runner covers ${plan.skipped.join(', ')}` }
    }
    const gated = outstanding.filter((hit) => plan.gated.includes(hit.file))
    const lead = `${gated.length} test file(s) reach your changes and have not run green since your last write:`
    const note =
      plan.skipped.length > 0
        ? `\nNot checked, no configured runner: ${plan.skipped.join(', ')}`
        : ''
    return {
      kind: 'violation',
      reason: verifyMessage(gated, plan.command, options.maxListed ?? 12, lead) + note,
    }
  }
}

function matches(text: string, pattern: string | RegExp): boolean {
  return typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)
}
