import { tryCallKey, type ArgNormalizer } from "./canonical.js";
import { abortError, isAbortError, realClock } from "./clock.js";
import { ToolClassifier, type Classification, type ClassifierOptions } from "./classifier.js";
import { raceAbort, Semaphore, withTimeout } from "./executor.js";
import { approxBytes } from "./internal/size.js";
import { emptyMetrics, type SpeculationMetrics } from "./metrics.js";
import type { Logger, TelemetrySink } from "./observability.js";
import type { Prediction, Predictor } from "./predictors/types.js";
import type { Clock, Safety, Step, ToolCall, ToolDefinition, ToolRegistry, ToolSpec } from "./types.js";
import type { StalenessValidator } from "./validators/index.js";

/** Limits on speculative spend (in arbitrary units; default 1 unit per speculative execution). */
export interface BudgetOptions {
  /** Max total speculative spend over the speculator's lifetime (see `resetBudget`). Default `Infinity`. */
  maxTotal?: number;
  /** Max speculative spend per prediction round. Default `Infinity`. */
  maxPerRound?: number;
  /** Spend units for one speculative execution. Default: 1 per call. */
  costOf?: (call: ToolCall) => number;
}

/** Context handed to predictors at the start of a round. */
export interface RoundContext {
  /** Raw conversation (e.g. Anthropic `messages`) for model-based predictors. */
  messages?: readonly unknown[];
  /** Free-form data an integration wants to pass to its predictor. */
  meta?: Record<string, unknown>;
}

/** Options for a per-call invocation of {@link Speculator.call}. */
export interface CallOptions {
  /** Cancels the call. Forwarded to the real tool handler; also stops waiting on a joined speculation. */
  signal?: AbortSignal;
}

/**
 * Configuration of a {@link Speculator}. Every option except `tools` and `predictor`
 * has a conservative default.
 */
export interface SpeculatorOptions {
  /** The real tools. Calls go through {@link Speculator.call}. */
  tools: ToolRegistry;
  /**
   * One predictor, or several run as independent *stages*: each launches its predictions
   * as soon as it answers, so a fast n-gram stage is never held back by a slow LLM stage.
   * (Use `EnsemblePredictor` instead to fuse scores.)
   */
  predictor: Predictor | readonly Predictor[];
  /**
   * Identifies the session (conversation / user) this speculator serves. Passed to tool
   * handlers as `ctx.sessionId` and included in logs. One Speculator must never be shared
   * between users: use {@link SpeculatorPool} to get one isolated Speculator per session.
   */
  sessionId?: string;
  /** How tools are classified as read_only / idempotent / side_effecting. */
  classifier?: ClassifierOptions;
  /** Safety classes that may be speculated. Default `["read_only"]`. `side_effecting` is always refused. */
  allow?: Safety[];
  /**
   * Allow speculating open-world tools (network egress: fetch/browse/http/...). `true` = all,
   * or a list of tool names. Default `false`, because a predictor steered by prompt injection
   * could otherwise make the agent's tools contact attacker-chosen endpoints.
   */
  allowOpenWorld?: boolean | readonly string[];
  /** Max speculative executions launched per predictor stage per round. Default 3. `0` disables speculation. */
  topK?: number;
  /** Predictions scoring below this are not launched. Default 0.05. */
  minScore?: number;
  /** Max concurrent speculative executions (real calls never wait on this). Default 4. */
  maxConcurrency?: number;
  /** Shared concurrency limiter (e.g. one per process across sessions). Overrides `maxConcurrency`. */
  limiter?: Semaphore;
  /** Speculative executions are aborted after this many ms. Default 30 000. */
  timeoutMs?: number;
  /** A completed speculative result older than this is treated as stale. Default 60 000. */
  maxAgeMs?: number;
  /** Max speculative entries (completed or in flight) kept. Oldest are evicted first. Default 64. */
  maxCacheEntries?: number;
  /** Approximate memory cap for completed speculative results, in bytes. Default 64 MiB. */
  maxCacheBytes?: number;
  /** Max real steps kept in `history` (prediction context). Default 200. */
  maxHistory?: number;
  /** Validators taking longer than this count as "stale" (the call re-executes). Default 2 000. */
  validatorTimeoutMs?: number;
  /** Spend limits. */
  budget?: BudgetOptions;
  /** Validators fingerprinting external state (e.g. `fsValidator()`). */
  validators?: StalenessValidator[];
  /** Opt-in arg normalization for cache keys; global or per tool name. Must be output-preserving. */
  normalizeArgs?: ArgNormalizer | Record<string, ArgNormalizer>;
  /** Return false to refuse caching a speculative result (e.g. MCP `isError`). */
  acceptResult?: (call: ToolCall, result: unknown) => boolean;
  /** Abort still-running speculations from earlier rounds when a new round starts. Default `true`. */
  cancelOnNewRound?: boolean;
  /** Time source. Default: real time. */
  clock?: Clock;
  /**
   * Receives every speculation event. Events include tool arguments (in-process only);
   * a throwing listener is ignored.
   */
  onEvent?: (e: SpeculationEvent) => void;
  /** Structured logger (e.g. `console`). Arguments are not logged unless `logArgs` is set. Default: silent. */
  logger?: Logger;
  /** Include tool arguments in log fields. Default `false` (args may contain secrets). */
  logArgs?: boolean;
  /** Metrics sink (see `otelTelemetry`). */
  telemetry?: TelemetrySink;
}

