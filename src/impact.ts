import { basename, relative } from 'node:path'
import { changedFiles, changedRangesFor, isShellWrite } from './changed.js'
import { isTestFile, reachingTests, relativize, type Graph, type Reaching } from './graph.js'

/** The session events both entry points reason over. Matches Probity's `SessionEvent`. */
export type Event =
  | { kind: 'prompt'; text: string }
  | { kind: 'command'; command: string; output: string }
  | { kind: 'write'; path: string; content: string; output: string }
  | { kind: 'other'; tool: string; input: unknown; output: string }

export type ImpactOptions = {
  depth?: number
  relations?: readonly string[]
  testFile?: RegExp
  /** Commands that count as having run every test. */
  fullSuite?: RegExp
  /** Output that marks a test run as failed. */
  failure?: RegExp
  /** Commands whose text counts as evidence of a test run. */
  testRunner?: RegExp
  /** Ignore the working tree and use transcript writes only. */
  ignoreGit?: boolean
  /** Seed traversal from whole files instead of the changed symbols. */
  ignoreRanges?: boolean
}

// `vitest`/`pytest` with no file arguments runs everything; `npm test` and friends too.
export const DEFAULT_FULL_SUITE =
  /\b(npm|pnpm|yarn|bun)( run)? test\b|\bvitest( run)?\s*$|\bpytest\s*$/
export const DEFAULT_FAILURE = /\b[1-9]\d* failed\b|\bFAIL\b|\bERRORS?\b/
// A command has to look like a test run before its text is read as evidence:
// `grep -rn foo packages/tests` mentions test paths and proves nothing (#run-detect).
export const DEFAULT_TEST_RUNNER =
  /\b(vitest|jest|pytest|mocha|ava|tap|phpunit|rspec|go test|cargo test|dotnet test|gradle test|mvn test)\b|\b(npm|pnpm|yarn|bun)( run)? test\b/

/**
 * Test files that reach anything written in `events`. A written test file
 * counts as impacted itself, at depth 0.
 */
export function impactedTests(graph: Graph, events: readonly Event[], options: ImpactOptions = {}): Reaching[] {
  const written = new Set<string>()
  for (const event of events) if (event.kind === 'write') written.add(relativize(graph, event.path))
  // The tree is the truth: an edit made through the shell never appears as a
  // write event, and a rule reading only events passes an unverified commit.
  if (!options.ignoreGit) for (const file of changedFiles(graph.root)) written.add(file)

  const sources: string[] = []
  const hits = new Map<string, Reaching>()
  for (const file of written) {
    if (isTestFile(file, options.testFile)) hits.set(file, { file, depth: 0, via: 'written' })
    else sources.push(file)
  }
  // Narrow the seed to the symbols the diff actually touched where git can say.
  const ranges =
    options.ignoreGit || options.ignoreRanges ? undefined : changedRangesFor(graph.root, sources)
  for (const hit of reachingTests(graph, sources, { ...options, ranges })) {
    if (!hits.has(hit.file)) hits.set(hit.file, hit)
  }
  return [...hits.values()]
}

/**
 * Index of the last event that can change what the tests cover: a write to a
 * file the graph knows or a test file, or a shell command that mutates files.
 * A note write (`.state.md`) must not invalidate a green run, which is what a
 * bare last-write anchor did (#anchor); a shell edit must, which a
 * write-events-only anchor missed entirely (#shell-write).
 */
export function lastWriteIndex(events: readonly Event[], graph?: Graph, testFile?: RegExp): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.kind === 'command') {
      if (isShellWrite(event.command)) return i
      continue
    }
    if (event?.kind !== 'write') continue
    if (!graph) return i
    const file = relativize(graph, event.path)
    if (graph.nodesByFile.has(file) || isTestFile(file, testFile)) return i
  }
  return -1
}

/**
 * Did every file in `files` run green after `since`? A full-suite run
 * counts for all of them; output matching `failure` counts for none.
 */
export function ranGreenSince(
  events: readonly Event[],
  files: readonly string[],
  since: number,
  options: ImpactOptions = {},
  root?: string,
): boolean {
  const fullSuite = options.fullSuite ?? DEFAULT_FULL_SUITE
  const failure = options.failure ?? DEFAULT_FAILURE
  const testRunner = options.testRunner ?? DEFAULT_TEST_RUNNER
  const outstanding = new Set(files)
  for (const event of events.slice(since + 1)) {
    if (event.kind !== 'command' || !testRunner.test(event.command)) continue
    if (failure.test(event.output)) continue
    if (fullSuite.test(event.command)) return true
    for (const file of outstanding) if (mentions(event.command, file, root)) outstanding.delete(file)
    if (outstanding.size === 0) return true
  }
  return outstanding.size === 0
}

/** Files in `files` with no green run after `since`. */
export function unverified(
  events: readonly Event[],
  impacted: readonly Reaching[],
  since: number,
  options: ImpactOptions = {},
  root?: string,
): Reaching[] {
  return impacted.filter((hit) => !ranGreenSince(events, [hit.file], since, options, root))
}

/**
 * Does `command` name `file`, directly or through a directory it sits under?
 * `vitest run packages/tests` runs every test beneath that path, so a
 * per-file check alone under-counts what already ran (#dir-args).
 *
 * Absolute tokens are mapped back to repo-relative first. An agent that runs
 * `cd /abs/path/to/pkg && go test ./...` names the directory only in absolute
 * form, and comparing that to a repo-relative file credited nothing, so the
 * gate demanded a re-run of tests that had just passed (#abs-cwd).
 */
function mentions(command: string, file: string, root?: string): boolean {
  if (command.includes(file) || command.includes(basename(file))) return true
  return command.split(/\s+/).some((raw) => {
    const token = stripTrailingSlash(raw)
    if (token.length < 2 || token.startsWith('-')) return false
    const candidates = [token]
    if (root && token.startsWith(root)) candidates.push(relative(root, token))
    return candidates.some((candidate) => candidate.length > 0 && file.startsWith(candidate + '/'))
  })
}

function stripTrailingSlash(token: string): string {
  return token.endsWith('/') ? token.slice(0, -1) : token
}

/** `{files}` substitution for a runner template. */
export function suggestCommand(
  runner: string | ((files: readonly string[]) => string) | undefined,
  files: readonly string[],
): string {
  if (typeof runner === 'function') return runner(files)
  return (runner ?? 'npx vitest run {files}').replace('{files}', files.join(' '))
}

/** Shared block message: what is unverified, and the command that verifies it. */
export function verifyMessage(
  impacted: readonly Reaching[],
  command: string,
  maxListed: number,
  lead: string,
): string {
  const lines = impacted.slice(0, maxListed).map((hit) =>
    hit.via === 'written'
      ? `  ${hit.file} (written this session)`
      : `  ${hit.file} (${hit.via}, depth ${hit.depth})`,
  )
  if (impacted.length > maxListed) lines.push(`  ... and ${impacted.length - maxListed} more`)
  return [lead, ...lines, `Run: ${command}`, 'then retry.'].join('\n')
}
