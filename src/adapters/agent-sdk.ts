/**
 * Claude Agent SDK integration (written against minimal structural types so this
 * library does not depend on `@anthropic-ai/claude-agent-sdk`).
 *
 * What can be speculated: your *custom* tools (created with `tool()` and served via
 * `createSdkMcpServer`). Their handlers run in your process, so we can serve them
 * from the speculative cache. Built-in tools (Read, Grep, Bash, ...) execute inside
 * the Claude Code runtime and cannot be served from our cache; we only *observe*
 * them (for prediction context) and treat non-read-only ones as invalidations.
 *
 *   const s = createSpeculativeSdkTools([searchDocs, getTicket], { serverName: "kb", predictor });
 *   const server = createSdkMcpServer({ name: "kb", tools: s.tools });
 *   for await (const msg of query({ prompt, options: { mcpServers: { kb: server }, hooks: s.hooks } })) ...
 */
import type { Speculator, SpeculatorOptions } from "../speculator.js";
import { Speculator as SpeculatorImpl } from "../speculator.js";
import type { Safety, ToolAnnotations, ToolRegistry } from "../types.js";

/** Shape of `SdkMcpToolDefinition` (from `tool()`), only the fields we touch. */
export interface SdkToolLike {
  name: string;
  description: string;
  inputSchema?: unknown;
  annotations?: ToolAnnotations;
  handler: (args: any, extra: unknown) => Promise<any>;
}

/** HookCallback: (input, toolUseID, { signal }) => Promise<HookJSONOutput>. */
export type HookCallbackLike = (
  input: any,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<Record<string, unknown>>;
export type HooksLike = Partial<Record<"PreToolUse" | "PostToolUse" | "PostToolBatch", { matcher?: string; hooks: HookCallbackLike[] }[]>>;

/** Default safety for Claude Code built-in tools we only observe. Anything else = side_effecting. */
export const BUILTIN_SAFETY: Record<string, Safety> = {
  Read: "read_only",
  Grep: "read_only",
  Glob: "read_only",
  LS: "read_only",
  TodoRead: "read_only",
};

/** Options for {@link createSpeculativeSdkTools}. */
export interface SpeculativeSdkToolsOptions extends Omit<SpeculatorOptions, "tools"> {
  /** Key used in `mcpServers` (tools are exposed as mcp__<serverName>__<tool>). */
  serverName: string;
  /** Safety of tools that run outside the speculator. Default BUILTIN_SAFETY. */
  externalSafety?: Record<string, Safety>;
  /** Use PostToolBatch (TS SDK) to start speculating once per batch. If false, uses PostToolUse. Default true. */
  usePostToolBatch?: boolean;
}

/**
 * Wrap Claude Agent SDK `tool()` definitions so their handlers are served from speculation,
 * and build the hooks that start rounds (PostToolBatch) and invalidate on built-in writes.
 */
export function createSpeculativeSdkTools<T extends SdkToolLike>(
  defs: T[],
  opts: SpeculativeSdkToolsOptions,
): { tools: T[]; speculator: Speculator; hooks: HooksLike } {
  const registry: ToolRegistry = {};
  for (const d of defs) {
    registry[d.name] = {
      spec: { name: d.name, description: d.description, inputSchema: d.inputSchema, annotations: d.annotations },
      handler: (args, ctx) => d.handler(args, { signal: ctx.signal }),
    };
  }
  const speculator = new SpeculatorImpl({ ...opts, tools: registry });
  const prefix = `mcp__${opts.serverName}__`;
  const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  const ours = (toolName: unknown) =>
    typeof toolName === "string" && toolName.startsWith(prefix) && own(registry, toolName.slice(prefix.length));
  const external = opts.externalSafety ?? BUILTIN_SAFETY;
  const safetyOf = (n: string): Safety => (own(external, n) ? external[n] : "side_effecting");

  const tools = defs.map((d) => ({
    ...d,
    handler: (args: any, extra?: { signal?: AbortSignal }) =>
      speculator.call({ name: d.name, args: args ?? {} }, { signal: extra?.signal }),
  }));

  const pre: HookCallbackLike = async (input) => {
    if (input?.hook_event_name !== "PreToolUse" || ours(input.tool_name)) return {};
    if (safetyOf(String(input.tool_name)) !== "read_only") speculator.invalidate(`external ${String(input.tool_name)} (before)`);
    return {};
  };
  const post: HookCallbackLike = async (input) => {
    if (input?.hook_event_name !== "PostToolUse") return {};
    if (!ours(input.tool_name)) {
      const name = String(input.tool_name);
      speculator.observeExternal(
        { call: { name, args: (input.tool_input ?? {}) as Record<string, unknown> }, result: input.tool_response },
        safetyOf(name),
      );
    }
    if (opts.usePostToolBatch === false) void speculator.beginRound();
    return {};
  };
  const batch: HookCallbackLike = async () => {
    void speculator.beginRound();
    return {};
  };

  const hooks: HooksLike = {
    PreToolUse: [{ hooks: [pre] }],
    PostToolUse: [{ hooks: [post] }],
    ...(opts.usePostToolBatch === false ? {} : { PostToolBatch: [{ hooks: [batch] }] }),
  };
  return { tools: tools, speculator, hooks };
}
