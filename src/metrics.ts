/** Counters describing what a Speculator did. All values are cumulative. */
export interface SpeculationMetrics {
  /** Real tool calls made by the agent. */
  realCalls: number;
  /** Real calls to tools the policy allows speculating. */
  eligibleCalls: number;
  /** Served from a completed speculative execution. */
  hits: number;
  /** Matched a speculative execution still in flight (joined it). */
  joins: number;
  /** Matched, but rejected by a staleness validator / epoch / age and re-executed. */
  staleRejected: number;
  /** Matched, but the speculative execution errored or was rejected; re-executed. */
  specFailedFallbacks: number;
  /** Prediction rounds started. */
  rounds: number;
  /** Predictions skipped because the tool is not allowed (e.g. side_effecting). */
  skippedUnsafe: number;
  /** Predictions skipped because of the spend budget. */
  skippedBudget: number;
  /** Speculative executions started. */
  launched: number;
  /** Speculative executions whose results were never used. */
  wasted: number;
  /** Of those, how many were cancelled (AbortController) before finishing. */
  aborted: number;
  timeouts: number;
  /** Agent-visible latency removed, in ms (completed hit: full tool time; join: time already elapsed). */
  latencySavedMs: number;
  /** Tool time spent on executions that were thrown away, in ms. */
  wastedToolMs: number;
  /** Speculative spend (budget units, default 1 per execution) incl. wasted. */
  speculativeSpend: number;
  /** Spend on wasted executions. */
  wastedSpend: number;
  /** Predictor cost (e.g. USD of LLM predictor calls). */
  predictorCost: number;
  predictorErrors: number;
  predictorLatencyMs: number;
  /** Cache invalidations triggered by non-read-only real calls. */
  invalidations: number;
  /** Real calls to speculable tools whose arguments could not be keyed (non-JSON args): executed directly. */
  bypassed: number;
  /** Errors swallowed from user hooks/predictors (onEvent, observe, normalizeArgs, costOf, ...). Should be 0. */
  internalErrors: number;
}

/** A metrics object with every counter at zero. */
export function emptyMetrics(): SpeculationMetrics {
  return {
    realCalls: 0,
    eligibleCalls: 0,
    hits: 0,
    joins: 0,
    staleRejected: 0,
    specFailedFallbacks: 0,
    rounds: 0,
    skippedUnsafe: 0,
    skippedBudget: 0,
    launched: 0,
    wasted: 0,
    aborted: 0,
    timeouts: 0,
    latencySavedMs: 0,
    wastedToolMs: 0,
    speculativeSpend: 0,
    wastedSpend: 0,
    predictorCost: 0,
    predictorErrors: 0,
    predictorLatencyMs: 0,
    invalidations: 0,
    bypassed: 0,
    internalErrors: 0,
  };
}

/** Fraction of all real calls served from speculation (hits + joins). */
export function hitRate(m: SpeculationMetrics): number {
  return m.realCalls ? (m.hits + m.joins) / m.realCalls : 0;
}
/** Fraction of calls to speculable tools served from speculation. */
export function eligibleHitRate(m: SpeculationMetrics): number {
  return m.eligibleCalls ? (m.hits + m.joins) / m.eligibleCalls : 0;
}
/** Fraction of speculative executions that were used. */
export function precision(m: SpeculationMetrics): number {
  return m.launched ? (m.hits + m.joins) / m.launched : 0;
}

/** Element-wise sum of two metrics objects. */
export function mergeMetrics(a: SpeculationMetrics, b: SpeculationMetrics): SpeculationMetrics {
  const out = emptyMetrics();
  for (const k of Object.keys(out) as (keyof SpeculationMetrics)[]) out[k] = a[k] + b[k];
  return out;
}
