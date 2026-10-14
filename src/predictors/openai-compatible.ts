import type { LLMClient } from "./llm.js";

/** Minimal `fetch` signature (the global `fetch` of Node 18+ satisfies it). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Options for {@link OpenAICompatibleLLMClient}. */
export interface OpenAICompatibleOptions {
  /**
   * Base URL of an OpenAI-compatible API, including the version prefix.
   * Ollama: `http://localhost:11434/v1` · llama.cpp server: `http://localhost:8080/v1`
   * · vLLM: `http://localhost:8000/v1`. Default: `http://localhost:11434/v1`.
   */
  baseURL?: string;
  /** Model name as the server knows it (e.g. `qwen2.5-coder:7b`). Required. */
  model: string;
  /** Sent as `Authorization: Bearer <apiKey>` if set. Local servers usually need none. */
  apiKey?: string;
  /** Sampling temperature. Default 0 (deterministic predictions). */
  temperature?: number;
  /** Abort the HTTP request after this many ms. Default 10 000. */
  timeoutMs?: number;
  /** Ask the server for JSON output (`response_format`). Off by default: we request an array, not an object. */
  responseFormat?: { type: "json_object" };
  /** Extra headers. */
  headers?: Record<string, string>;
  /** Extra body fields (e.g. `{ options: { num_ctx: 8192 } }` for Ollama). */
  extraBody?: Record<string, unknown>;
  /** Custom fetch (tests, proxies). Default: global `fetch`. */
  fetch?: FetchLike;
}

interface ChatCompletion {
  choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * {@link LLMClient} for any server speaking the OpenAI Chat Completions API
 * (`POST {baseURL}/chat/completions`): Ollama, llama.cpp `llama-server`, vLLM,
 * LM Studio, LocalAI, and hosted OpenAI-compatible providers. Lets the
 * `LLMPredictor` run on a free local model:
 *
 * ```ts
 * const client = new OpenAICompatibleLLMClient({ model: "qwen2.5-coder:7b" }); // Ollama default URL
 * const llm = new LLMPredictor({ client, tools: specs });
 * ```
 *
 * Errors (non-2xx, malformed JSON, timeouts) are thrown; the Speculator treats a
 * throwing predictor as "no predictions" and the agent is unaffected. The API key is
 * never included in error messages.
 */
export class OpenAICompatibleLLMClient implements LLMClient {
  private readonly url: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    if (!opts?.model) throw new TypeError("OpenAICompatibleLLMClient: options.model is required");
    const base = (opts.baseURL ?? "http://localhost:11434/v1").replace(/\/+$/, "");
    this.url = `${base}/chat/completions`;
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new TypeError("OpenAICompatibleLLMClient: no fetch implementation available (Node >= 18 required)");
    this.fetchImpl = f;
  }

  async complete(req: { system: string; prompt: string; maxTokens: number; signal?: AbortSignal }) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("timeout")), this.opts.timeoutMs ?? 10_000);
    const onAbort = () => timeout.abort(req.signal?.reason);
    if (req.signal?.aborted) onAbort();
    else req.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const body = {
        model: this.opts.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.prompt },
        ],
        max_tokens: req.maxTokens,
        temperature: this.opts.temperature ?? 0,
        stream: false,
        ...(this.opts.responseFormat ? { response_format: this.opts.responseFormat } : {}),
        ...(this.opts.extraBody ?? {}),
      };
      const headers: Record<string, string> = { "content-type": "application/json", ...(this.opts.headers ?? {}) };
      if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.fetchImpl(this.url, { method: "POST", headers, body: JSON.stringify(body), signal: timeout.signal });
      } catch (e) {
        if (timeout.signal.aborted) {
          const err = new Error(
            req.signal?.aborted ? "LLM request aborted" : `LLM request timed out after ${this.opts.timeoutMs ?? 10_000}ms`,
          );
          err.name = req.signal?.aborted ? "AbortError" : "TimeoutError";
          throw err;
        }
        throw new Error(`LLM request to ${this.url} failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`LLM server ${this.url} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
      let json: ChatCompletion;
      try {
        json = JSON.parse(text) as ChatCompletion;
      } catch {
        throw new Error(`LLM server ${this.url} returned non-JSON: ${text.slice(0, 200)}`);
      }
      const msg = json.choices?.[0]?.message;
      if (!msg) throw new Error(`LLM server ${this.url} returned no choices`);
      const u = json.usage;
      return {
        text: msg.content ?? "",
        usage:
          u && typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number"
            ? { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens }
            : undefined,
      };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    }
  }
}