/** Why a prediction was not launched. */
export type SkipReason = "unsafe" | "open_world" | "budget" | "unknown_tool" | "low_score" | "duplicate" | "uncacheable";

/** Everything the engine reports through `onEvent` (and logs/telemetry). */
export type SpeculationEvent =
  | { type: "round"; round: number }
  | { type: "predicted"; round: number; source: string; predictions: Prediction[]; latencyMs: number }
  | { type: "predictor_error"; round: number; source: string; error: string }
  | { type: "launch"; call: ToolCall; key: string; score: number; source: string }
  | { type: "skip"; call: ToolCall; reason: SkipReason }
  | { type: "hit" | "join"; call: ToolCall; key: string; savedMs: number }
  | { type: "miss"; call: ToolCall; key: string }
  | { type: "bypass"; call: ToolCall; reason: string }
  | { type: "stale" | "spec_failed"; call: ToolCall; key: string; detail: string }
  | { type: "wasted"; call: ToolCall; key: string; reason: string }
  | { type: "invalidate"; cause: string }
  | { type: "internal_error"; where: string; error: string };

type EntryState = "queued" | "running" | "done" | "error" | "aborted";

interface Entry {
  key: string;
  call: ToolCall;
  safety: Safety;
  round: number;
  epoch: number;
  cost: number;
  ac: AbortController;
  state: EntryState;
  launchedAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: unknown;
  error?: unknown;
  fingerprint?: string;
  bytes: number;
  /** bytes are included in `cacheBytes` */
  counted: boolean;
  consumed: boolean;
  fate?: "used" | "wasted";
  /** the whole execution chain, including bookkeeping, has finished */
  settled: boolean;
  promise: Promise<void>;
}

const pending = (e: Entry) => e.state === "queued" || e.state === "running";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function checkNumber(name: string, v: unknown, min: number, opts: { int?: boolean; finite?: boolean; max?: number } = {}): void {
  if (v === undefined) return;
  const ok =
    typeof v === "number" &&
    !Number.isNaN(v) &&
    v >= min &&
    (!opts.int || Number.isInteger(v)) &&
    (!opts.finite || Number.isFinite(v)) &&
    (opts.max === undefined || v <= opts.max);
  if (!ok) {
    throw new RangeError(
      `speculate: option ${name} must be ${opts.int ? "an integer" : "a number"} >= ${min}${opts.max !== undefined ? ` and <= ${opts.max}` : ""}, got ${typeof v === "number" ? String(v) : typeof v}`,
    );
  }
}

/**
 * The speculation engine. One instance = one agent session.
 *
 * Lifecycle per agent turn:
 *   1. The model starts thinking            -> `beginRound(ctx)`  (fire-and-forget)
 *   2. The model emits tool calls           -> `call(c)` for each, in order
 *
 * Correctness invariants (see README "Safety guarantees"):
 *   - Only tools classified into `allow` (default read_only), and not open-world unless opted in,
 *     are ever executed speculatively.
 *   - Every non-read-only real call bumps the epoch before AND after it runs; a speculative result
 *     is only served if it was produced in the current epoch, so no speculative read can observe a
 *     state older than the agent's latest write.
 *   - Validators re-fingerprint external state at consume time; mismatch, error or timeout => re-execute.
 *   - Speculative failures/timeouts are never surfaced; the real call just runs normally.
 *   - Nothing a predictor, validator or hook does can make a real call fail or crash the process.
 */
