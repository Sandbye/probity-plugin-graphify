import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { requireImpactedTests } from './require-impacted-tests.js'

const graph = fileURLToPath(new URL('../test/fixtures/graph.json', import.meta.url))
// graph.json sits in <root>/fixtures/graph.json, so the graph root is test/.
const root = dirname(dirname(graph))

const commit = { kind: 'command' as const, command: 'git commit -m "feat: cart"' }
const write = (file: string) => ({ kind: 'write' as const, path: `${root}/${file}`, content: '', output: '' })
const ran = (command: string, output = 'Tests  2 passed (2)') => ({ kind: 'command' as const, command, output })
const ctx = (...history: ReturnType<typeof write | typeof ran>[]) => ({ history: async () => history })

const GREEN_ALL = 'npx vitest run src/cart.test.ts src/checkout.test.ts src/other.test.ts'
const rule = requireImpactedTests({ graph, ignoreGit: true })

describe('requireImpactedTests', () => {
  it('ignores commands that are not gated', async () => {
    const result = await rule({ kind: 'command', command: 'ls' }, ctx(write('src/cart.ts')))
    expect(result.kind).toBe('pass')
  })

  it('ignores writes', async () => {
    const result = await rule({ kind: 'write', path: `${root}/src/cart.ts`, content: '' }, ctx())
    expect(result.kind).toBe('pass')
  })

  it('passes when nothing was written', async () => {
    expect((await rule(commit, ctx(ran('npm test')))).kind).toBe('pass')
  })

  it('passes when no test reaches the written file', async () => {
    expect((await rule(commit, ctx(write('src/orphan.ts')))).kind).toBe('pass')
  })

  it('passes when no graph is found', async () => {
    const result = await requireImpactedTests({ cwd: '/', ignoreGit: true })(commit, ctx(write('/x/src/cart.ts')))
    expect(result.kind).toBe('pass')
  })

  it('blocks when reaching tests never ran', async () => {
    const result = await rule(commit, ctx(write('src/cart.ts')))
    expect(result.kind).toBe('violation')
    if (result.kind !== 'violation') return
    expect(result.reason).toContain('src/cart.test.ts (imports_from, depth 1)')
    expect(result.reason).toContain('src/checkout.test.ts (imports_from, depth 2)')
    expect(result.reason).toContain('src/other.test.ts')
  })

  it('blocks when the tests ran before the last write', async () => {
    const result = await rule(
      commit,
      ctx(write('src/cart.ts'), ran(GREEN_ALL), write('src/cart.ts')),
    )
    expect(result.kind).toBe('violation')
  })

  it('blocks when only some reaching tests ran', async () => {
    const result = await rule(commit, ctx(write('src/cart.ts'), ran('npx vitest run src/cart.test.ts')))
    expect(result.kind).toBe('violation')
  })

  it('blocks when the run failed', async () => {
    const result = await rule(
      commit,
      ctx(write('src/cart.ts'), ran(GREEN_ALL, 'Tests  1 failed | 1 passed')),
    )
    expect(result.kind).toBe('violation')
  })

  it('passes when every reaching test ran green after the last write', async () => {
    const result = await rule(
      commit,
      ctx(write('src/cart.ts'), ran(GREEN_ALL)),
    )
    expect(result.kind).toBe('pass')
  })

  it('accepts a full-suite run', async () => {
    expect((await rule(commit, ctx(write('src/cart.ts'), ran('pnpm test')))).kind).toBe('pass')
  })

  it('counts a written test file as impacted', async () => {
    const result = await rule(commit, ctx(write('src/checkout.test.ts')))
    expect(result.kind).toBe('violation')
    if (result.kind !== 'violation') return
    expect(result.reason).toContain('src/checkout.test.ts (written this session)')
  })

  it('caps the itemized list but keeps every file in the command', async () => {
    const result = await requireImpactedTests({ graph, ignoreGit: true, maxListed: 1 })(commit, ctx(write('src/cart.ts')))
    if (result.kind !== 'violation') throw new Error('expected violation')
    expect(result.reason).toContain('more')
    expect(result.reason).toContain('src/other.test.ts')
  })

  // Regressions from the first real session on trpc.
  it('ignores a non-code write when deciding what invalidates a green run', async () => {
    const note = { kind: 'write' as const, path: `${root}/notes/.state.md`, content: '', output: '' }
    const result = await rule(
      commit,
      ctx(write('src/cart.ts'), ran(GREEN_ALL), note),
    )
    expect(result.kind).toBe('pass')
  })

  it('counts a directory argument as covering the tests beneath it', async () => {
    const result = await rule(commit, ctx(write('src/cart.ts'), ran('npx vitest run src')))
    expect(result.kind).toBe('pass')
  })

  it('does not read a non-test command as evidence of a test run', async () => {
    const result = await rule(
      commit,
      ctx(write('src/cart.ts'), ran('grep -rn cart src/cart.test.ts', 'match')),
    )
    expect(result.kind).toBe('violation')
  })

  it('treats a shell edit as a write for timing', async () => {
    const shell = ran("cat > src/cart.ts <<'EOF'\nx\nEOF", '')
    const result = await rule(
      commit,
      ctx(write('src/cart.ts'), ran(GREEN_ALL), shell),
    )
    expect(result.kind).toBe('violation')
  })

  it('credits a run whose only path reference is an absolute cwd', async () => {
    // cd /root/src && go test ./...  names the directory in absolute form only.
    const command = `cd ${root}/src && go test ./...`
    const result = await rule(commit, ctx(write('src/cart.ts'), ran(command)))
    expect(result.kind).toBe('pass')
  })

  it('passes when no configured runner covers the impacted files', async () => {
    const goOnly = requireImpactedTests({
      graph,
      ignoreGit: true,
      runners: [{ match: /_test\.go$/, command: 'go test ./...' }],
    })
    const result = await goOnly(commit, ctx(write('src/cart.ts')))
    expect(result.kind).toBe('pass')
    expect(result.reason).toContain('no configured runner covers')
  })

  it('blocks on the covered files and reports the uncovered ones', async () => {
    const jsOnly = requireImpactedTests({
      graph,
      ignoreGit: true,
      runners: [{ match: /cart\.test\.ts$/, command: 'npx vitest run {files}' }],
    })
    const result = await jsOnly(commit, ctx(write('src/cart.ts')))
    expect(result.kind).toBe('violation')
    if (result.kind !== 'violation') return
    expect(result.reason).toContain('1 test file(s) reach your changes')
    expect(result.reason).toContain('Run: npx vitest run src/cart.test.ts')
    expect(result.reason).toContain('Not checked, no configured runner:')
    expect(result.reason).toContain('src/checkout.test.ts')
  })

  it('routes each family to its own runner', async () => {
    const both = requireImpactedTests({
      graph,
      ignoreGit: true,
      runners: [
        { match: /other\.test\.ts$/, command: 'go test ./...' },
        { match: /\.test\.ts$/, command: 'npx vitest run {files}' },
      ],
    })
    const result = await both(commit, ctx(write('src/cart.ts')))
    if (result.kind !== 'violation') throw new Error('expected violation')
    // Groups are ordered by the first file that matched, not by spec order.
    expect(result.reason).toContain('go test ./...')
    expect(result.reason).toContain('npx vitest run')
    expect(result.reason).toContain(' && ')
    expect(result.reason).not.toContain('Not checked')
  })

  it('seeds from whole files unless narrowing is asked for', async () => {
    // src/cart.ts holds two symbols with different tests; whole-file seeding
    // must keep both, since a missed test is worse than a spare one.
    const result = await rule(commit, ctx(write('src/cart.ts')))
    if (result.kind !== 'violation') throw new Error('expected violation')
    expect(result.reason).toContain('src/cart.test.ts')
    expect(result.reason).toContain('src/other.test.ts')
  })

  it('honours a custom runner and gate', async () => {
    const custom = requireImpactedTests({ graph, ignoreGit: true, before: /git push/, runner: 'pytest {files}' })
    expect((await custom(commit, ctx(write('src/cart.ts')))).kind).toBe('pass')
    const result = await custom({ kind: 'command', command: 'git push' }, ctx(write('src/cart.ts')))
    expect(result.kind).toBe('violation')
    if (result.kind !== 'violation') return
    expect(result.reason).toContain('Run: pytest src/')
  })
})
