import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { changedFiles, changedRanges, isShellWrite } from './changed.js'

describe('isShellWrite', () => {
  it.each([
    'cat > packages/a.ts <<EOF',
    "cat > a.ts <<'EOF'",
    'sed -i "" s/a/b/ src/a.ts',
    'sed -i.bak s/a/b/ src/a.ts',
    "python3 - <<'PY'",
    'printf "x" > src/a.ts',
    'echo hi >> notes.md',
    'tee src/a.ts < in.txt',
    "node -e \"require('fs').writeFileSync('a.ts','x')\"",
  ])('flags %s', (command) => expect(isShellWrite(command)).toBe(true))

  it.each([
    'npx vitest run src/a.test.ts',
    'git commit -m "x"',
    'cat src/a.ts',
    'grep -rn foo src/',
    'ls > /dev/null',
    'node --version',
    'echo hi',
    'diff a b',
  ])('leaves %s alone', (command) => expect(isShellWrite(command)).toBe(false))
})

describe('changedFiles', () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pg-repo-'))
    const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
    run('init', '-q')
    run('config', 'user.email', 't@example.com')
    run('config', 'user.name', 'Test')
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1\n')
    run('add', '-A')
    run('commit', '-qm', 'init')
    return dir
  }

  it('is empty on a clean tree', () => {
    expect(changedFiles(repo())).toEqual([])
  })

  it('reports unstaged, staged and untracked files', () => {
    const dir = repo()
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2\n')
    writeFileSync(join(dir, 'src/b.ts'), 'export const b = 1\n')
    execFileSync('git', ['-C', dir, 'add', 'src/b.ts'], { stdio: 'ignore' })
    writeFileSync(join(dir, 'src/c.ts'), 'export const c = 1\n')
    expect(changedFiles(dir).sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
  })

  it('returns nothing outside a repo instead of throwing', () => {
    expect(changedFiles(mkdtempSync(join(tmpdir(), 'pg-bare-')))).toEqual([])
  })
})

describe('changedRanges', () => {
  function repoWithFile(lines: readonly string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'pg-ranges-'))
    const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
    run('init', '-q')
    run('config', 'user.email', 't@example.com')
    run('config', 'user.name', 'Test')
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src/a.ts'), lines.join('\n') + '\n')
    run('add', '-A')
    run('commit', '-qm', 'init')
    return dir
  }

  const twenty = Array.from({ length: 20 }, (_, i) => `const line${i + 1} = ${i + 1}`)

  it('is empty for an unchanged file, so callers widen', () => {
    expect(changedRanges(repoWithFile(twenty), 'src/a.ts')).toEqual([])
  })

  it('reports the changed line range', () => {
    const dir = repoWithFile(twenty)
    const edited = [...twenty]
    edited[9] = 'const line10 = 999'
    writeFileSync(join(dir, 'src/a.ts'), edited.join('\n') + '\n')
    expect(changedRanges(dir, 'src/a.ts')).toEqual([[10, 10]])
  })

  it('reports a multi-line insertion as one range', () => {
    const dir = repoWithFile(twenty)
    const edited = [...twenty.slice(0, 5), 'const added1 = 1', 'const added2 = 2', ...twenty.slice(5)]
    writeFileSync(join(dir, 'src/a.ts'), edited.join('\n') + '\n')
    expect(changedRanges(dir, 'src/a.ts')).toEqual([[6, 7]])
  })

  it('reports a deletion as the surrounding lines', () => {
    const dir = repoWithFile(twenty)
    writeFileSync(join(dir, 'src/a.ts'), [...twenty.slice(0, 9), ...twenty.slice(10)].join('\n') + '\n')
    const ranges = changedRanges(dir, 'src/a.ts')
    expect(ranges).toHaveLength(1)
    expect(ranges[0]?.[0]).toBeLessThanOrEqual(10)
  })

  it('is empty outside a repo', () => {
    expect(changedRanges(mkdtempSync(join(tmpdir(), 'pg-bare-')), 'src/a.ts')).toEqual([])
  })
})
