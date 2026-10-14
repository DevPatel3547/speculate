import { createHash } from "node:crypto";
import { canonicalCallString } from "../canonical.js";
import { classifyTool, type Classification, type ClassifierOptions } from "../classifier.js";
import { NGramPredictor, type NGramOptions } from "../predictors/ngram.js";
import type { Safety, Step, ToolSpec } from "../types.js";
import type { TraceStep, Trajectory } from "./trace-format.js";

/** Timing assumptions for the latency estimate. Measured values in the trace always win. */
export interface TimingAssumptions {
  /** Think time used when a step has no `think_ms`. Default 2000. */
  defaultThinkMs?: number;
  /** Tool time used when a step has no `tool_ms` (and none was measured for that tool in training). Default 300. */
  defaultToolMs?: number;
  /** Predictor latency subtracted from each speculation window. Default 0 (n-gram is sub-millisecond). */
  predictorMs?: number;
}

/** Options for {@link evaluateTraces}. */
export interface EvaluateOptions {
  /** Fraction of trajectories held out for testing (split by trajectory id hash). Default 0.3. */
  testFraction?: number;
  /** Split seed. Same seed + same ids = same split. Default "speculate". */
  seed?: string;
  /** Speculative executions launched per step (as `topK` in the Speculator). Default 3. */
  topK?: number;
  /** Keep learning on test trajectories as they are replayed (what a live proxy does). Default true. */
  online?: boolean;
  /** Safety classes counted as speculable. Default ["read_only"]. */
  allow?: Safety[];
  /** Count open-world tools as speculable. Default false. */
  allowOpenWorld?: boolean;
  /** Classifier options (overrides etc.). Tools are classified from their names unless `toolSpecs` is given. */
  classifier?: ClassifierOptions;
  /** Full tool specs (description, annotations, schema) for better classification. */
  toolSpecs?: Record<string, ToolSpec>;
  /** n-gram configuration. */
  ngram?: NGramOptions;
  /** Timing assumptions. */
  timing?: TimingAssumptions;
  /**
   * Use each step's own `cls` (if present) to decide whether THAT call was safe to speculate.
   * Default true. Predictions are always gated per tool name (as the live Speculator does).
   */
  useStepClass?: boolean;
  /** Default class per tool name (e.g. from a `tool_classes.json`). Beats the training-majority class and heuristics. */
  toolClasses?: Record<string, Safety>;
  /**
   * Tools that are never scored or launched (still part of the history), e.g. no-op
   * "think" tools whose speculation would save nothing.
   */
  excludeTools?: string[];
  /**
   * Only trajectories whose id starts with one of these prefixes can be test trajectories;
   * all others are always used for training. Default: any trajectory can be held out.
   */
  testPrefixes?: string[];
}

/** Hit-rate counters at one cutoff. */
export interface HitStats {
  hits: number;
  rate: number;
}

/** Per-tool breakdown row. */
export interface ToolReport {
  tool: string;
  /** Tool-level class (what a name-based classifier would use). */
  safety: Safety;
  openWorld: boolean;
  /** Predictions of this tool can be launched. */
  speculable: boolean;
  testSteps: number;
  /** Test steps of this tool whose own class is speculable (denominator of top1/top3). */
  speculableSteps: number;
  top1: number;
  top3: number;
}

/** Per-source breakdown row (trajectory `source`, or the id prefix before the first "-"). */
export interface SourceReport {
  source: string;
  testTrajectories: number;
  testSteps: number;
  speculableSteps: number;
  top1: number;
  top3: number;
  baselineMs: number;
  savedMs: number;
  /** Share of this source's test steps with measured think_ms. */
  measuredThinkShare: number;
}

