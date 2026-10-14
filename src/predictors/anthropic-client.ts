import type { LLMClient } from "./llm.js";

/**
 * The subset of the `@anthropic-ai/sdk` client we use. A real `new Anthropic()`
 * satisfies this structurally; tests pass a mock.
 */
export interface AnthropicMessagesLike {
  messages: {
    create(
      body: {
        model: string;
        max_tokens: number;
        system?: string;
        messages: { role: "user" | "assistant"; content: unknown }[];
        [k: string]: unknown;
      },
      options?: { signal?: AbortSignal | null },
    ): PromiseLike<{
      content: ({ type: string; text?: string } & Record<string, unknown>)[];
      usage?: { input_tokens: number; output_tokens: number } | null;
    }>;
  };
}

export interface AnthropicLLMClientOptions {
  /** Cheap/fast model for prediction. Default: "claude-haiku-5-5". */
  model?: string;
  temperature?: number;
}

/** LLMClient backed by the Anthropic Messages API. */
export class AnthropicLLMClient implements LLMClient {
  constructor(
    private client: AnthropicMessagesLike,
    private opts: AnthropicLLMClientOptions = {},
  ) {}

  async complete(req: { system: string; prompt: string; maxTokens: number; signal?: AbortSignal }) {
    const res = await this.client.messages.create(
      {
        model: this.opts.model ?? "claude-haiku-5-5",
        max_tokens: req.maxTokens,
        system: req.system,
        ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
        messages: [{ role: "user", content: req.prompt }],
      },
      { signal: req.signal },
    );
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    return {
      text,
      usage: res.usage ? { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } : undefined,
    };
  }
}
