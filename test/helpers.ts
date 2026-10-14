import type { PredictionContext, Predictor, PredictorResult } from "../src/predictors/types.js";
import type { Clock, ToolCall, ToolRegistry } from "../src/types.js";

/** Predictor that returns whatever the test tells it to. */
export function scripted(fn: (ctx: PredictionContext) => ToolCall[], latencyMs = 0, clock?: Clock): Predictor & { calls: number } {
  const p = {
    name: "scripted",
    calls: 0,
    async predict(ctx: PredictionContext, k: number): Promise<PredictorResult> {
      p.calls++;
      if (latencyMs && clock) await clock.sleep(latencyMs, ctx.signal);
      return {
        predictions: fn(ctx)
          .slice(0, k)
          .map((call, i) => ({ call, score: 0.9 - i * 0.1, source: "scripted" })),
      };
    },
  };
  return p;
}

export interface StoreLog {
  real: string[];
  spec: string[];
  abortedSpec: string[];
  maxConcurrentSpec: number;
}

/**
 * A key-value store exposed as tools:
 *  get(key)        read_only (heuristic: "get")
 *  put(key,value)  side_effecting
 *  slow_get(key)   read_only, very slow
 *  flaky_get(key)  read_only, always throws
 */
export function makeStore(clock: Clock, latency: { get?: number; put?: number; slow?: number } = {}) {
  const data = new Map<string, string>();
  const log: StoreLog = { real: [], spec: [], abortedSpec: [], maxConcurrentSpec: 0 };
  let concurrentSpec = 0;
  const track = async <T>(
    name: string,
    args: Record<string, unknown>,
    speculative: boolean,
    signal: AbortSignal,
    ms: number,
    f: () => T,
  ): Promise<T> => {
    const desc = `${name}:${safeJson(args)}`;
    (speculative ? log.spec : log.real).push(desc);
    if (speculative) log.maxConcurrentSpec = Math.max(log.maxConcurrentSpec, ++concurrentSpec);
    try {
      await clock.sleep(ms, signal);
      return f();
    } catch (e) {
      if (speculative && signal.aborted) log.abortedSpec.push(desc);
      throw e;
    } finally {
      if (speculative) concurrentSpec--;
    }
  };
  const tools: ToolRegistry = {
    get: {
      spec: { name: "get", description: "Get a value by key." },
      handler: (a, c) => track("get", a, c.speculative, c.signal, latency.get ?? 100, () => data.get(String(a.key)) ?? null),
    },
    slow_get: {
      spec: { name: "slow_get", description: "Get a value, slowly." },
      handler: (a, c) => track("slow_get", a, c.speculative, c.signal, latency.slow ?? 10_000, () => data.get(String(a.key)) ?? null),
    },
    flaky_get: {
      spec: { name: "flaky_get", description: "Get a value (always fails)." },
      handler: (a, c) =>
        track("flaky_get", a, c.speculative, c.signal, 10, () => {
          throw new Error(`flaky_get failed for ${String(a.key)}`);
        }),
    },
    put: {
      spec: { name: "put", description: "Put a value." },
      handler: (a, c) =>
        track("put", a, c.speculative, c.signal, latency.put ?? 50, () => {
          data.set(String(a.key), String(a.value));
          return "ok";
        }),
    },
    // no annotations, no recognizable verb: must default to side_effecting
    frobnicate: {
      spec: { name: "frobnicate", description: "Does a thing." },
      handler: (a, c) => track("frobnicate", a, c.speculative, c.signal, 10, () => "frobbed"),
    },
  };
  return { data, log, tools };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "[unserializable]";
  }
}
