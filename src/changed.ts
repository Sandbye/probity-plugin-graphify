import { execFileSync } from 'node:child_process'

/**
 * Shell idioms that mutate a file. An agent told to prefer the shell edits
 * with these instead of the Write/Edit tools, and a rule that only watches
 * write actions then sees an empty session while the tree changes (#shell-write).
 */
export const SHELL_WRITE = new RegExp(
  [
    // a redirect into a path: `cat > f`, `printf x >> f`
    String.raw`(?:^|[;&|]|\s)(?:cat|printf|echo)\b[^;&|]*?(?<![-=<])>>?\s*(?!&\d)(?!/dev/null)\S`,
    // a heredoc, which is how an inline script or file body is passed
    String.raw`<<\s*'?[A-Za-z_]+'?\s*$`,
    // `tee f`, which writes its path arguments
    String.raw`\btee\s+(?!-)(?!/dev/null)\S`,
    String.raw`\bsed\s+(?:-[^\s]*\s+)*-i`,
    String.raw`\b(?:python3?|node|ruby|perl)\b[^;&|]*\b(?:write_text|writeFileSync|writeFile)`,
  ].join('|'),
  'm',
)

export function isShellWrite(command: string): boolean {
  return SHELL_WRITE.test(command)
}

/**
 * Files changed in the working tree relative to HEAD: unstaged, staged and
 * untracked. This is the source of truth for "what did this session change",
 * because it holds regardless of how the edit was made.
 */
export function changedFiles(cwd: string): string[] {
  const files = new Set<string>()
  for (const args of [
    ['diff', '--name-only', 'HEAD'],
    ['diff', '--name-only', '--cached', 'HEAD'],
    ['ls-files', '--others', '--exclude-standard'],
  ]) {
    for (const line of git(cwd, args)) files.add(line)
  }
  return [...files]
}

function git(cwd: string, args: readonly string[]): string[] {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    return out.split('\n').filter(Boolean)
  } catch {
    return [] // not a repo, no HEAD yet, or git unavailable: fall back to transcript writes
  }
}

/**
 * Changed line ranges for one file, in its current numbering, from the
 * working tree against HEAD. Empty means "unknown" (untracked file, no HEAD,
 * git unavailable), and callers must widen to the whole file rather than
 * narrow on an empty answer.
 */
export function changedRanges(cwd: string, file: string): [number, number][] {
  return changedRangesFor(cwd, [file]).get(file) ?? []
}

/**
 * Changed ranges for several files, skipping those git knows nothing about.
 *
 * Two git calls for the whole set rather than two per file. Per-file calls put
 * the gate's cost on the number of changed files (a four-file change already
 * spent 11 subprocesses and ~200ms), which a large change would make painful.
 */
export function changedRangesFor(
  cwd: string,
  files: readonly string[],
): Map<string, [number, number][]> {
  const wanted = new Set(files)
  const map = new Map<string, [number, number][]>()
  const seen = new Set<string>()

  for (const args of [
    ['diff', '-U0', 'HEAD', '--', ...files],
    ['diff', '-U0', '--cached', 'HEAD', '--', ...files],
  ]) {
    if (files.length === 0) break
    let current: string | undefined
    for (const line of git(cwd, args)) {
      // `+++ b/path` opens each file's section; /dev/null means a deletion.
      const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(line)
      if (header?.[1]) {
        const path = header[1] === '/dev/null' ? undefined : header[1]
        current = path && wanted.has(path) ? path : undefined
        continue
      }
      if (!current) continue
      const range = parseHunk(line)
      if (!range) continue
      const key = `${current}:${range.join(':')}`
      if (seen.has(key)) continue
      seen.add(key)
      map.set(current, [...(map.get(current) ?? []), range])
    }
  }
  return map
}

/** `@@ -old,count +new,count @@` to an inclusive range in the new numbering. */
function parseHunk(line: string): [number, number] | undefined {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
  if (!match?.[1]) return undefined
  const start = Number(match[1])
  const count = match[2] === undefined ? 1 : Number(match[2])
  // A pure deletion reports count 0: the surrounding lines are what changed.
  return count === 0 ? [Math.max(1, start), start + 1] : [start, start + count - 1]
}
