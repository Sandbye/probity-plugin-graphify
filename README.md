# probity-plugin-graphify

[Probity](https://github.com/nizos/probity) rules that know **which tests reach the code the agent just changed**.

Probity's `enforceTdd` knows that *a* failing test was observed. It cannot know that the file being edited is covered by 29 other test files in four packages. These rules read a [graphify](https://github.com/Graphify-Labs/graphify) code graph, walk it backwards from the changed files, and refuse to let the agent commit or end its turn until those tests have run green.

Deterministic, no LLM calls, no API key. A reverse traversal on a 15k-edge graph takes about 25ms.

## Why

[TDAD](https://arxiv.org/abs/2603.17973) measured three agent setups on 100 SWE-bench Verified tasks:

| setup | test-level regressions | pass-to-pass failures |
| --- | --- | --- |
| vanilla agent | 6.08% | 562 |
| TDD prompting only | 9.94% | 799 |
| graph-selected impacted tests + TDD | **1.82%** | **155** |

Prompting an agent to do TDD made regressions worse. The reduction came from selecting impacted tests from a code graph and running them before submitting. That selection step is what this package adds.

## What it does

Same issue (tRPC [#7468](https://github.com/trpc/trpc/issues/7468)), same model, three runs:

| | no rules | rules bypassed | all four rules |
| --- | --- | --- | --- |
| TDD order | implementation first | invisible | **test first** |
| source lines changed | 26 | 26 | **16** |
| unrequested `isDone` guard | 8 lines | 8 lines | **none** |
| test lines | 102 | 72 | 105 |
| blocks | 1 | 0 | 4 |

The point is the third column. The agent wrote less production code and more test, because every write had to be justified by a failing assertion and every commit had to be verified against the tests that reach it.

What the agent saw in run 1, at the commit it tried to make:

```
Probity: 29 test file(s) reach your changes and have not run green since your last write:
  packages/tests/server/regression/issue-7468-http-links-abort-on-unsubscribe.test.ts (written this session)
  packages/react-query/test/abortOnUnmount.test.tsx (imports, depth 1)
  packages/tests/server/errors.test.ts (imports, depth 1)
  ... and 26 more
Run: pnpm vitest run packages/tests/server/regression/issue-7468-...
then retry.
```

It had hand-picked three test files to run. `abortOnUnmount.test.tsx` was not one of them, on an abort-on-unsubscribe fix.

## Install

Not on npm yet. For now:

```bash
git clone https://github.com/Sandbye/probity-plugin-graphify.git
cd probity-plugin-graphify && pnpm install && pnpm build
```

Then in your own repo:

```bash
pnpm add -D @nizos/probity
pnpm add -D file:../probity-plugin-graphify
pip install graphifyy     # or: uv tool install graphifyy
graphify extract . --code-only --no-cluster
```

The last command writes `graphify-out/graph.json`. Rebuild it with `graphify update .` after a refactor, or install graphify's git hook to keep it warm.

## Use

```ts
// probity.config.ts
import { defineConfig, enforceTdd } from '@nizos/probity'
import {
  forbidShellFileWrites,
  requireImpactedTests,
  requireReachingTest,
} from 'probity-plugin-graphify'

export default defineConfig({
  rules: [
    forbidShellFileWrites(),
    requireImpactedTests({ depth: 1, runner: 'pnpm vitest run {files}' }),
    {
      files: ['src/**', 'test/**'],
      rules: [enforceTdd(), requireReachingTest()],
    },
  ],
})
```

For the turn-end gate, add a `Stop` hook alongside Probity's `PreToolUse` one:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx probity-graphify stop --depth 1 --runner 'pnpm vitest run {files}'"
          }
        ]
      }
    ]
  }
}
```

## Rules

### `requireImpactedTests(options?)`

Gates a command (default `git commit`) on every test file that reaches this session's changes having run green since the last code change. Changed files come from the session transcript **and** `git` working-tree state, so an edit made any way at all is covered.

| option | default | |
| --- | --- | --- |
| `before` | `/git commit/` | which commands to gate |
| `depth` | `2` | reverse traversal depth |
| `runner` | `npx vitest run {files}` | suggested command, `{files}` substituted |
| `maxListed` | `12` | how many files to itemize |
| `graph` | nearest `graphify-out/graph.json` | explicit graph path |
| `ignoreGit` | `false` | use transcript writes only |
| `ignoreRanges` | `false` | seed whole files instead of changed symbols |

`depth` counts **file boundaries crossed**, not edges. A call chain inside one file is part of the same change surface, so it costs nothing, and `depth: 1` keeps meaning "the modules that use this directly" wherever in the file the edit landed. Use `depth: 1` on repos with hub modules: in tRPC, one file in `packages/server/src/observable/` reaches 22 test files at depth 1 and 79 at depth 2, out of 170.

Seeding is symbol-level. graphify resolves an import to the symbol imported, so a change confined to one function does not drag in the tests that use another. Changed line ranges come from `git diff -U0`, and every unresolvable case widens to the whole file rather than narrowing: a change above the first symbol is module header and can affect anything, and a missed test is worse than a spare one. Across tRPC's 134 multi-symbol source files with at least one reaching test, narrowing can cut the set in 78 of them, summed 733 test files down to 234 in the best case. Some concrete ones:

| file | whole-file | one symbol |
| --- | --- | --- |
| `unstable-core-do-not-import/initTRPC.ts` | 119 | 4 |
| `createTRPCClient.ts` | 31 | 2 |
| `observable/observable.ts` | 22 | 2 |
| `unstable-core-do-not-import/router.ts` (31 symbols) | 17 | 1 |

The caveat, measured on the real tRPC #7468 fix: it added an import, which lands in the header, so it widened to the whole file and narrowing gained nothing. Symbol-level seeding pays on edits inside one function, not on edits that change a module's imports.

### `requireReachingTest(options?)`

Blocks a write to a source file that **no** test reaches. Paired with `enforceTdd`, this makes the failing test have to be a *related* one. Passes for test files, for files the graph does not know (new files, which `enforceTdd` owns), and when a test naming the file was written earlier in the session.

### `forbidShellFileWrites(options?)`

Blocks shell file mutation (`cat > f`, heredocs, `sed -i`, inline scripts calling `write_text`) so edits go through the Write and Edit tools, where every write-gated rule can see them.

This is not hypothetical. With Claude Code's auto mode active, the agent is told to make file changes through the shell. In run 2 above, all 42 tool calls were `Bash`, zero were `Write` or `Edit`, and every write-gated rule including Probity's own `enforceTdd` saw an idle session while three files changed and a commit landed.

### `probity-graphify stop`

Claude Code `Stop` hook. Refuses the end of a turn while tests reaching the session's changes are unverified. Catches the common case where the agent never commits at all, because you do.

## Failure behaviour

Every path fails **open**. No graph, an unreadable graph, a `graph.json` in a format this version does not know, an unknown file, a git command that fails: the rule passes and carries the reason. Probity fail-closes on a throwing rule, so failing open matters, otherwise a graphify upgrade would block every commit in the repo.

## Limits

- **Static.** Imports and calls in source. Reflection, string-keyed dispatch and runtime DI are invisible. TDAD covered this with coverage-learned links; not implemented here.
- **Symbol-level, but only where the diff allows it.** A change touching module header lines widens to the whole file, and cross-package `imports_from` edges that land on a file node rather than a symbol cannot be narrowed at all.
- **Workspace packages that export `dist`** need either tsconfig `paths` (tRPC has them) or a `"source": "./src/index.ts"` condition in `exports`, or cross-package reach is invisible. Adding that condition is inert for node and tsc.
- **The graph lags the session.** A test written this session is handled; a new *caller* added this session is not seen until `graphify update` runs.
- **`enforceTdd` costs a turn** per write in scope, around 5s. These rules cost nothing.

## Versions

Tested against `@nizos/probity` 1.10.0 and `graphifyy` 0.9.53. A weekly CI job runs the suite plus a contract check against the latest release of both, so upstream drift surfaces here rather than in your session.

## Credits

- [Probity](https://github.com/nizos/probity) by Nizar Selander (MIT), which these rules plug into. The shell-redirect detection in `forbidShellFileWrites` follows the pattern used by Probity's own `forbidCommandPattern` config.
- [graphify](https://github.com/Graphify-Labs/graphify) by Graphify-Labs (Apache-2.0), which builds the code graph. `DEFAULT_RELATIONS` mirrors graphify's own `DEFAULT_AFFECTED_RELATIONS` so `graphify affected` and these rules agree.
- [TDAD](https://github.com/pepealonso95/TDAD) by Rafael Alonso (MIT), the source of the approach and the regression numbers.

## License

MIT
