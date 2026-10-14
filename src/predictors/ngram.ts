import { canonicalCallString, canonicalJson } from "../canonical.js";
import type { Step, Trace } from "../types.js";
import { defaultExtractors, type TokenExtractor } from "./tokens.js";
import type { PredictionContext, Prediction, Predictor, PredictorResult } from "./types.js";

export interface NGramOptions {
  /** n-gram order over tool names (3 => condition on up to 2 previous tools). Default 3. */
  order?: number;
  /** How far back args/results can be copied from. Default 3. */
  maxLag?: number;
  /** Only the first N tokens of each extractor are usable as arg sources. Default 8. */
  maxResultTokens?: number;
  /** Token extractors for templating args from previous results. */
  extractors?: Record<string, TokenExtractor>;
  /** Distinct values considered per arg. Default 3. */
  maxValuesPerArg?: number;
  /** Literal arg values longer than this (canonical JSON chars) are not learned. Default 200. */
  maxLiteralLength?: number;
  /** Min observations of (prevTool, tool, arg) before using the conditioned arg model. Default 2. */
  minConditionedCount?: number;
  /**
   * Max distinct argument sources remembered per (tool, arg) model; the least frequent are
   * pruned. Bounds memory for long-lived sessions. Default 64.
   */
  maxSourcesPerArg?: number;
}

type Counter = Map<string, number>;
function inc(m: Map<string, Counter>, k: string, sub: string, cap = Infinity): void {
  let c = m.get(k);
  if (!c) m.set(k, (c = new Map<string, number>()));
  c.set(sub, (c.get(sub) ?? 0) + 1);
  sortedCache.delete(c);
  // amortized pruning: when a counter doubles past its cap, keep the `cap` most frequent entries
  if (c.size > 2 * cap) {
    const keep = topEntries(c, cap).slice();
    c.clear();
    sortedCache.delete(c);
    for (const [key, n] of keep) c.set(key, n);
  }
}
function sum(c: Counter | undefined): number {
  let s = 0;
  if (c) for (const v of c.values()) s += v;
  return s;
}
function topEntries(c: Counter | undefined, n = Infinity): [string, number][] {
  if (!c) return [];
  let sorted = sortedCache.get(c);
  if (!sorted) sortedCache.set(c, (sorted = [...c.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))));
  return n >= sorted.length ? sorted : sorted.slice(0, n);
}
/** Sorted view of a counter, dropped whenever the counter changes (see `inc`). */
const sortedCache = new WeakMap<Counter, [string, number][]>();

/**
 * Markov / n-gram predictor over (tool name) sequences, with *argument
 * templates*: each argument of the predicted call is explained as one of
 *   lit:<json>              a literal value seen before (e.g. list_dir(".")),
 *   arg:<lag>:<tool>:<key>  a copy of argument <key> of the <tool> call `lag`
 *                           steps back (read_file(X) -> grep(path=X)),
 *   res:<ex>:<lag>:<tool>:<idx>  the idx-th token extracted (by extractor <ex>)
 *                           from the result of the <tool> call `lag` steps back
 *                           (grep -> read_file(first matching file)).
 * Sources are qualified by the source tool so that e.g. grep's `path` (a dir)
 * is never confused with read_file's `path` (a file).
 * Counts are learned from past traces and online from the live session.
 */
export class NGramPredictor implements Predictor {
  readonly name = "ngram";
  private o: Required<NGramOptions>;
  private toolCounts = new Map<string, Counter>(); // ctx -> next tool -> count
  private keysets = new Map<string, Counter>(); // tool -> keyset json -> count
  private argSrc = new Map<string, Counter>(); // "prev|tool|key" -> source -> count
  private argTotal = new Map<string, number>();
  private tokenCache = new WeakMap<object, Map<string, string[]>>();
  private literalCache = new Map<string, unknown>();
  /**
   * Last step learned online, per history array (one per session when shared across a
   * SpeculatorPool) plus a global fallback. Identity-based so a capped/rotating history works.
   */
  private lastByHistory = new WeakMap<readonly Step[], Step>();
  private lastLearned: Step | undefined;

  constructor(opts: NGramOptions = {}) {
    this.o = {
      order: opts.order ?? 3,
      maxLag: opts.maxLag ?? 3,
      maxResultTokens: opts.maxResultTokens ?? 8,
      extractors: opts.extractors ?? defaultExtractors,
      maxValuesPerArg: opts.maxValuesPerArg ?? 3,
      maxLiteralLength: opts.maxLiteralLength ?? 200,
      minConditionedCount: opts.minConditionedCount ?? 2,
      maxSourcesPerArg: opts.maxSourcesPerArg ?? 64,
    };
  }