/** Output of {@link evaluateTraces}. Rates are fractions in [0, 1]. */
export interface EvalReport {
  trajectories: { total: number; train: number; test: number };
  steps: { train: number; test: number };
  /** Test steps whose tool is speculable under the policy (the denominator of the hit rates). */
  speculableSteps: number;
  /** speculableSteps / test steps. */
  speculableShare: number;
  /** Top-1 / top-3 exact-call hit rate over speculable test steps (predictions filtered to speculable tools). */
  top1: HitStats;
  top3: HitStats;
  /** Hit rate at the configured `topK` (what would actually be launched). */
  topK: HitStats & { k: number };
  /** Top-1 accuracy of the tool *name* only, over speculable test steps. */
  toolNameTop1: HitStats;
  /**
   * Exact-match predictions (top-k) of calls whose own class was NOT speculable although the
   * tool's name-level class was (e.g. `grep ... > out.txt`). A name-only classifier would have
   * launched these; they are excluded from hits and counted here as a safety signal.
   */
  unsafeMatches: number;
  perTool: ToolReport[];
  perSource: SourceReport[];
  latency: {
    /** Sum over test steps of think + tool time, ms. */
    baselineMs: number;
    /** Estimated agent-visible time removed, ms. */
    savedMs: number;
    savedFraction: number;
    /** Savings of a perfect predictor (every speculable step hit): the ceiling for this policy and timing. */
    ceilingMs: number;
    ceilingFraction: number;
    /** Hits whose speculation finished inside the think window. */
    fullHits: number;
    /** Hits still running when the call arrived (joined). */
    partialHits: number;
    /** Speculative executions that would have been thrown away. */
    wastedExecutions: number;
    /** Estimated tool time spent on them, ms. */
    wastedToolMs: number;
    /** Share of test steps with measured think_ms / tool_ms (the rest use assumptions). */
    measuredThinkShare: number;
    measuredToolShare: number;
    assumptions: Required<TimingAssumptions>;
  };
  options: {
    testFraction: number;
    seed: string;
    topK: number;
    online: boolean;
    allow: Safety[];
    allowOpenWorld: boolean;
    useStepClass: boolean;
    testPrefixes?: string[];
    excludeTools?: string[];
  };
}

function splitScore(seed: string, id: string): number {
  const h = createHash("sha256").update(`${seed}\u0000${id}`).digest();
  return h.readUInt32BE(0) / 2 ** 32;
}

const sourceOf = (t: Trajectory) => t.source ?? (t.id.includes("-") ? t.id.slice(0, t.id.indexOf("-")) : "(none)");

