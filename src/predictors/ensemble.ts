import { tryCallKey } from "../canonical.js";
import type { Step } from "../types.js";
import type { PredictionContext, Prediction, Predictor, PredictorResult } from "./types.js";

/**
 * Runs predictors concurrently and merges candidates by canonical call key.
 * Scores combine with noisy-OR: two predictors agreeing raises confidence.
 * A failing predictor is ignored (the others still count).
 */
export class EnsemblePredictor implements Predictor {
  readonly name = "ensemble";
  /** @param predictors members, queried concurrently */
  constructor(private predictors: Predictor[]) {}

  async predict(ctx: PredictionContext, k: number): Promise<PredictorResult> {
    const results = await Promise.allSettled(this.predictors.map((p) => p.predict(ctx, k)));
    const merged = new Map<string, Prediction>();
    let cost = 0;
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      cost += r.value.cost ?? 0;
      for (const p of r.value.predictions) {
        const key = tryCallKey(p.call);
        if (key === undefined) continue;
        const m = merged.get(key);
        if (!m) merged.set(key, { ...p });
        else merged.set(key, { call: m.call, score: 1 - (1 - m.score) * (1 - p.score), source: `${m.source}+${p.source}` });
      }
    }
    return { predictions: [...merged.values()].sort((a, b) => b.score - a.score).slice(0, k), cost };
  }

  observe(history: readonly Step[]): void {
    for (const p of this.predictors) p.observe?.(history);
  }
}