export class Speculator {
  private hist: Step[] = [];
  private entries = new Map<string, Entry>();
  private toolMap: Map<string, ToolDefinition>;
  private predictors: readonly Predictor[];
  private classifier: ToolClassifier;
  private limiter: Semaphore;
  private clock: Clock;
  private epoch = 0;
  private round = 0;
  private roundOpen = false;
  private roundAbort?: AbortController;
  private spent = 0;
  private cacheBytes = 0;
  private isClosed = false;
  private activeRounds = new Set<Promise<void>>();
  private lastActivity: number;
  private m: SpeculationMetrics = emptyMetrics();
  private allow: Set<Safety>;

  constructor(private o: SpeculatorOptions) {
    if (!o || typeof o !== "object") throw new TypeError("speculate: options are required");
    if (!o.tools || typeof o.tools !== "object") throw new TypeError("speculate: options.tools must be a tool registry object");
    if (!o.predictor) throw new TypeError("speculate: options.predictor is required");
    checkNumber("topK", o.topK, 0, { int: true, finite: true });
    checkNumber("minScore", o.minScore, 0, { finite: true });
    checkNumber("maxConcurrency", o.maxConcurrency, 1, { int: true, finite: true });
    checkNumber("timeoutMs", o.timeoutMs, 1, { finite: true, max: 2_147_483_647 });
    checkNumber("maxAgeMs", o.maxAgeMs, 0);
    checkNumber("maxCacheEntries", o.maxCacheEntries, 1, { int: true, finite: true });
    checkNumber("maxCacheBytes", o.maxCacheBytes, 0);
    checkNumber("maxHistory", o.maxHistory, 1, { int: true, finite: true });
    checkNumber("validatorTimeoutMs", o.validatorTimeoutMs, 1, { finite: true, max: 2_147_483_647 });
    checkNumber("budget.maxTotal", o.budget?.maxTotal, 0);
    checkNumber("budget.maxPerRound", o.budget?.maxPerRound, 0);

    this.toolMap = new Map(Object.entries(o.tools)); // own properties only: no "constructor"/"__proto__" surprises
    const specs = new Map<string, ToolSpec>();
    for (const [name, t] of this.toolMap) {
      if (!t || typeof t.handler !== "function") throw new TypeError(`speculate: tool "${name}" has no handler function`);
      specs.set(name, { ...t.spec, name });
    }
    this.predictors = Array.isArray(o.predictor) ? [...(o.predictor as Predictor[])] : [o.predictor as Predictor];
    this.classifier = new ToolClassifier(specs, o.classifier);
    this.limiter = o.limiter ?? new Semaphore(o.maxConcurrency ?? 4);
    this.clock = o.clock ?? realClock;
    this.allow = new Set((o.allow ?? ["read_only"]).filter((s) => s === "read_only" || s === "idempotent"));
    this.lastActivity = this.clock.now();
  }

  // ---------------------------------------------------------------- public API

  /** The session id given in the options, if any. */
  get sessionId(): string | undefined {
    return this.o.sessionId;
  }

  /** Real steps observed so far (most recent `maxHistory`), oldest first. */
  get history(): readonly Step[] {
    return this.hist;
  }

  /** Clock time of the last `call`, `beginRound` or `observeExternal`. */
  get lastActivityAt(): number {
    return this.lastActivity;
  }

  /** True after {@link close}. Calls still work (executed directly), nothing is speculated. */
  get closed(): boolean {
    return this.isClosed;
  }

  /** Classification of a tool by name. */
  classify(name: string): Classification {
    return this.classifier.classify(name);
  }

  /** Whether a tool may be executed speculatively under the current policy. */
  isSpeculable(name: string): boolean {
    return this.speculability(name) === undefined;
  }

  /** Snapshot of the counters. */
  metrics(): SpeculationMetrics {
    return { ...this.m };
  }

  /** Reset the lifetime spend counter used by `budget.maxTotal`. */
  resetBudget(): void {
    this.spent = 0;
  }

  /**
   * Call when the model starts generating its next turn. Predicts the next calls and
   * launches the safe ones in the background. Never throws or rejects.
   * The returned promise resolves once launching is done (useful in tests); agent loops
   * should NOT await it.
   */
  beginRound(ctx: RoundContext = {}): Promise<void> {
    const p = this.runRound(ctx).catch((e: unknown) => this.internalError("beginRound", e));
    this.activeRounds.add(p);
    void p.then(() => this.activeRounds.delete(p));
    return p;
  }

