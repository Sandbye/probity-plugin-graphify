import { readFileSync, existsSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

/** The subset of graphify's graph.json this package reads. */
export type GraphJson = {
  nodes: readonly { id: string; label?: string; source_file?: string; source_location?: string }[]
  edges: readonly { source: string; target: string; relation: string }[]
}

/** Raised when graph.json is missing, unreadable, or not the shape we know. */
export class GraphFormatError extends Error {}

export type Graph = {
  /** Directory that contains graphify-out/. Node source_file paths are relative to it. */
  root: string
  nodesByFile: Map<string, string[]>
  fileOfNode: Map<string, string>
  /** Definition line per node, when graphify recorded one. */
  lineOfNode: Map<string, number>
  /** Nodes that stand for a whole file rather than a symbol inside it. */
  fileNodes: Set<string>
  /** target -> [{ source, relation }]: who depends on this node. */
  reverse: Map<string, { source: string; relation: string }[]>
}

/** `depth` counts file boundaries crossed, so `via` names the edge that left the file. */
export type Reaching = { file: string; depth: number; via: string }

/** A changed line range, inclusive, in the file's current numbering. */
export type LineRange = readonly [number, number]

// Mirrors graphify's DEFAULT_AFFECTED_RELATIONS so `graphify affected` and this rule agree.
export const DEFAULT_RELATIONS: readonly string[] = [
  'calls',
  'indirect_call',
  'references',
  'imports',
  'imports_from',
  'dynamic_import',
  're_exports',
  'inherits',
  'extends',
  'implements',
  'uses',
  'mixes_in',
  'embeds',
  'requires',
]

// Filename patterns only: a `test/` directory also holds helpers and fixtures.
export const DEFAULT_TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/

export function isTestFile(path: string, pattern: RegExp = DEFAULT_TEST_FILE): boolean {
  return pattern.test(toPosix(path))
}

/** Walk up from `from` to the nearest directory holding graphify-out/graph.json. */
export function findGraphFile(from: string): string | undefined {
  let dir = resolve(from)
  for (;;) {
    const candidate = join(dir, 'graphify-out', 'graph.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export function loadGraph(graphFile: string): Graph {
  let raw: string
  try {
    raw = readFileSync(graphFile, 'utf8')
  } catch (error) {
    throw new GraphFormatError(`cannot read ${graphFile}: ${String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new GraphFormatError(`${graphFile} is not valid JSON: ${String(error)}`)
  }
  return buildGraph(asGraphJson(parsed, graphFile), dirname(dirname(resolve(graphFile))))
}

/**
 * graphify owns this format and has changed it before (an older graph.json
 * carried `links` rather than `edges`). Validate rather than cast, so a
 * format change surfaces as a named error the caller can fail open on
 * instead of a TypeError deep in traversal (#graph-format).
 */
export function asGraphJson(parsed: unknown, source = 'graph.json'): GraphJson {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new GraphFormatError(`${source}: expected an object`)
  }
  const record = parsed as Record<string, unknown>
  const nodes = record['nodes']
  const edges = record['edges'] ?? record['links']
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    const keys = Object.keys(record).slice(0, 8).join(', ')
    throw new GraphFormatError(
      `${source}: expected "nodes" and "edges" arrays, found [${keys}]. Rebuild it with a current graphify.`,
    )
  }
  return { nodes, edges } as GraphJson
}

export function buildGraph(json: GraphJson, root: string): Graph {
  const nodesByFile = new Map<string, string[]>()
  const fileOfNode = new Map<string, string>()
  const lineOfNode = new Map<string, number>()
  const fileNodes = new Set<string>()
  for (const node of json.nodes) {
    if (!node.source_file) continue
    const file = toPosix(node.source_file)
    fileOfNode.set(node.id, file)
    const line = parseLine(node.source_location)
    if (line !== undefined) lineOfNode.set(node.id, line)
    // graphify labels a file node with the file's own name; symbol nodes carry
    // the symbol. Both can sit at L1, so the label is what separates them.
    if (node.label !== undefined ? node.label === basename(file) : line === 1) fileNodes.add(node.id)
    const list = nodesByFile.get(file) ?? []
    list.push(node.id)
    nodesByFile.set(file, list)
  }
  const reverse = new Map<string, { source: string; relation: string }[]>()
  for (const edge of json.edges) {
    const list = reverse.get(edge.target) ?? []
    list.push({ source: edge.source, relation: edge.relation })
    reverse.set(edge.target, list)
  }
  return { root, nodesByFile, fileOfNode, lineOfNode, fileNodes, reverse }
}

/** Repo-relative POSIX path for an absolute path, or the input if already relative. */
export function relativize(graph: Graph, path: string): string {
  const posix = toPosix(path)
  if (!posix.startsWith('/')) return posix
  return toPosix(relative(graph.root, path))
}

/**
 * The nodes a traversal starts from for a change to `file`.
 *
 * With no ranges, every node in the file. With ranges, only the symbols whose
 * span they touch: graphify resolves an import to the symbol imported, so a
 * change confined to one symbol need not drag in the tests that use another. A
 * symbol owns the lines from its definition to the next definition, because
 * graphify records a definition line and not a span.
 *
 * Every unresolvable case widens to the whole file rather than narrowing. A
 * change above the first symbol is module header (imports, module-level code)
 * and can affect anything in the file, and a missed test is worse than a
 * spare one.
 */
export function seedNodes(graph: Graph, file: string, ranges?: readonly LineRange[]): string[] {
  const all = graph.nodesByFile.get(file) ?? []
  if (!ranges || ranges.length === 0 || all.length === 0) return all

  const symbols = all
    .filter((id) => graph.lineOfNode.has(id) && !graph.fileNodes.has(id))
    .map((id) => ({ id, start: graph.lineOfNode.get(id) as number }))
    .sort((a, b) => a.start - b.start)
  const first = symbols[0]
  if (!first) return all
  if (ranges.some(([start]) => start < first.start)) return all

  const matched = symbols
    .filter((symbol, index) => {
      const end = index + 1 < symbols.length ? (symbols[index + 1]?.start ?? Infinity) - 1 : Infinity
      return ranges.some(([start, stop]) => start <= end && stop >= symbol.start)
    })
    .map((symbol) => symbol.id)
  if (matched.length === 0) return all
  // Keep the file node: a dependent that imports the module rather than a
  // named symbol hangs off it, and dropping it would lose those tests.
  return [...matched, ...all.filter((id) => graph.fileNodes.has(id))]
}

/**
 * Files whose nodes depend on `file`, by reverse traversal.
 *
 * `depth` counts file boundaries crossed, not edges: a call chain inside one
 * file is part of the same change surface, so it costs nothing. That keeps
 * `depth: 1` meaning "the modules that use this directly" wherever in the file
 * the edit landed.
 */
export function reachingFiles(
  graph: Graph,
  file: string,
  options: { depth?: number; relations?: readonly string[]; ranges?: readonly LineRange[] } = {},
): Reaching[] {
  const depth = options.depth ?? 2
  const relations = new Set(options.relations ?? DEFAULT_RELATIONS)
  const seed = relativize(graph, file)
  const seedIds = seedNodes(graph, seed, options.ranges)
  if (seedIds.length === 0) return []

  const budgets = new Map<string, number>(seedIds.map((id) => [id, depth]))
  const queue = [...seedIds]
  const found = new Map<string, Reaching>()

  while (queue.length > 0) {
    const target = queue.shift() as string
    const budget = budgets.get(target) as number
    for (const { source, relation } of graph.reverse.get(target) ?? []) {
      if (!relations.has(relation)) continue
      const sourceFile = graph.fileOfNode.get(source)
      const crosses = sourceFile !== graph.fileOfNode.get(target)
      const left = crosses ? budget - 1 : budget
      if (left < 0) continue
      // Revisit only when reached with more budget left than last time.
      if ((budgets.get(source) ?? -1) >= left) continue
      budgets.set(source, left)
      queue.push(source)
      if (!sourceFile || sourceFile === seed) continue
      const reachedAt = depth - left
      const prior = found.get(sourceFile)
      if (!prior || reachedAt < prior.depth) {
        found.set(sourceFile, { file: sourceFile, depth: reachedAt, via: relation })
      }
    }
  }
  return [...found.values()]
}

/** Test files reaching any of `files`, de-duplicated, shallowest hit wins. */
export function reachingTests(
  graph: Graph,
  files: readonly string[],
  options: {
    depth?: number
    relations?: readonly string[]
    testFile?: RegExp
    /** Changed line ranges per repo-relative file, for symbol-level seeding. */
    ranges?: ReadonlyMap<string, readonly LineRange[]>
  } = {},
): Reaching[] {
  const found = new Map<string, Reaching>()
  for (const file of files) {
    const ranges = options.ranges?.get(relativize(graph, file))
    for (const hit of reachingFiles(graph, file, { ...options, ranges })) {
      if (!isTestFile(hit.file, options.testFile)) continue
      const prior = found.get(hit.file)
      if (!prior || hit.depth < prior.depth) found.set(hit.file, hit)
    }
  }
  return [...found.values()]
}

function parseLine(location: string | undefined): number | undefined {
  if (!location) return undefined
  const match = /^L(\d+)/.exec(location)
  return match?.[1] ? Number(match[1]) : undefined
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}
