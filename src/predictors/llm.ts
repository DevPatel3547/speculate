import type { Step, ToolSpec } from "../types.js";
import type { PredictionContext, Prediction, Predictor, PredictorResult } from "./types.js";

/** Minimal pluggable LLM client. Implement for any provider. */
export interface LLMClient {
  complete(req: {
    system: string;
    prompt: string;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }>;
}

export interface LLMPredictorOptions {
  client: LLMClient;
  /** Tools the predictor may propose. Pass only speculable tools to save tokens. */
  tools: ToolSpec[];
  /** Number of recent steps shown to the model. Default 8. */
  maxHistory?: number;
  /** Each result is truncated to this many chars in the prompt. Default 600. */
  maxResultChars?: number;
  /** Max output tokens. Default 400. */
  maxTokens?: number;
  /** USD per million tokens, for cost accounting. */
  pricing?: { inputPerMTok: number; outputPerMTok: number };
  /** Optional: render the conversation tail (e.g. last user/assistant text) for the prompt. */
  renderMessages?: (messages: readonly unknown[]) => string;
}

const SYSTEM = `You predict the next tool calls of an AI agent so they can be pre-executed speculatively.
Only propose calls to the listed tools, with exact argument values the agent is most likely to use.
Respond with ONLY a JSON array, most likely first: [{"name": "...", "args": {...}, "p": 0.0-1.0}]`;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + `…[+${s.length - n} chars]`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x)) ?? "";
  } catch {
    return "[unserializable]";
  }
}

function renderStep(s: Step, maxChars: number): string {
  const res = s.error !== undefined ? `ERROR: ${s.error}` : typeof s.result === "string" ? s.result : safeJson(s.result);
  return `call ${s.call.name}(${truncate(safeJson(s.call.args), maxChars)})\n→ ${truncate(res, maxChars)}`;
}

/** Remove `<think>...</think>` reasoning blocks some local models emit before their answer. */
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "");
}

/** Extract the first top-level JSON array from model text (tolerates prose / code fences). */
export function extractJsonArray(text: string): unknown[] | undefined {
  const start = text.indexOf("[");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) {
      try {
        const v: unknown = JSON.parse(text.slice(start, i + 1));
        return Array.isArray(v) ? v : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Asks a cheap model for the top-k next tool calls given recent history.
 * Output is validated: unknown tools and non-object args are dropped.
 *
 * Security: the prompt contains recent tool arguments and (truncated) results. Use a
 * provider you trust with that data (or a local model via `OpenAICompatibleLLMClient`).
 * Tool results can contain prompt injections that steer predictions; the speculator's
 * safety gate still only executes allowed (read-only, non-open-world) tools.
 */
export class LLMPredictor implements Predictor {
  readonly name = "llm";
  private toolNames: Set<string>;
  constructor(private o: LLMPredictorOptions) {
    this.toolNames = new Set(o.tools.map((t) => t.name));
  }

  /** The user prompt sent to the model (exposed for debugging and tests). */
  buildPrompt(ctx: PredictionContext, k: number): string {
    const maxH = this.o.maxHistory ?? 8;
    const maxC = this.o.maxResultChars ?? 600;
    const tools = this.o.tools
      .map((t) => `- ${t.name}: ${t.description ?? ""}${t.inputSchema ? `\n  input schema: ${JSON.stringify(t.inputSchema)}` : ""}`)
      .join("\n");
    const hist =
      ctx.history
        .slice(-maxH)
        .map((s) => renderStep(s, maxC))
        .join("\n\n") || "(no tool calls yet)";
    const conv = ctx.messages && this.o.renderMessages ? `\n\n## Conversation tail\n${this.o.renderMessages(ctx.messages)}` : "";
    return `## Tools\n${tools}${conv}\n\n## Recent tool calls (oldest first)\n${hist}\n\nPredict the agent's next ${k} most likely tool calls.`;
  }

  async predict(ctx: PredictionContext, k: number): Promise<PredictorResult> {
    const res = await this.o.client.complete({
      system: SYSTEM,
      prompt: this.buildPrompt(ctx, k),
      maxTokens: this.o.maxTokens ?? 400,
      signal: ctx.signal,
    });
    const arr = extractJsonArray(stripReasoning(String(res?.text ?? ""))) ?? [];
    const predictions: Prediction[] = [];
    arr.forEach((x, i) => {
      if (!x || typeof x !== "object") return;
      const { name, args, p } = x as { name?: unknown; args?: unknown; p?: unknown };
      if (typeof name !== "string" || !this.toolNames.has(name)) return;
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) return;
      const score = typeof p === "number" && p >= 0 && p <= 1 ? p : Math.max(0.05, 0.5 / (i + 1));
      predictions.push({ call: { name, args: (args as Record<string, unknown>) ?? {} }, score, source: this.name });
    });
    const u = res?.usage;
    const pr = this.o.pricing;
    const cost = u && pr ? (u.inputTokens * pr.inputPerMTok + u.outputTokens * pr.outputPerMTok) / 1e6 : undefined;
    return { predictions: predictions.slice(0, k), cost };
  }
}