  private async runRound(ctx: RoundContext): Promise<void> {
    if (this.isClosed) return;
    this.touch();
    const round = ++this.round;
    this.roundOpen = true;
    this.m.rounds++;
    this.roundAbort?.abort();
    const ac = new AbortController();
    this.roundAbort = ac;
    if (this.o.cancelOnNewRound ?? true) {
      for (const e of [...this.entries.values()]) if (pending(e) && e.round < round) this.discard(e, "superseded by new round");
    }
    this.evictExpired();
    this.emit({ type: "round", round });
    if ((this.o.topK ?? 3) === 0) return;
    const roundState = { spend: 0 };
    const history = this.hist.slice();
    await Promise.all(this.predictors.map((p) => this.runStage(p, round, ac, ctx, roundState, history)));
  }

  /**
   * Execute a real tool call, served from speculation when possible. Observable semantics are
   * identical to calling the tool's handler directly (same result or same error).
   */
  async call(rawCall: ToolCall, opts: CallOptions = {}): Promise<unknown> {
    this.touch();
    this.roundOpen = false;
    this.roundAbort?.abort();
    const name = rawCall?.name;
    const tool = typeof name === "string" ? this.toolMap.get(name) : undefined;
    if (!tool) throw new Error(`Unknown tool: ${String(name)}`);
    const args = rawCall.args ?? {};
    const call: ToolCall = { name, args };
    const cls = this.classify(name);
    const speculable = this.isSpeculable(name);
    this.m.realCalls++;
    if (speculable) this.m.eligibleCalls++;

    let outcome = speculable ? "miss" : "ineligible";
    let key: string | undefined;
    if (speculable && !this.isClosed) {
      key = this.keyOf(call);
      if (key === undefined) {
        this.m.bypassed++;
        outcome = "bypass";
        this.emit({ type: "bypass", call, reason: "arguments are not JSON-cacheable" });
      }
    }
    const entry = key !== undefined ? this.entries.get(key) : undefined;
    if (entry) {
      this.removeEntry(entry);
      let served: { ok: true; value: unknown } | { ok: false; outcome: string };
      try {
        served = await this.tryConsume(entry, opts.signal);
      } catch (err) {
        this.record({ call, error: errMsg(err) });
        throw err;
      }
      if (served.ok) {
        // the speculative execution *was* this call: a non-read-only effect has happened
        if (cls.safety !== "read_only") this.invalidate(`served ${name}`);
        this.record({ call, result: served.value });
        return served.value;
      }
      outcome = served.outcome;
    } else if (key !== undefined) {
      this.emit({ type: "miss", call, key });
    }
    this.count("speculate.calls", { tool: name, outcome });

    const mutating = cls.safety !== "read_only";
    if (mutating) this.invalidate(`real ${name}`);
    try {
      const result = await tool.handler(args, {
        signal: opts.signal ?? new AbortController().signal,
        speculative: false,
        ...(this.o.sessionId !== undefined ? { sessionId: this.o.sessionId } : {}),
      });
      this.record({ call, result });
      return result;
    } catch (e) {
      this.record({ call, error: errMsg(e) });
      throw e;
    } finally {
      if (mutating) this.invalidate(`real ${name} (after)`);
    }
  }

  /**
   * Record a step that executed outside this speculator (e.g. a Claude Agent SDK built-in
   * tool). Non-read-only steps invalidate all speculative state.
   */
  observeExternal(step: Step, safety?: Safety): void {
    this.touch();
    const s = safety ?? this.classify(step.call.name).safety;
    if (s !== "read_only") this.invalidate(`external ${step.call.name}`);
    this.record(step);
  }

  /** Discard all speculative state (call this before something outside the agent mutates state). */
  invalidate(cause: string): void {
    this.invalidateExcept(cause);
  }

  /** Abort in-flight speculation and drop cached results; keeps history and budget. Speculation continues next round. */
  cancelAll(reason = "cancelled"): void {
    this.roundAbort?.abort();
    this.roundOpen = false;
    for (const e of [...this.entries.values()]) this.discard(e, reason);
  }

  /** Permanently stop speculating: aborts everything in flight. Later calls execute directly. Idempotent. */
  close(): void {
    this.isClosed = true;
    this.cancelAll("closed");
  }

  /** Wait until all started prediction rounds have launched and no speculative execution is in flight. */
  async drain(): Promise<void> {
    for (;;) {
      const waits = [...this.activeRounds, ...[...this.entries.values()].filter((e) => !e.settled).map((e) => e.promise)];
      if (!waits.length) return;
      await Promise.all(waits);
    }
  }

