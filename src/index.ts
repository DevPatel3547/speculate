/**
 * speculate-tools: speculative tool execution for AI agents.
 *
 * Entry points:
 * - `speculate-tools`       core engine, predictors, validators, Anthropic / Agent SDK adapters (no runtime deps)
 * - `speculate-tools/mcp`   speculative MCP proxy (uses `@modelcontextprotocol/sdk`)
 * - `speculate-tools/eval`  offline trace-replay evaluation
 *
 * @packageDocumentation
 */
export * from "./types.js";
export { VERSION } from "./version.js";

// engine
export {
  Speculator,
  type SpeculatorOptions,
  type SpeculationEvent,
  type BudgetOptions,
  type RoundContext,
  type CallOptions,
  type SkipReason,
} from "./speculator.js";
export { speculate, type Speculated } from "./speculate.js";
export { SpeculatorPool, type SpeculatorPoolOptions } from "./pool.js";
export { emptyMetrics, hitRate, eligibleHitRate, precision, mergeMetrics, type SpeculationMetrics } from "./metrics.js";

// policy & keys
export { classifyTool, ToolClassifier, type Classification, type ClassifierOptions } from "./classifier.js";
export {
  canonicalJson,
  callKey,
  tryCallKey,
  canonicalCallString,
  pathNormalizer,
  UncacheableArgsError,
  MAX_ARG_DEPTH,
  type ArgNormalizer,
} from "./canonical.js";
export { fsValidator, customValidator, type StalenessValidator, type FsValidatorOptions } from "./validators/index.js";

// observability
export { otelTelemetry, silentLogger, type Logger, type TelemetrySink, type MeterLike, type Attributes } from "./observability.js";

// time & concurrency
export { realClock, scaledClock, VirtualClock, isAbortError, abortError } from "./clock.js";
export { Semaphore, raceAbort, withTimeout } from "./executor.js";

// predictors
export * from "./predictors/types.js";
export { NGramPredictor, type NGramOptions } from "./predictors/ngram.js";
export { LLMPredictor, extractJsonArray, stripReasoning, type LLMClient, type LLMPredictorOptions } from "./predictors/llm.js";
export { AnthropicLLMClient, type AnthropicMessagesLike, type AnthropicLLMClientOptions } from "./predictors/anthropic-client.js";
export { OpenAICompatibleLLMClient, type OpenAICompatibleOptions, type FetchLike } from "./predictors/openai-compatible.js";
export { EnsemblePredictor } from "./predictors/ensemble.js";
export { pathTokens, definedIdentifiers, defaultExtractors, type TokenExtractor } from "./predictors/tokens.js";

// adapters (structural typing: no dependency on the vendor SDKs)
export {
  runAnthropicToolLoop,
  renderAnthropicMessages,
  type AnthropicToolLoopClient,
  type ToolLoopOptions,
  type MessageParam,
} from "./adapters/anthropic.js";
export {
  createSpeculativeSdkTools,
  BUILTIN_SAFETY,
  type SpeculativeSdkToolsOptions,
  type SdkToolLike,
  type HookCallbackLike,
  type HooksLike,
} from "./adapters/agent-sdk.js";
