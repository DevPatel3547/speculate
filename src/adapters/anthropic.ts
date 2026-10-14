import type { Speculator } from "../speculator.js";
import type { ToolRegistry } from "../types.js";

/** Subset of `@anthropic-ai/sdk` used by the loop; `new Anthropic()` satisfies it structurally. */
export interface AnthropicToolLoopClient {
  messages: {
    create(
      body: Record<string, unknown>,
      options?: { signal?: AbortSignal | null },
    ): PromiseLike<{
      content: ({ type: string } & Record<string, unknown>)[];
      stop_reason: string | null;
      usage?: unknown;
    }>;
  };
}

/** A Messages API message. */
export type MessageParam = { role: "user" | "assistant"; content: unknown };

/** Options for {@link runAnthropicToolLoop}. */
export interface ToolLoopOptions {
  client: AnthropicToolLoopClient;
  model: string;
  system?: string;
  messages: MessageParam[];
  tools: ToolRegistry;
  /** If given, tool calls go through it and speculation runs while the model is thinking. */
  speculator?: Speculator;
  maxTokens?: number;
  maxTurns?: number;
  /** Extra params for messages.create (thinking, tool_choice, ...). */
  extra?: Record<string, unknown>;
}

function toContent(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

/**
 * Standard Anthropic Messages tool-use loop with speculation hooked in:
 *   - `speculator.beginRound({messages})` fires concurrently with `messages.create`
 *     (the model's "thinking" time is the speculation window);
 *   - each `tool_use` block is executed via `speculator.call`, sequentially, in the
 *     order the model emitted them (keeps read/write ordering deterministic).
 * Returns the final transcript.
 */
export async function runAnthropicToolLoop(
  o: ToolLoopOptions,
): Promise<{ messages: MessageParam[]; turns: number; stopReason: string | null }> {
  const messages = [...o.messages];
  const tools = Object.entries(o.tools).map(([name, t]) => ({
    name,
    description: t.spec.description ?? "",
    input_schema: (t.spec.inputSchema as object) ?? { type: "object", properties: {} },
  }));
  let stopReason: string | null = null;
  let turns = 0;
  try {
    while (turns < (o.maxTurns ?? 50)) {
      turns++;
      // snapshot: the predictor may read the transcript after we append to it
      if (o.speculator) void o.speculator.beginRound({ messages: [...messages] });
      const res = await o.client.messages.create({
        model: o.model,
        max_tokens: o.maxTokens ?? 4096,
        ...(o.system ? { system: o.system } : {}),
        messages,
        tools,
        ...(o.extra ?? {}),
      });
      stopReason = res.stop_reason;
      messages.push({ role: "assistant", content: res.content });
      if (res.stop_reason !== "tool_use") break;
      const results: unknown[] = [];
      for (const block of res.content) {
        if (block.type !== "tool_use") continue;
        const name = block.name as string;
        const input = (block.input ?? {}) as Record<string, unknown>;
        try {
          let out: unknown;
          if (o.speculator) out = await o.speculator.call({ name, args: input });
          else {
            const t = Object.prototype.hasOwnProperty.call(o.tools, name) ? o.tools[name] : undefined;
            if (!t) throw new Error(`Unknown tool: ${name}`);
            out = await t.handler(input, { signal: new AbortController().signal, speculative: false });
          }
          results.push({ type: "tool_result", tool_use_id: block.id, content: toContent(out) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: e instanceof Error ? e.message : String(e) });
        }
      }
      messages.push({ role: "user", content: results });
    }
  } finally {
    // stop background work (also when messages.create throws); the speculator stays usable
    o.speculator?.cancelAll("tool loop finished");
  }
  return { messages, turns, stopReason };
}

/** Renders the tail of an Anthropic transcript as text, for LLMPredictor's `renderMessages`. */
export function renderAnthropicMessages(messages: readonly unknown[], maxChars = 2000): string {
  const out: string[] = [];
  for (const m of messages.slice(-4) as MessageParam[]) {
    if (typeof m.content === "string") out.push(`${m.role}: ${m.content}`);
    else if (Array.isArray(m.content)) {
      for (const b of m.content as Record<string, unknown>[]) {
        if (b.type === "text") out.push(`${m.role}: ${String(b.text)}`);
        else if (b.type === "tool_use") out.push(`${m.role} tool_use: ${String(b.name)}(${JSON.stringify(b.input)})`);
        else if (b.type === "tool_result") out.push(`tool_result: ${toContent(b.content).slice(0, 300)}`);
      }
    }
  }
  const s = out.join("\n");
  return s.length > maxChars ? s.slice(s.length - maxChars) : s;
}