  /** Wrap the tool registry so every handler routes through this speculator. */
  wrapTools(): ToolRegistry {
    const out: ToolRegistry = {};
    for (const [name, t] of this.toolMap) {
      out[name] = { spec: t.spec, handler: (args, ctx) => this.call({ name, args }, { signal: ctx?.signal }) };
    }
    return out;
  }

  // ---------------------------------------------------------------- internals

  private touch(): void {
    this.lastActivity = this.clock.now();
  }

  private speculability(name: string): "unsafe" | "open_world" | undefined {
    const c = this.classify(name);
    if (!this.allow.has(c.safety)) return "unsafe";
    if (c.openWorld) {
      const a = this.o.allowOpenWorld;
      if (!(a === true || (Array.isArray(a) && a.includes(name)))) return "open_world";
    }
    return undefined;
  }

  private normalize(call: ToolCall): ToolCall {
    const n = this.o.normalizeArgs;
    const c = { name: call.name, args: { ...(call.args ?? {}) } };
    if (!n) return c;
    const fn = typeof n === "function" ? n : Object.prototype.hasOwnProperty.call(n, call.name) ? n[call.name] : undefined;
    if (!fn) return c;
    const out = fn(c);
    // a normalizer may only rewrite arguments, never the tool
    return { name: call.name, args: out?.args ?? {} };
  }

  /** Normalized cache key, or undefined if the call cannot be keyed (never throws). */
  private keyOf(call: ToolCall): string | undefined {
    try {
      return tryCallKey(this.normalize(call));
    } catch (e) {
      this.internalError("normalizeArgs", e);
      return undefined;
    }
  }

  private record(step: Step): void {
    this.hist.push(step);
    const max = this.o.maxHistory ?? 200;
    if (this.hist.length > max) this.hist.splice(0, this.hist.length - max);
    for (const p of this.predictors) {
      try {
        p.observe?.(this.hist);
      } catch (e) {
        this.internalError(`predictor ${p.name}.observe`, e);
      }
    }
  }

  private async runStage(
    predictor: Predictor,
    round: number,
    ac: AbortController,
    ctx: RoundContext,
    roundState: { spend: number },
    history: readonly Step[],
  ): Promise<void> {
    const source = typeof predictor.name === "string" ? predictor.name : "predictor";
    const t0 = this.clock.now();
    let raw: unknown;
    try {
      const k = this.o.topK ?? 3;
      raw = await predictor.predict(
        { history, messages: ctx.messages, meta: ctx.meta, signal: ac.signal },
        k * 2, // over-fetch: some candidates get filtered as unsafe/duplicate
      );
    } catch (e) {
      if (!isAbortError(e) && !ac.signal.aborted) {
        this.m.predictorErrors++;
        this.count("speculate.predictor.errors", { predictor: source });
        this.emit({ type: "predictor_error", round, source, error: errMsg(e) });
      }
      return;
    } finally {
      const dt = this.clock.now() - t0;
      this.m.predictorLatencyMs += dt;
      this.hist_("speculate.predictor.duration", dt, { predictor: source });
    }
    const { predictions, cost, invalid } = sanitizePredictions(raw, source);
    if (invalid) this.internalError(`predictor ${source}`, new Error(`returned ${invalid} malformed prediction(s)`));
    this.m.predictorCost += cost;
    if (round !== this.round || !this.roundOpen || ac.signal.aborted || this.isClosed) return; // the real call already arrived
    this.emit({ type: "predicted", round, source, predictions, latencyMs: this.clock.now() - t0 });
    try {
      this.launchAll(predictions, round, roundState);
    } catch (e) {
      this.internalError("launch", e);
    }
  }

  private launchAll(predictions: Prediction[], round: number, roundState: { spend: number }): void {
    const topK = this.o.topK ?? 3;
    const minScore = this.o.minScore ?? 0.05;
    const costOf = this.o.budget?.costOf ?? (() => 1);
    const maxTotal = this.o.budget?.maxTotal ?? Infinity;
    const maxPerRound = this.o.budget?.maxPerRound ?? Infinity;
    let launched = 0;
    for (const p of predictions) {
      if (launched >= topK) break;
      const skip = (reason: SkipReason) => {
        this.count("speculate.skipped", { reason });
        this.emit({ type: "skip", call: p.call, reason });
      };
      if (p.score < minScore) {
        skip("low_score");
        continue;
      }
      if (!this.toolMap.has(p.call.name)) {
        skip("unknown_tool");
        continue;
      }
      const why = this.speculability(p.call.name);
      if (why) {
        this.m.skippedUnsafe++;
        skip(why);
        continue;
      }
      let call: ToolCall;
      let key: string | undefined;
      try {
        call = this.normalize(p.call);
        key = tryCallKey(call);
      } catch (e) {
        this.internalError("normalizeArgs", e);
        continue;
      }
      if (key === undefined) {
        skip("uncacheable");
        continue;
      }
      if (this.entries.has(key)) {
        skip("duplicate");
        continue;
      }
      let cost: number;
      try {
        cost = Number(costOf(call));
      } catch (e) {
        this.internalError("budget.costOf", e);
        continue;
      }
      if (!Number.isFinite(cost) || cost < 0) {
        this.internalError("budget.costOf", new Error(`invalid cost ${String(cost)}`));
        continue;
      }
      if (this.spent + cost > maxTotal || roundState.spend + cost > maxPerRound) {
        this.m.skippedBudget++;
        skip("budget");
        continue;
      }
      this.spent += cost;
      roundState.spend += cost;
      launched++;
      this.launch(call, key, cost, round, p);
    }
    this.evictOverflow();
  }