function toStep(s: TraceStep): Step {
  const step: Step = { call: { name: s.tool, args: s.args } };
  if (s.result !== undefined) step.result = s.result;
  if (s.error) step.error = typeof s.error === "string" ? s.error : "error";
  return step;
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Replay real trajectories offline and measure how well the n-gram predictor would have
 * done: train on a split of trajectories, replay the rest step by step, and for each step
 * whose tool is speculable check whether the actual call was among the top-k speculable
 * predictions made from the steps before it.
 *
 * The latency estimate models the MCP-proxy setting: speculation for step *i* starts when
 * step *i-1* returns, so the window is step *i*'s `think_ms`. A hit saves
 * `min(tool_ms, think_ms - predictorMs)`. It ignores concurrency limits, budgets and
 * validator rejections, so treat it as an upper-bound estimate, not a measurement.
 */
export function evaluateTraces(all: readonly Trajectory[], opts: EvaluateOptions = {}): EvalReport {
  const testFraction = opts.testFraction ?? 0.3;
  if (!(testFraction > 0 && testFraction < 1)) throw new RangeError("testFraction must be in (0, 1)");
  const seed = opts.seed ?? "speculate";
  const topK = opts.topK ?? 3;
  if (!(Number.isInteger(topK) && topK >= 1)) throw new RangeError("topK must be an integer >= 1");
  const online = opts.online ?? true;
  const useStepClass = opts.useStepClass ?? true;
  const testPrefixes = opts.testPrefixes?.length ? opts.testPrefixes : undefined;
  const allow = opts.allow ?? ["read_only"];
  const allowOpenWorld = opts.allowOpenWorld ?? false;
  const assumptions: Required<TimingAssumptions> = {
    defaultThinkMs: opts.timing?.defaultThinkMs ?? 2000,
    defaultToolMs: opts.timing?.defaultToolMs ?? 300,
    predictorMs: opts.timing?.predictorMs ?? 0,
  };

  // ---- split by trajectory (hash of id: stable when more trajectories are added)
  const eligible = (t: Trajectory) => !testPrefixes || testPrefixes.some((p) => t.id.startsWith(p));
  const alwaysTrain = all.filter((t) => !eligible(t));
  const scored = all.filter(eligible).map((t) => ({ t, u: splitScore(seed, t.id) }));
  let train = scored.filter((x) => x.u >= testFraction).map((x) => x.t);
  let test = scored.filter((x) => x.u < testFraction).map((x) => x.t);
  if (scored.length + alwaysTrain.length >= 2 && test.length === 0 && scored.length) {
    // tiny inputs: force at least one test trajectory (lowest split score)
    const order = [...scored].sort((a, b) => a.u - b.u).map((x) => x.t);
    const nTest = Math.min(order.length - (alwaysTrain.length ? 0 : 1), Math.max(1, Math.round(order.length * testFraction)));
    test = order.slice(0, nTest);
    train = order.slice(nTest);
  }
  if (train.length + alwaysTrain.length === 0 && test.length >= 2) train = test.splice(test.length - 1, 1);
  train = [...alwaysTrain, ...train];

  // ---- classification
  // tool level: override > toolClasses > majority of training step classes > name heuristics
  const overrides = opts.classifier?.overrides ?? {};
  const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  const majority = new Map<string, Map<Safety, number>>();
  for (const t of train) {
    for (const s of t.steps) {
      if (!s.cls) continue;
      const m = majority.get(s.tool) ?? new Map<Safety, number>();
      m.set(s.cls, (m.get(s.cls) ?? 0) + 1);
      majority.set(s.tool, m);
    }
  }
  const classCache = new Map<string, Classification>();
  const classify = (name: string): Classification => {
    let c = classCache.get(name);
    if (c) return c;
    c = classifyTool(opts.toolSpecs?.[name] ?? { name }, opts.classifier);
    if (own(overrides, name)) c = { ...c, safety: overrides[name], reason: "override" };
    else if (opts.toolClasses && own(opts.toolClasses, name)) c = { ...c, safety: opts.toolClasses[name], reason: "toolClasses" };
    else if (useStepClass && majority.has(name)) {
      // ties resolve to the more conservative class
      const order: Safety[] = ["side_effecting", "idempotent", "read_only"];
      const m = majority.get(name)!;
      const best = order.reduce((a, b) => ((m.get(b) ?? 0) > (m.get(a) ?? 0) ? b : a));
      c = { ...c, safety: best, reason: "training majority of step classes" };
    }
    classCache.set(name, c);
    return c;
  };
  const allowed = (safety: Safety, name: string) =>
    allow.includes(safety) && safety !== "side_effecting" && (!classify(name).openWorld || allowOpenWorld);
  const excluded = new Set(opts.excludeTools ?? []);
  const speculable = (name: string) => !excluded.has(name) && allowed(classify(name).safety, name);
  const stepSpeculable = (s: TraceStep) => {
    if (excluded.has(s.tool)) return false;
    if (own(overrides, s.tool)) return allowed(overrides[s.tool], s.tool);
    return allowed(useStepClass && s.cls ? s.cls : classify(s.tool).safety, s.tool);
  };

  // ---- train
  const ngram = new NGramPredictor(opts.ngram);
  ngram.train(train.map((t) => ({ id: t.id, steps: t.steps.map(toStep) })));
  const toolMsByName = new Map<string, number[]>();
  for (const t of train) {
    for (const s of t.steps) {
      if (s.tool_ms === undefined) continue;
      const xs = toolMsByName.get(s.tool) ?? [];
      xs.push(s.tool_ms);
      toolMsByName.set(s.tool, xs);
    }
  }
  const toolEstimate = new Map<string, number>();
  for (const [k, v] of toolMsByName) toolEstimate.set(k, median(v)!);
  const estToolMs = (name: string) => toolEstimate.get(name) ?? assumptions.defaultToolMs;

  // ---- replay test trajectories
  const per = new Map<string, ToolReport>();
  const perSrc = new Map<string, SourceReport & { measured: number }>();
  let unsafeMatches = 0;
  let testSteps = 0;
  let specSteps = 0;
  let h1 = 0;
  let h3 = 0;
  let hk = 0;
  let nameHits = 0;
  let baselineMs = 0;
  let savedMs = 0;
  let ceilingMs = 0;
  let fullHits = 0;
  let partialHits = 0;
  let wasted = 0;
  let wastedToolMs = 0;
  let measuredThink = 0;
  let measuredTool = 0;
  const maxK = Math.max(3, topK);

  for (const t of test) {
    const hist: Step[] = [];
    const srcName = sourceOf(t);
    const src =
      perSrc.get(srcName) ??
      perSrc
        .set(srcName, {
          source: srcName,
          testTrajectories: 0,
          testSteps: 0,
          speculableSteps: 0,
          top1: 0,
          top3: 0,
          baselineMs: 0,
          savedMs: 0,
          measuredThinkShare: 0,
          measured: 0,
        })
        .get(srcName)!;
    src.testTrajectories++;
    for (const s of t.steps) {
      testSteps++;
      src.testSteps++;
      const think = s.think_ms ?? assumptions.defaultThinkMs;
      const toolMs = s.tool_ms ?? estToolMs(s.tool);
      if (s.think_ms !== undefined) {
        measuredThink++;
        src.measured++;
      }
      if (s.tool_ms !== undefined) measuredTool++;
      baselineMs += think + toolMs;
      src.baselineMs += think + toolMs;

      const c = classify(s.tool);
      const row =
        per.get(s.tool) ??
        per
          .set(s.tool, {
            tool: s.tool,
            safety: c.safety,
            openWorld: c.openWorld,
            speculable: speculable(s.tool),
            testSteps: 0,
            speculableSteps: 0,
            top1: 0,
            top3: 0,
          })
          .get(s.tool)!;
      row.testSteps++;

      // what the Speculator would launch: it over-fetches k*2 predictions, drops
      // non-speculable tools, and launches the top k
      const preds = ngram
        .predictSync(hist, maxK * 2)
        .filter((p) => speculable(p.call.name))
        .slice(0, maxK);
      const launched = preds.slice(0, topK);
      const actualKey = canonicalCallString({ name: s.tool, args: s.args });
      const rank = actualKey === undefined ? -1 : preds.findIndex((p) => canonicalCallString(p.call) === actualKey);
      const window = Math.max(0, think - assumptions.predictorMs);

      if (stepSpeculable(s)) {
        specSteps++;
        ceilingMs += Math.min(toolMs, window);
        row.speculableSteps++;
        src.speculableSteps++;
        if (rank === 0) {
          h1++;
          row.top1++;
          src.top1++;
        }
        if (rank >= 0 && rank < 3) {
          h3++;
          row.top3++;
          src.top3++;
        }
        if (preds[0]?.call.name === s.tool) nameHits++;
        if (rank >= 0 && rank < topK) {
          hk++;
          const saved = Math.min(toolMs, window);
          savedMs += saved;
          src.savedMs += saved;
          if (window >= toolMs) fullHits++;
          else partialHits++;
        }
      } else if (rank >= 0 && rank < topK) {
        unsafeMatches++;
      }
      // every launched prediction that is not the actual call is wasted work
      launched.forEach((p, i) => {
        if (i === rank) return;
        wasted++;
        wastedToolMs += Math.min(estToolMs(p.call.name), window + toolMs);
      });

      hist.push(toStep(s));
      if (online) ngram.observe(hist);
    }
  }

  const rate = (n: number) => (specSteps ? n / specSteps : 0);
  return {
    trajectories: { total: all.length, train: train.length, test: test.length },
    steps: { train: train.reduce((a, t) => a + t.steps.length, 0), test: testSteps },
    speculableSteps: specSteps,
    speculableShare: testSteps ? specSteps / testSteps : 0,
    top1: { hits: h1, rate: rate(h1) },
    top3: { hits: h3, rate: rate(h3) },
    topK: { k: topK, hits: hk, rate: rate(hk) },
    toolNameTop1: { hits: nameHits, rate: rate(nameHits) },
    unsafeMatches,
    perTool: [...per.values()].sort((a, b) => b.testSteps - a.testSteps || (a.tool < b.tool ? -1 : 1)),
    perSource: [...perSrc.values()]
      .map(({ measured, ...r }) => ({ ...r, measuredThinkShare: r.testSteps ? measured / r.testSteps : 0 }))
      .sort((a, b) => b.testSteps - a.testSteps),
    latency: {
      baselineMs,
      savedMs,
      savedFraction: baselineMs ? savedMs / baselineMs : 0,
      ceilingMs,
      ceilingFraction: baselineMs ? ceilingMs / baselineMs : 0,
      fullHits,
      partialHits,
      wastedExecutions: wasted,
      wastedToolMs,
      measuredThinkShare: testSteps ? measuredThink / testSteps : 0,
      measuredToolShare: testSteps ? measuredTool / testSteps : 0,
      assumptions,
    },
    options: {
      testFraction,
      seed,
      topK,
      online,
      allow: [...allow],
      allowOpenWorld,
      useStepClass,
      ...(testPrefixes ? { testPrefixes } : {}),
      ...(excluded.size ? { excludeTools: [...excluded] } : {}),
    },
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Human-readable report (plain text, fits in a terminal). */
export function formatEvalReport(r: EvalReport): string {
  const L: string[] = [];
  L.push("speculate-tools trace replay — n-gram predictor");
  L.push(
    `trajectories: ${r.trajectories.total} (train ${r.trajectories.train}, test ${r.trajectories.test}; split by id hash, seed "${r.options.seed}", test fraction ${r.options.testFraction})`,
  );
  L.push(`steps: train ${r.steps.train}, test ${r.steps.test}; speculable test steps ${r.speculableSteps} (${pct(r.speculableShare)})`);
  L.push(
    `policy: allow ${r.options.allow.join("+")}${r.options.allowOpenWorld ? " + open-world" : ""}; ` +
      `classes: ${r.options.useStepClass ? "per-step cls when present" : "per tool name"}; online learning ${r.options.online ? "on" : "off"}` +
      (r.options.testPrefixes ? `; test set drawn only from ids ${r.options.testPrefixes.join(", ")}` : "") +
      (r.options.excludeTools ? `; not scored: ${r.options.excludeTools.join(", ")}` : ""),
  );
  L.push("");
  L.push("hit rate over speculable test steps (exact tool + args match):");
  L.push(`  top-1          ${pct(r.top1.rate).padStart(6)}  (${r.top1.hits}/${r.speculableSteps})`);
  L.push(`  top-3          ${pct(r.top3.rate).padStart(6)}  (${r.top3.hits}/${r.speculableSteps})`);
  if (r.topK.k !== 1 && r.topK.k !== 3)
    L.push(`  top-${r.topK.k} (launch) ${pct(r.topK.rate).padStart(6)}  (${r.topK.hits}/${r.speculableSteps})`);
  L.push(`  tool name only ${pct(r.toolNameTop1.rate).padStart(6)}  (top-1)`);
  L.push("");
  if (r.unsafeMatches) {
    L.push(
      `  unsafe matches  ${r.unsafeMatches} (predicted calls a name-only classifier would launch, but whose own class is not speculable)`,
    );
  }
  if (r.perSource.length > 1) {
    L.push("");
    L.push("per source (test trajectories):");
    const ws = Math.max(6, ...r.perSource.map((x) => x.source.length));
    L.push(`  ${"source".padEnd(ws)}  trajs  spec.steps   top-1   top-3  est.saved`);
    for (const x of r.perSource) {
      const rr = (n: number) => pct(x.speculableSteps ? n / x.speculableSteps : 0).padStart(6);
      const saved = x.baselineMs ? pct(x.savedMs / x.baselineMs) : "-";
      L.push(
        `  ${x.source.padEnd(ws)}  ${String(x.testTrajectories).padStart(5)}  ${String(x.speculableSteps).padStart(10)}  ${rr(x.top1)}  ${rr(x.top3)}  ${saved.padStart(9)}`,
      );
    }
  }
  L.push("");
  const MAX_ROWS = 25;
  L.push(`per tool (test steps${r.perTool.length > MAX_ROWS ? `, top ${MAX_ROWS} of ${r.perTool.length} tools; --json for all` : ""}):`);
  const shown = r.perTool.slice(0, MAX_ROWS);
  const w = Math.max(4, ...shown.map((t) => t.tool.length));
  L.push(`  ${"tool".padEnd(w)}  ${"class".padEnd(15)}  steps  spec.   top-1   top-3`);
  for (const t of shown) {
    const cls = `${t.safety}${t.openWorld ? "*" : ""}`;
    const rates = t.speculableSteps
      ? `${pct(t.top1 / t.speculableSteps).padStart(6)}  ${pct(t.top3 / t.speculableSteps).padStart(6)}`
      : "     -       -  (not speculated)";
    L.push(
      `  ${t.tool.padEnd(w)}  ${cls.padEnd(15)}  ${String(t.testSteps).padStart(5)}  ${String(t.speculableSteps).padStart(5)}  ${rates}`,
    );
  }
  if (shown.some((t) => t.openWorld)) L.push("  (* = open-world: not speculated unless --allow-open-world)");
  L.push("");
  const lat = r.latency;
  const a = lat.assumptions;
  L.push(`ESTIMATED latency saved (top-${r.options.topK} launched per step; upper bound, see docs/trace-format.md):`);
  L.push(`  baseline ${(lat.baselineMs / 1000).toFixed(1)} s -> saved ${(lat.savedMs / 1000).toFixed(1)} s (${pct(lat.savedFraction)})`);
  L.push(`  ceiling (perfect predictor, same policy): ${(lat.ceilingMs / 1000).toFixed(1)} s (${pct(lat.ceilingFraction)})`);
  L.push(`  hits: ${lat.fullHits} finished within the think window, ${lat.partialHits} joined while running`);
  L.push(`  wasted speculative executions: ${lat.wastedExecutions} (~${(lat.wastedToolMs / 1000).toFixed(1)} s of tool time)`);
  L.push(
    `  timing: think_ms measured on ${pct(lat.measuredThinkShare)} of steps, tool_ms on ${pct(lat.measuredToolShare)}; ` +
      `assumed think ${a.defaultThinkMs} ms, tool ${a.defaultToolMs} ms (or train median per tool), predictor ${a.predictorMs} ms`,
  );
  return L.join("\n");
}
