import { Speculator, type RoundContext, type SpeculatorOptions } from "./speculator.js";
import type { SpeculationMetrics } from "./metrics.js";
import type { ToolRegistry } from "./types.js";

/** Result of {@link speculate}. */
export interface Speculated {
  /** Drop-in replacement for your tool registry: same specs, handlers route through the speculator. */
  tools: ToolRegistry;
  /** The underlying engine (for `observeExternal`, `invalidate`, `drain`, ...). */
  speculator: Speculator;
  /** Call right when your agent starts waiting on the model (do not await; never throws). */
  onModelStart(ctx?: RoundContext): void;
  /** Snapshot of the counters. */
  metrics(): SpeculationMetrics;
  /** Abort in-flight speculation and stop speculating. */
  close(): void;
}

/**
 * Generic wrapper: one session, one tool registry. Minimal integration into any agent loop:
 *
 *   const s = speculate(myTools, { predictor });
 *   while (true) {
 *     s.onModelStart({ messages });              // 1. speculation starts while the model thinks
 *     const reply = await callModel(messages);   // 2. model thinks
 *     for (const tc of reply.toolCalls)          // 3. real calls hit the speculative cache
 *       results.push(await s.tools[tc.name].handler(tc.args, ctx));
 *   }
 */
export function speculate(tools: ToolRegistry, opts: Omit<SpeculatorOptions, "tools">): Speculated {
  const speculator = new Speculator({ ...opts, tools });
  return {
    tools: speculator.wrapTools(),
    speculator,
    onModelStart(ctx) {
      void speculator.beginRound(ctx);
    },
    metrics: () => speculator.metrics(),
    close: () => speculator.close(),
  };
}