  /** Learn from recorded trajectories (offline). Returns `this` for chaining. */
  train(traces: Iterable<Trace>): this {
    for (const t of traces) for (let i = 0; i < t.steps.length; i++) this.learnStep(t.steps, i);
    return this;
  }

  /**
   * Online learning: learns every step appended since the last call. The history may be
   * a sliding window (oldest steps dropped); if the last learned step is no longer in it,
   * a new session is assumed and the whole history is learned.
   */
  observe(history: readonly Step[]): void {
    let start = 0;
    const last = this.lastByHistory.get(history) ?? this.lastLearned;
    if (last) {
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i] === last) {
          start = i + 1;
          break;
        }
      }
    }
    for (let i = start; i < history.length; i++) this.learnStep(history, i);
    if (history.length) {
      this.lastLearned = history[history.length - 1];
      this.lastByHistory.set(history, this.lastLearned);
    }
  }

  /** Learned model size (for diagnostics). */
  stats(): { contexts: number; argModels: number; sources: number; observations: number } {
    let sources = 0;
    for (const c of this.argSrc.values()) sources += c.size;
    return { contexts: this.toolCounts.size, argModels: this.argSrc.size, sources, observations: sum(this.toolCounts.get("0:")) };
  }

  private ctxKey(steps: readonly Step[], end: number, n: number): string {
    const names: string[] = [];
    for (let j = end - n; j < end; j++) names.push(j < 0 ? "^" : steps[j].call.name);
    return `${n}:${names.join(">")}`;
  }

  private tokens(step: Step | undefined, ex: string): string[] {
    if (!step || step.result == null) return [];
    const r = step.result;
    if (typeof r !== "object") return this.o.extractors[ex](r).slice(0, this.o.maxResultTokens);
    let m = this.tokenCache.get(r);
    if (!m) this.tokenCache.set(r, (m = new Map<string, string[]>()));
    let t = m.get(ex);
    if (!t) m.set(ex, (t = this.o.extractors[ex](r).slice(0, this.o.maxResultTokens)));
    return t;
  }

  private learnStep(steps: readonly Step[], i: number): void {
    const c = steps[i]?.call;
    if (!c || typeof c.name !== "string") return;
    const args = c.args ?? {};
    for (let n = 0; n < this.o.order; n++) inc(this.toolCounts, this.ctxKey(steps, i, n), c.name);
    const keys = Object.keys(args)
      .filter((k) => args[k] !== undefined)
      .sort();
    inc(this.keysets, c.name, JSON.stringify(keys), 32);
    const prev = i > 0 ? steps[i - 1].call.name : "^";
    for (const k of keys) {
      const sources = this.matchSources(steps, i, args[k]);
      if (!sources) continue; // value is not JSON: not learnable
      for (const cond of [`${prev}|${c.name}|${k}`, `*|${c.name}|${k}`]) {
        this.argTotal.set(cond, (this.argTotal.get(cond) ?? 0) + 1);
        for (const s of sources) inc(this.argSrc, cond, s, this.o.maxSourcesPerArg);
      }
    }
  }

  private matchSources(steps: readonly Step[], i: number, v: unknown): string[] | undefined {
    const out: string[] = [];
    const cj = safeCanonical(v);
    if (cj === undefined) return undefined;
    if (cj.length <= this.o.maxLiteralLength) out.push(`lit:${cj}`);
    for (let lag = 1; lag <= this.o.maxLag && i - lag >= 0; lag++) {
      const s = steps[i - lag];
      for (const [k2, v2] of Object.entries(s.call.args ?? {})) {
        if (safeCanonical(v2) === cj) out.push(`arg:${lag}:${s.call.name}:${k2}`);
      }
      if (typeof v === "string") {
        for (const ex of Object.keys(this.o.extractors)) {
          const idx = this.tokens(s, ex).indexOf(v);
          if (idx >= 0) out.push(`res:${ex}:${lag}:${s.call.name}:${idx}`);
        }
      }
    }
    return out;
  }

  private resolve(source: string, h: readonly Step[]): { ok: true; value: unknown } | { ok: false } {
    const i = h.length;
    if (source.startsWith("lit:")) {
      let v = this.literalCache.get(source);
      if (v === undefined) {
        if (this.literalCache.size > 10_000) this.literalCache.clear();
        this.literalCache.set(source, (v = JSON.parse(source.slice(4)) as unknown));
      }
      // hand out a copy: predicted args must not alias the model's memory
      return { ok: true, value: v !== null && typeof v === "object" ? structuredCloneJson(v) : v };
    }
    const parts = source.split(":");
    if (parts[0] === "arg") {
      const s = h[i - Number(parts[1])];
      if (!s || s.call.name !== parts[2]) return { ok: false };
      const key = parts.slice(3).join(":");
      if (!(key in (s.call.args ?? {}))) return { ok: false };
      return { ok: true, value: s.call.args[key] };
    }
    if (parts[0] === "res") {
      const [, ex, lag, tool, idx] = parts;
      const s = h[i - Number(lag)];
      if (!this.o.extractors[ex] || !s || s.call.name !== tool) return { ok: false };
      const tok = this.tokens(s, ex)[Number(idx)];
      return tok === undefined ? { ok: false } : { ok: true, value: tok };
    }
    return { ok: false };
  }

  /** P(next tool | context) with interpolated back-off over context lengths. */
  toolDistribution(h: readonly Step[]): [string, number][] {
    const acc = new Map<string, number>();
    let wsum = 0;
    for (let n = this.o.order - 1; n >= 0; n--) {
      if (n > h.length) continue;
      const c = this.toolCounts.get(this.ctxKey(h, h.length, n));
      const tot = sum(c);
      if (!tot) continue;
      // longer contexts get more weight, scaled by how much evidence they have
      const w = (n + 1) ** 2 * (tot / (tot + 2));
      wsum += w;
      for (const [t, cnt] of c!) acc.set(t, (acc.get(t) ?? 0) + (w * cnt) / tot);
    }
    if (!wsum) return [];
    return [...acc.entries()].map(([t, p]) => [t, p / wsum] as [string, number]).sort((a, b) => b[1] - a[1]);
  }

  predict(ctx: PredictionContext, k: number): Promise<PredictorResult> {
    return Promise.resolve({ predictions: this.predictSync(ctx.history, k) });
  }

  /** Synchronous variant of {@link predict}: top-`k` next calls given `h`. */
  predictSync(h: readonly Step[], k: number): Prediction[] {
    const dist = this.toolDistribution(h).slice(0, Math.max(k * 2, 4));
    const prev = h.length ? h[h.length - 1].call.name : "^";
    const best = new Map<string, Prediction>();
    for (const [tool, pTool] of dist) {
      const [keysetJson] = topEntries(this.keysets.get(tool), 1)[0] ?? ["[]"];
      const keys = JSON.parse(keysetJson) as string[];
      const perKey: [string, [unknown, number][]][] = [];
      let feasible = true;
      for (const key of keys) {
        let cond = `${prev}|${tool}|${key}`;
        if ((this.argTotal.get(cond) ?? 0) < this.o.minConditionedCount) cond = `*|${tool}|${key}`;
        const total = this.argTotal.get(cond) ?? 0;
        const vals: [unknown, number][] = [];
        const seen = new Set<string>();
        for (const [src, cnt] of topEntries(this.argSrc.get(cond))) {
          const r = this.resolve(src, h);
          if (!r.ok) continue;
          const vk = safeCanonical(r.value);
          if (vk === undefined || seen.has(vk)) continue;
          seen.add(vk);
          vals.push([r.value, Math.min(1, cnt / Math.max(1, total))]);
          if (vals.length >= this.o.maxValuesPerArg) break;
        }
        if (!vals.length) {
          feasible = false;
          break;
        }
        perKey.push([key, vals]);
      }
      if (!feasible) continue;
      // cartesian product over per-key candidates (small: <= maxValuesPerArg^keys, trimmed)
      let combos: [Record<string, unknown>, number][] = [[{}, pTool]];
      for (const [key, vals] of perKey) {
        const next: [Record<string, unknown>, number][] = [];
        for (const [args, p] of combos) for (const [v, pv] of vals) next.push([{ ...args, [key]: v }, p * pv]);
        combos = next.sort((a, b) => b[1] - a[1]).slice(0, k * 3);
      }
      for (const [args, score] of combos) {
        const call = { name: tool, args };
        const key = canonicalCallString(call);
        if (key === undefined) continue;
        const prevBest = best.get(key);
        if (!prevBest || prevBest.score < score) best.set(key, { call, score, source: this.name });
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }
}

function safeCanonical(v: unknown): string | undefined {
  try {
    return canonicalJson(v);
  } catch {
    return undefined;
  }
}

function structuredCloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
