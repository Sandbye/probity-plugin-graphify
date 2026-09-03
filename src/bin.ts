#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateStop, type StopGateOptions, type StopPayload } from './stop-gate.js'

const USAGE = `probity-graphify stop [options]

Claude Code Stop hook: refuses the end of a turn while tests that reach this
session's source edits have not run green.

  --depth N          reverse traversal depth in the code graph (default 2)
  --runner "CMD"     suggested command, {files} is substituted
  --max-listed N     how many files to itemize (default 12)
  --graph PATH       explicit graphify-out/graph.json
  --cwd PATH         repo root to search for the graph
  --config PATH      an ES module whose default export is a StopGateOptions
                     object, for options a flag cannot express (per-family
                     runners, a runner that groups files by workspace)
  --debug PATH       append each payload and decision as JSONL
`

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(USAGE)
    return 0
  }
  if (command !== 'stop') {
    process.stderr.write(`probity-graphify: unknown command "${command}"\n\n${USAGE}`)
    return 1
  }

  const flags = parseFlags(rest)
  const payload = parsePayload(await readStdin())
  const options: StopGateOptions = flags['config'] ? await loadOptions(flags['config']) : {}
  if (flags['depth']) options.depth = Number(flags['depth'])
  if (flags['runner']) options.runner = flags['runner']
  if (flags['max-listed']) options.maxListed = Number(flags['max-listed'])
  if (flags['graph']) options.graph = flags['graph']
  if (flags['cwd']) options.cwd = flags['cwd']

  // A hook that throws blocks the agent for a reason the agent cannot fix, so
  // any failure in here fails open.
  let decision
  try {
    decision = evaluateStop(payload, options)
  } catch (error) {
    decision = { kind: 'allow' as const, reason: `probity-graphify error: ${String(error)}` }
  }

  if (flags['debug']) {
    try {
      appendFileSync(flags['debug'], JSON.stringify({ datetime: new Date().toISOString(), payload, decision }) + '\n')
    } catch {
      // a debug log that cannot be written must not affect the verdict
    }
  }

  if (decision.kind === 'block') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: `Probity: ${decision.reason}` }) + '\n')
  }
  return 0
}

/**
 * Options from an ES module, for what flags cannot carry. A runner that has to
 * group files by workspace, or route Go files to `go test`, is a function; a
 * string template cannot express it, and a Stop gate that suggests an
 * unrunnable command is worse than none (#unrunnable).
 */
async function loadOptions(path: string): Promise<StopGateOptions> {
  const url = pathToFileURL(resolve(path)).href
  const module: unknown = await import(url)
  const config = (module as { default?: unknown }).default
  if (typeof config !== 'object' || config === null) {
    throw new Error(`${path}: expected a default-exported options object`)
  }
  return config as StopGateOptions
}

function parseFlags(argv: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg?.startsWith('--')) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[arg.slice(2)] = next
      i++
    } else {
      flags[arg.slice(2)] = 'true'
    }
  }
  return flags
}

function parsePayload(raw: string): StopPayload {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as StopPayload) : {}
  } catch {
    return {}
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(''))
  })
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  () => process.exit(0),
)
