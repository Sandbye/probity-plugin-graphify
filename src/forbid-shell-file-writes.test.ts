import { describe, expect, it } from 'vitest'
import { forbidShellFileWrites } from './forbid-shell-file-writes.js'

const rule = forbidShellFileWrites()

describe('forbidShellFileWrites', () => {
  it('ignores writes', async () => {
    expect((await rule({ kind: 'write', path: '/r/src/a.ts', content: '' })).kind).toBe('pass')
  })

  it('blocks a heredoc into a file and says to use the Write tool', async () => {
    const result = await rule({ kind: 'command', command: "cat > src/a.ts <<'EOF'\nx\nEOF" })
    expect(result.kind).toBe('violation')
    if (result.kind !== 'violation') return
    expect(result.reason).toContain('Write or Edit tool')
  })

  it('blocks an in-place script edit', async () => {
    const command = "python3 - <<'PY'\nimport pathlib\npathlib.Path('src/a.ts').write_text('x')\nPY"
    expect((await rule({ kind: 'command', command })).kind).toBe('violation')
  })

  it('allows ordinary commands', async () => {
    expect((await rule({ kind: 'command', command: 'npx vitest run src/a.test.ts' })).kind).toBe('pass')
    expect((await rule({ kind: 'command', command: 'cat src/a.ts' })).kind).toBe('pass')
  })

  it('honours an allow pattern', async () => {
    const lenient = forbidShellFileWrites({ allow: /\.state\.md/ })
    const result = await lenient({ kind: 'command', command: "cat > .state.md <<'EOF'\nx\nEOF" })
    expect(result.kind).toBe('pass')
  })

  it('honours a custom reason', async () => {
    const custom = forbidShellFileWrites({ reason: 'use the tools' })
    const result = await custom({ kind: 'command', command: 'sed -i "" s/a/b/ src/a.ts' })
    if (result.kind !== 'violation') throw new Error('expected violation')
    expect(result.reason).toBe('use the tools')
  })
})
