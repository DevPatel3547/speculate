/**
 * `speculate-tools/eval`: offline evaluation of predictors on recorded agent trajectories.
 * See docs/trace-format.md for the JSONL format.
 */
export {
  parseTrajectoriesJsonl,
  readTrajectoriesFile,
  validateTrajectory,
  type Trajectory,
  type TraceStep,
  type TraceParseError,
} from "./eval/trace-format.js";
export {
  evaluateTraces,
  formatEvalReport,
  type EvaluateOptions,
  type EvalReport,
  type HitStats,
  type ToolReport,
  type TimingAssumptions,
} from "./eval/evaluate.js";