  private launch(call: ToolCall, key: string, cost: number, round: number, p: Prediction): void {
    const tool = this.toolMap.get(call.name)!;
    const e: Entry = {
      key,
      call,
      safety: this.classify(call.name).safety,
      round,
      cost,
      epoch: this.epoch,
      ac: new AbortController(),
      state: "queued",
      launchedAt: this.clock.now(),
      bytes: 0,
      counted: false,
      consumed: false,
      settled: false,
      promise: Promise.resolve(),
    };
    this.entries.set(key, e);
    this.m.launched++;
    this.m.speculativeSpend += cost;
    this.count("speculate.launches", { tool: call.name, source: p.source });
    this.emit({ type: "launch", call, key, score: p.score, source: p.source });
    const timeoutMs = this.o.timeoutMs ?? 30_000;
    const maxBytes = this.o.maxCacheBytes ?? 64 * 1024 * 1024;

    e.promise = (async () => {
      try {
        await this.limiter.acquire(e.ac.signal);
      } catch {
        e.state = "aborted";
        e.finishedAt = this.clock.now();
        return;
      }
      const timer = new AbortController();
      try {
        e.state = "running";
        e.startedAt = this.clock.now();
        this.clock.sleep(timeoutMs, timer.signal).then(
          () => {
            if (!e.consumed && pending(e)) {
              this.m.timeouts++;
              const err = new Error(`speculative ${call.name} timed out after ${timeoutMs}ms`);
              err.name = "TimeoutError";
              e.ac.abort(err);
            }
          },
          () => {},
        );
        e.fingerprint = await this.fingerprint(call, e.ac.signal);
        if (e.ac.signal.aborted) throw abortError(e.ac.signal.reason);
        const result = await raceAbort(
          Promise.resolve().then(() =>
            tool.handler(call.args, {
              signal: e.ac.signal,
              speculative: true,
              ...(this.o.sessionId !== undefined ? { sessionId: this.o.sessionId } : {}),
            }),
          ),
          e.ac.signal,
        );
        if (this.o.acceptResult && !this.o.acceptResult(call, result)) {
          e.state = "error";
          e.error = new Error("speculative result rejected by acceptResult");
        } else if ((e.bytes = approxBytes(result, maxBytes)) > maxBytes) {
          e.state = "error";
          e.error = new Error("speculative result exceeds maxCacheBytes");
        } else {
          e.state = "done";
          e.result = result;
        }
      } catch (err) {
        e.state = e.ac.signal.aborted ? "aborted" : "error";
        e.error = err;
      } finally {
        timer.abort();
        e.finishedAt = this.clock.now();
        this.limiter.release();
      }
      if (e.state === "done" && e.safety !== "read_only") {
        // an opted-in idempotent tool just changed state: results produced before or during
        // its execution may be stale now
        this.invalidateExcept(`speculative ${call.name} completed`, e);
      }
    })()
      .then(() => {
        if (e.state === "done" && this.entries.get(e.key) === e && !e.counted) {
          e.counted = true;
          this.cacheBytes += e.bytes;
          this.evictBytes();
        }
        if (e.state !== "done" && !e.consumed) this.discard(e, `speculation ${e.state}: ${errMsg(e.error)}`);
      })
      .catch((err: unknown) => this.internalError("speculation", err))
      .finally(() => {
        e.settled = true;
      });
  }

  private async fingerprint(call: ToolCall, signal?: AbortSignal): Promise<string | undefined> {
    const vs = this.o.validators;
    if (!vs?.length) return undefined;
    const all = Promise.all(vs.map((v) => Promise.resolve().then(() => v.snapshot(call)))).then((parts) => JSON.stringify(parts));
    return withTimeout(all, this.o.validatorTimeoutMs ?? 2000, this.clock, signal, "validator");
  }

