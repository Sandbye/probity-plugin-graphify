import { findGraphFile, loadGraph } from './graph.js'
import {
  impactedTests,
  lastWriteIndex,
  suggestCommand,
  unverified,
  verifyMessage,
  type Event,
  type ImpactOptions,
} from './impact.js'
import { readTranscript } from './transcript.js'

export type StopGateOptions = ImpactOptions & {
  cwd?: string
  graph?: string
  runner?: string | ((files: readonly string[]) => string)
  maxListed?: number
}

/** Stop hook payload Claude Code writes to the hook's stdin. */
export type StopPayload = {
  transcript_path?: string
  stop_hook_active?: boolean
  cwd?: string
}

export type StopDecision = { kind: 'allow'; reason?: string } | { kind: 'block'; reason: string }

/**
 * Refuses the end of a turn while tests that reach this session's source
 * edits have not run green. This is the gate a commit hook misses: an
 * agent that edits, verifies a hand-picked subset and stops leaves the
 * rest unrun, and often never commits at all.
 *
 * Allows when the turn has no writes, when no test reaches them, when no
 * graph is found, and whenever `stop_hook_active` is set, so a blocked
 * turn is only ever blocked once.
 */
export function evaluateStop(payload: StopPayload, options: StopGateOptions = {}): StopDecision {
  if (payload.stop_hook_active) return { kind: 'allow', reason: 'already continued by a stop hook' }
  if (!payload.transcript_path) return { kind: 'allow', reason: 'no transcript path' }

  const events = readTranscript(payload.transcript_path)
  return decide(events, options, payload.cwd)
}

/** The decision itself, over already-read events. Separated so tests need no file. */
export function decide(events: readonly Event[], options: StopGateOptions = {}, cwd?: string): StopDecision {
  const graphFile = options.graph ?? findGraphFile(options.cwd ?? cwd ?? process.cwd())
  if (!graphFile) return { kind: 'allow', reason: 'no graphify-out/graph.json found' }
  let graph
  try {
    graph = loadGraph(graphFile)
  } catch (error) {
    return { kind: 'allow', reason: `probity-graphify: ${String(error)}` }
  }

  const impacted = impactedTests(graph, events, options)
  if (impacted.length === 0) return { kind: 'allow', reason: 'nothing changed that a test reaches' }

  const since = lastWriteIndex(events, graph, options.testFile)
  const outstanding = unverified(events, impacted, since, options)
  if (outstanding.length === 0) return { kind: 'allow' }

  const files = outstanding.map((hit) => hit.file)
  return {
    kind: 'block',
    reason: verifyMessage(
      outstanding,
      suggestCommand(options.runner, files),
      options.maxListed ?? 12,
      `${outstanding.length} of ${impacted.length} test file(s) that reach your changes have not run green since your last edit:`,
    ),
  }
}
