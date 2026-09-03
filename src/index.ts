export { forbidShellFileWrites, type ForbidShellFileWritesOptions } from './forbid-shell-file-writes.js'
export { changedFiles, changedRanges, changedRangesFor, isShellWrite, SHELL_WRITE } from './changed.js'
export { evaluateStop, decide, type StopGateOptions, type StopPayload, type StopDecision } from './stop-gate.js'
export { readTranscript } from './transcript.js'
export {
  impactedTests,
  planRun,
  ranGreenSince,
  unverified,
  type Event,
  type ImpactOptions,
  type RunnerSpec,
  type RunPlan,
} from './impact.js'
export { requireReachingTest, type RequireReachingTestOptions } from './require-reaching-test.js'
export { requireImpactedTests, type RequireImpactedTestsOptions } from './require-impacted-tests.js'
export {
  asGraphJson,
  GraphFormatError,
  seedNodes,
  DEFAULT_RELATIONS,
  DEFAULT_TEST_FILE,
  findGraphFile,
  isTestFile,
  loadGraph,
  reachingFiles,
  reachingTests,
  type Graph,
  type Reaching,
  type LineRange,
} from './graph.js'