  private async tryConsume(
    e: Entry,
    signal: AbortSignal | undefined,
  ): Promise<{ ok: true; value: unknown } | { ok: false; outcome: string }> {
    e.consumed = true; // protects it from round-cancellation and the speculative timeout
    const joinAt = this.clock.now();
    if (e.state === "queued") {
      // still waiting for a concurrency slot: running it now ourselves is never slower
      e.consumed = false;
      this.discard(e, "real call arrived before speculative execution started");
      this.emit({ type: "miss", call: e.call, key: e.key });
      return { ok: false, outcome: "miss" };
    }
    const wasRunning = e.state === "running";
    if (wasRunning) {
      try {
        await (signal ? raceAbort(e.promise, signal) : e.promise);
      } catch (err) {
        // the caller gave up while waiting: nobody will use this speculation
        e.ac.abort(abortError("caller aborted"));
        this.markWasted(e, "caller aborted while joining", true);
        throw err;
      }
    }
    const fail = (type: "stale" | "spec_failed", detail: string) => {
      if (type === "stale") this.m.staleRejected++;
      else this.m.specFailedFallbacks++;
      this.emit({ type, call: e.call, key: e.key, detail });
      this.markWasted(e, detail);
      return { ok: false as const, outcome: type };
    };
    if (e.state !== "done") return fail("spec_failed", `speculation ${e.state}: ${errMsg(e.error)}`);
    if (e.epoch !== this.epoch) return fail("stale", "epoch changed (a mutating call ran)");
    const maxAge = this.o.maxAgeMs ?? 60_000;
    if (!wasRunning && this.clock.now() - (e.finishedAt ?? 0) > maxAge) return fail("stale", "max age exceeded");
    if (this.o.validators?.length) {
      let fp: string | undefined;
      try {
        fp = await this.fingerprint(e.call, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        return fail("stale", `validator error: ${errMsg(err)}`);
      }
      if (fp !== e.fingerprint) return fail("stale", "validator fingerprint changed");
      if (e.epoch !== this.epoch) return fail("stale", "epoch changed during validation");
    }
    e.fate = "used";
    const saved = wasRunning ? Math.max(0, joinAt - (e.startedAt ?? joinAt)) : (e.finishedAt ?? 0) - (e.startedAt ?? 0);
    if (wasRunning) this.m.joins++;
    else this.m.hits++;
    this.m.latencySavedMs += saved;
    const type = wasRunning ? "join" : "hit";
    this.count("speculate.calls", { tool: e.call.name, outcome: type });
    this.hist_("speculate.latency_saved", saved, { tool: e.call.name });
    this.emit({ type, call: e.call, key: e.key, savedMs: saved });
    return { ok: true, value: e.result };
  }

  private invalidateExcept(cause: string, keep?: Entry): void {
    this.epoch++;
    if (keep) keep.epoch = this.epoch;
    this.m.invalidations++;
    for (const e of [...this.entries.values()]) if (e !== keep) this.discard(e, `invalidated: ${cause}`);
    this.count("speculate.invalidations");
    this.emit({ type: "invalidate", cause });
  }

  private removeEntry(e: Entry): void {
    if (this.entries.get(e.key) === e) this.entries.delete(e.key);
    if (e.counted) {
      e.counted = false;
      this.cacheBytes -= e.bytes;
    }
  }

  private discard(e: Entry, reason: string): void {
    this.removeEntry(e);
    const wasPending = pending(e);
    if (wasPending) e.ac.abort(abortError(reason));
    this.markWasted(e, reason, wasPending || e.state === "aborted");
  }

  private markWasted(e: Entry, reason: string, aborted = e.state === "aborted"): void {
    if (e.fate) return;
    e.fate = "wasted";
    this.m.wasted++;
    if (aborted) this.m.aborted++;
    const end = e.finishedAt ?? this.clock.now();
    if (e.startedAt !== undefined) this.m.wastedToolMs += Math.max(0, end - e.startedAt);
    this.m.wastedSpend += e.cost;
    this.count("speculate.wasted", { tool: e.call.name });
    this.emit({ type: "wasted", call: e.call, key: e.key, reason });
  }

  private evictExpired(): void {
    const maxAge = this.o.maxAgeMs ?? 60_000;
    const now = this.clock.now();
    for (const e of [...this.entries.values()]) {
      if (e.state === "done" && now - (e.finishedAt ?? now) > maxAge) this.discard(e, "expired");
    }
  }

  /** Enforce maxCacheEntries: drop completed results first (oldest first), then queued, then running. */
  private evictOverflow(): void {
    const max = this.o.maxCacheEntries ?? 64;
    if (this.entries.size <= max) return;
    const all = [...this.entries.values()];
    const rank = (e: Entry) => (e.state === "running" ? 2 : e.state === "queued" ? 1 : 0);
    all.sort((a, b) => rank(a) - rank(b) || (a.finishedAt ?? a.launchedAt) - (b.finishedAt ?? b.launchedAt));
    for (const e of all) {
      if (this.entries.size <= max) break;
      this.discard(e, "evicted (cache full)");
    }
    this.evictBytes();
  }

  private evictBytes(): void {
    const max = this.o.maxCacheBytes ?? 64 * 1024 * 1024;
    if (this.cacheBytes <= max) return;
    const done = [...this.entries.values()].filter((e) => e.counted).sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const e of done) {
      if (this.cacheBytes <= max) break;
      this.discard(e, "evicted (maxCacheBytes)");
    }
  }

