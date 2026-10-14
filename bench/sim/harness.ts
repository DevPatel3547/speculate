import { classifyTool } from "../../src/classifier.js";
import { VirtualClock } from "../../src/clock.js";
import { emptyMetrics, mergeMetrics, type SpeculationMetrics } from "../../src/metrics.js";
import { NGramPredictor } from "../../src/predictors/ngram.js";
import type { PredictionContext, Predictor, PredictorResult } from "../../src/predictors/types.js";
import { Speculator } from "../../src/speculator.js";
import type { Clock, Safety, ToolCall, Trace } from "../../src/types.js";
import { customValidator } from "../../src/validators/index.js";
import { runCodingAgent, type AgentRun } from "./agent.js";
import { makeRepo, type Repo } from "./repo.js";
import { Rng } from "./rng.js";
import { makeTools, type LatencyProfile } from "./tools.js";

/**
 * SIMULATED LLM predictor. It does not call a model: it peeks at the agent's
 * actual next calls and reveals each one with probability `accuracy`, plus one
 * plausible decoy. It exists to answer "how much would a predictor with X%
 * recall buy us?", NOT to claim any real model achieves X%.
 */
export class SimulatedLLMPredictor implements Predictor {
  readonly name = "sim-llm";
  constructor(
    private o: {
      accuracy: number;
      clock: Clock;
      repo: () => Repo;
      latencyMedianMs?: number;
      /** USD per call. Default: 2.5k input + 100 output tokens at $0.10/$0.50 per MTok. */
      costPerCall?: number;
    },
  ) {}
  async predict(ctx: PredictionContext, k: number): Promise<PredictorResult> {
    const next = (ctx.meta?.nextCalls as ToolCall[] | undefined) ?? [];
    const rng = new Rng(`simllm|${String(ctx.meta?.taskId)}|${String(ctx.meta?.turn)}`);
    await this.o.clock.sleep(rng.lognormal(this.o.latencyMedianMs ?? 600, 0.3), ctx.signal);
    const predictions = next
      .filter(() => rng.chance(this.o.accuracy))
      .map((call, i) => ({ call, score: 0.8 - 0.1 * i, source: this.name }));
    if (this.o.accuracy < 1) {
      predictions.push({ call: { name: "read_file", args: { path: rng.pick(this.o.repo().vfs.paths()) } }, score: 0.3, source: this.name });
    }
    return { predictions: predictions.slice(0, k), cost: this.o.costPerCall ?? (2500 * 0.1 + 100 * 0.5) / 1e6 };
  }
}

export interface Variant {
  name: string;
  /** undefined => baseline (no speculation) */
  predictor?: "ngram" | "sim-llm" | "ngram+sim-llm";
  allow?: Safety[];
  llmAccuracy?: number;
  llmLatencyMs?: number;
  llmCostPerCall?: number;
  topK?: number;
  maxConcurrency?: number;
}

export interface VariantResult {
  variant: Variant;
  runs: AgentRun[];
  metrics: SpeculationMetrics;
}

export const TOOL_OVERRIDES: Record<string, Safety> = { run_tests: "idempotent" };

export function taskIds(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
}

/** Run baseline agents on training tasks and return their traces (for the n-gram predictor). */
export async function collectTraces(ids: string[], profile: LatencyProfile): Promise<Trace[]> {
  const traces: Trace[] = [];
  for (const id of ids) {
    const clock = new VirtualClock();
    const repo = makeRepo(id);
    const tools = makeTools(repo, clock, profile, id);
    const run = await clock.run(() => runCodingAgent({ taskId: id, repo, tools, clock }));
    traces.push({ id, steps: run.steps });
  }
  return traces;
}

export interface RunOptions {
  profile: LatencyProfile;
  /** Factory for a clock per task. Default VirtualClock (deterministic). */
  clockFactory?: () => Clock;
  /** Run a function on that clock (VirtualClock.run, or just call it for real clocks). */
  runOn?: <T>(clock: Clock, fn: () => Promise<T>) => Promise<T>;
}

const defaultRunOn = <T>(clock: Clock, fn: () => Promise<T>) => (clock instanceof VirtualClock ? clock.run(fn) : fn());

export async function runVariant(v: Variant, ids: string[], trainTraces: Trace[], o: RunOptions): Promise<VariantResult> {
  const runs: AgentRun[] = [];
  let metrics = emptyMetrics();
  // one n-gram model per variant, pre-trained, then learning online across eval tasks
  const ngram = new NGramPredictor().train(trainTraces);
  for (const id of ids) {
    const clock = o.clockFactory?.() ?? new VirtualClock();
    const repo = makeRepo(id);
    const tools = makeTools(repo, clock, o.profile, id);
    let speculator: Speculator | undefined;
    if (v.predictor) {
      const sim = new SimulatedLLMPredictor({
        accuracy: v.llmAccuracy ?? 0.6,
        latencyMedianMs: v.llmLatencyMs,
        costPerCall: v.llmCostPerCall,
        clock,
        repo: () => repo,
      });
      // two stages: the n-gram launches instantly, the (slower) LLM stage launches when it answers
      const predictor: Predictor | Predictor[] = v.predictor === "ngram" ? ngram : v.predictor === "sim-llm" ? sim : [ngram, sim];
      speculator = new Speculator({
        tools,
        predictor,
        clock,
        allow: v.allow ?? ["read_only"],
        classifier: { overrides: TOOL_OVERRIDES },
        topK: v.topK ?? 3,
        maxConcurrency: v.maxConcurrency ?? 4,
        timeoutMs: 60_000,
        // fingerprint = VFS version of the file (or the whole tree for dir-wide tools)
        validators: [
          customValidator((c) => (c.name === "read_file" ? `f${repo.vfs.fileVersion(String(c.args.path))}` : `g${repo.vfs.version}`)),
        ],
      });
    }
    const run = await (o.runOn ?? defaultRunOn)(clock, () => runCodingAgent({ taskId: id, repo, tools, clock, speculator }));
    if (speculator) {
      speculator.close();
      metrics = mergeMetrics(metrics, speculator.metrics());
    }
    runs.push(run);
  }
  return { variant: v, runs, metrics };
}

export function describeSafety(): string {
  const tools = makeTools(makeRepo("x"), new VirtualClock(), { name: "n", description: "", tools: {} }, "x");
  return Object.values(tools)
    .map((t) => {
      const base = classifyTool(t.spec);
      const eff = classifyTool(t.spec, { overrides: TOOL_OVERRIDES });
      return `${t.spec.name}: ${base.safety}${eff.safety !== base.safety ? ` -> override ${eff.safety}` : ""}`;
    })
    .join(", ");
}
