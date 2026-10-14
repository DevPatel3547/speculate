import type { Step, ToolCall } from "../types.js";

export interface PredictionContext {
  /** Real (non-speculative) steps so far, oldest first. */
  history: readonly Step[];
  /** Optional raw conversation (e.g. Anthropic `messages`) for model-based predictors. */
  messages?: readonly unknown[];
  /** Free-form extra data an integration wants to pass to its predictor. */
  meta?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface Prediction {
  call: ToolCall;
  /** Rough probability/confidence in [0, 1]. Used for ranking and `minScore`. */
  score: number;
  /** Which predictor produced it (for metrics). */
  source: string;
}

export interface PredictorResult {
  predictions: Prediction[];
  /** Cost of producing this prediction (e.g. USD for an LLM call). */
  cost?: number;
}

export interface Predictor {
  readonly name: string;
  predict(ctx: PredictionContext, k: number): Promise<PredictorResult>;
  /** Online learning hook: called after every real step. */
  observe?(history: readonly Step[]): void;
}
