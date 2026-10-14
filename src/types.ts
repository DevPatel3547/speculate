/** Core types shared across speculate-tools. */

/**
 * Safety class of a tool.
 * - `read_only`: observes environment state, never changes it. Safe to speculate.
 * - `idempotent`: may change state, but running it N times equals running it once.
 *   Speculating it is only acceptable if you accept the effect happening even when
 *   the agent never actually asks for it (opt-in via `allow`).
 * - `side_effecting`: anything else. **Never** speculated.
 */
export type Safety = "read_only" | "idempotent" | "side_effecting";

/** Any JSON value. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** A tool invocation: tool name plus its (JSON) arguments. */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** MCP-style tool annotations. All are *hints* (see the MCP spec) and may be wrong or malicious. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  /** The tool may talk to external entities (network). Such tools are not speculated unless opted in. */
  openWorldHint?: boolean;
  title?: string;
}

/** Static description of a tool, used for classification and prompting. */
export interface ToolSpec {
  name: string;
  description?: string;
  /** JSON Schema of the arguments (used by classification heuristics and LLM prompts). */
  inputSchema?: unknown;
  annotations?: ToolAnnotations;
}

/** Context passed to every tool handler invocation. */
export interface ToolContext {
  /** Aborted when the execution is no longer wanted (speculation discarded, timeout, caller cancelled). */
  signal: AbortSignal;
  /** `true` when this execution is speculative (its result may be thrown away). */
  speculative: boolean;
  /** Session this execution belongs to (set when the Speculator has a `sessionId`). */
  sessionId?: string;
}

/** Executes a tool. Must honour `ctx.signal` where practical. */
export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

/** A tool: its spec plus the function that runs it. */
export interface ToolDefinition {
  spec: ToolSpec;
  handler: ToolHandler;
}

/** Tools keyed by name. */
export type ToolRegistry = Record<string, ToolDefinition>;

/** One executed (real, not speculative) step of an agent trajectory. */
export interface Step {
  call: ToolCall;
  result?: unknown;
  error?: string;
}

/** A recorded trajectory, used to train predictors. */
export interface Trace {
  id?: string;
  steps: Step[];
}

/** Injectable clock so the simulator and tests can run on virtual time. */
export interface Clock {
  /** Monotonic milliseconds. */
  now(): number;
  /** Resolves after `ms`; rejects with an AbortError if `signal` aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