  // ------------------------------------------------------------ observability

  private emit(e: SpeculationEvent): void {
    if (this.o.onEvent) {
      try {
        this.o.onEvent(e);
      } catch (err) {
        this.m.internalErrors++;
        this.log("warn", "onEvent listener threw (ignored)", { error: errMsg(err) });
      }
    }
    if (this.o.logger) this.logEvent(e);
  }

  private logEvent(e: SpeculationEvent): void {
    const f: Record<string, unknown> = { event: e.type };
    if (this.o.sessionId !== undefined) f.sessionId = this.o.sessionId;
    if ("call" in e) {
      f.tool = e.call.name;
      if (this.o.logArgs) f.args = e.call.args;
    }
    if ("key" in e) f.key = e.key.slice(0, 16);
    for (const k of ["round", "source", "score", "reason", "savedMs", "detail", "cause", "where", "error", "latencyMs"] as const) {
      if (k in e) f[k] = (e as Record<string, unknown>)[k];
    }
    if (e.type === "predicted") f.count = e.predictions.length;
    const level = e.type === "predictor_error" || e.type === "internal_error" ? "warn" : "debug";
    this.log(level, `speculate: ${e.type}`, f);
  }

  private log(level: "debug" | "info" | "warn" | "error", msg: string, fields: Record<string, unknown>): void {
    try {
      this.o.logger?.[level](msg, fields);
    } catch {
      // a broken logger must never break the agent
    }
  }

  private count(name: string, attributes?: Record<string, string>): void {
    if (!this.o.telemetry) return;
    try {
      this.o.telemetry.counter(name, 1, attributes);
    } catch {
      // ignore
    }
  }

  private hist_(name: string, value: number, attributes?: Record<string, string>): void {
    if (!this.o.telemetry) return;
    try {
      this.o.telemetry.histogram(name, value, attributes);
    } catch {
      // ignore
    }
  }

  private internalError(where: string, err: unknown): void {
    this.m.internalErrors++;
    this.count("speculate.internal_errors", { where });
    this.emit({ type: "internal_error", where, error: errMsg(err) });
  }
}

/** Validate untrusted predictor output. Never throws. */
function sanitizePredictions(raw: unknown, source: string): { predictions: Prediction[]; cost: number; invalid: number } {
  const res = raw as { predictions?: unknown; cost?: unknown } | null | undefined;
  const list = res && Array.isArray(res.predictions) ? (res.predictions as unknown[]) : undefined;
  if (!list) return { predictions: [], cost: 0, invalid: 1 };
  const predictions: Prediction[] = [];
  let invalid = 0;
  for (const x of list) {
    const p = x as Partial<Prediction> | null;
    const c = p?.call as Partial<ToolCall> | undefined;
    const args = c?.args;
    if (
      !p ||
      typeof p.score !== "number" ||
      !Number.isFinite(p.score) ||
      !c ||
      typeof c.name !== "string" ||
      (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args)))
    ) {
      invalid++;
      continue;
    }
    predictions.push({
      call: { name: c.name, args: args ?? {} },
      score: p.score,
      source: typeof p.source === "string" ? p.source : source,
    });
  }
  predictions.sort((a, b) => b.score - a.score);
  const cost = typeof res!.cost === "number" && Number.isFinite(res!.cost) && res!.cost > 0 ? res!.cost : 0;
  return { predictions, cost, invalid };
}
