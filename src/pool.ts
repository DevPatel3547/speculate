import { realClock } from "./clock.js";
import { Semaphore } from "./executor.js";
import { emptyMetrics, mergeMetrics, type SpeculationMetrics } from "./metrics.js";
import type { Predictor } from "./predictors/types.js";
import { Speculator, type SpeculatorOptions } from "./speculator.js";

/** Options for {@link SpeculatorPool}. */
export interface SpeculatorPoolOptions extends Omit<SpeculatorOptions, "predictor" | "sessionId" | "limiter"> {
  /**
   * Predictor(s) for each session. Pass a factory to give every session its own predictor
   * state (recommended when sessions belong to different users: a shared learning predictor
   * such as `NGramPredictor` remembers argument values across sessions and may *propose*
   * one user's values in another user's session; cached *results* are never shared).
   */
  predictor: Predictor | readonly Predictor[] | ((sessionId: string) => Predictor | readonly Predictor[]);
  /** Max live sessions; the least recently used is closed and evicted beyond this. Default 1000. */
  maxSessions?: number;
  /** Sessions idle (no call/round) longer than this are closed and evicted. Default 30 minutes. */
  idleTtlMs?: number;
  /** Process-wide cap on concurrent speculative executions across all sessions. Default: per-session only. */
  maxGlobalConcurrency?: number;
}

/**
 * One isolated {@link Speculator} per session (conversation, user, tenant).
 *
 * Every session has its own speculative cache, history, epoch and budget, so a result
 * speculated for one session can never be served to another. Use this whenever a single
 * process serves more than one agent session.
 *
 * ```ts
 * const pool = new SpeculatorPool({ tools, predictor: (id) => new NGramPredictor() });
 * const s = pool.session(req.user.id + ":" + req.conversationId);
 * s.beginRound({ messages });
 * await s.call(toolCall);
 * ```
 */
export class SpeculatorPool {
  private sessions = new Map<string, Speculator>();
  private readonly limiter?: Semaphore;
  private retired = emptyMetrics();

  constructor(private readonly o: SpeculatorPoolOptions) {
    if (!o?.predictor) throw new TypeError("speculate: SpeculatorPool options.predictor is required");
    for (const [name, v, min] of [
      ["maxSessions", o.maxSessions, 1],
      ["maxGlobalConcurrency", o.maxGlobalConcurrency, 1],
    ] as const) {
      if (v !== undefined && !(Number.isInteger(v) && v >= min))
        throw new RangeError(`speculate: option ${name} must be an integer >= ${min}`);
    }
    if (o.idleTtlMs !== undefined && !(typeof o.idleTtlMs === "number" && o.idleTtlMs > 0)) {
      throw new RangeError("speculate: option idleTtlMs must be > 0");
    }
    if (o.maxGlobalConcurrency) this.limiter = new Semaphore(o.maxGlobalConcurrency);
  }

  /** Number of live sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** Get (or create) the Speculator for `sessionId`. Also sweeps idle sessions. */
  session(sessionId: string): Speculator {
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("speculate: sessionId must be a non-empty string");
    this.sweep();
    let s = this.sessions.get(sessionId);
    if (s) {
      // LRU: move to the end
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, s);
      return s;
    }
    const { predictor, maxSessions: _m, idleTtlMs: _i, maxGlobalConcurrency: _g, ...rest } = this.o;
    s = new Speculator({
      ...rest,
      sessionId,
      predictor: typeof predictor === "function" ? predictor(sessionId) : predictor,
      ...(this.limiter ? { limiter: this.limiter } : {}),
    });
    this.sessions.set(sessionId, s);
    const max = this.o.maxSessions ?? 1000;
    while (this.sessions.size > max) {
      const oldest = this.sessions.keys().next().value as string;
      this.delete(oldest);
    }
    return s;
  }

  /** The Speculator for `sessionId` if it exists (does not create or refresh it). */
  get(sessionId: string): Speculator | undefined {
    return this.sessions.get(sessionId);
  }

  /** Close and forget one session. Returns true if it existed. */
  delete(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.close();
    this.retired = mergeMetrics(this.retired, s.metrics());
    this.sessions.delete(sessionId);
    return true;
  }

  /** Close idle sessions now (also done automatically by {@link session}). */
  sweep(): void {
    const ttl = this.o.idleTtlMs ?? 30 * 60 * 1000;
    const now = (this.o.clock ?? realClock).now();
    for (const [id, s] of this.sessions) if (now - s.lastActivityAt > ttl) this.delete(id);
  }

  /** Metrics summed over live and evicted sessions. */
  metrics(): SpeculationMetrics {
    let m = this.retired;
    for (const s of this.sessions.values()) m = mergeMetrics(m, s.metrics());
    return m;
  }

  /** Close every session. */
  close(): void {
    for (const id of [...this.sessions.keys()]) this.delete(id);
  }
}
