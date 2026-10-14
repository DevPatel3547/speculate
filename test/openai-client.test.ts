/**
 * OpenAI-compatible LLM client, tested against a local mock HTTP server that speaks the
 * Chat Completions API the way Ollama / llama.cpp do. No network, no API keys.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VirtualClock } from "../src/clock.js";
import { LLMPredictor, stripReasoning } from "../src/predictors/llm.js";
import { OpenAICompatibleLLMClient } from "../src/predictors/openai-compatible.js";
import { Speculator } from "../src/speculator.js";
import { makeStore } from "./helpers.js";

type Handler = (body: Record<string, unknown>, req: IncomingMessage) => { status?: number; body: unknown; delayMs?: number };
let handler: Handler = () => ({ body: {} });
const requests: { body: Record<string, unknown>; headers: IncomingMessage["headers"]; url?: string }[] = [];
let server: Server;
let baseURL = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      requests.push({ body, headers: req.headers, url: req.url });
      const out = handler(body, req);
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(out.status ?? 200, { "content-type": "application/json" });
        res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body));
      };
      if (out.delayMs) setTimeout(send, out.delayMs);
      else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const completion = (content: string, usage = { prompt_tokens: 120, completion_tokens: 30 }) => ({
  id: "x",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage,
});

describe("OpenAICompatibleLLMClient", () => {
  it("POSTs a chat completion and returns text + usage", async () => {
    handler = () => ({ body: completion("hello") });
    requests.length = 0;
    const c = new OpenAICompatibleLLMClient({
      baseURL: baseURL + "/",
      model: "qwen2.5-coder:7b",
      apiKey: "local-key",
      extraBody: { options: { num_ctx: 4096 } },
    });
    const r = await c.complete({ system: "sys", prompt: "user prompt", maxTokens: 77 });
    expect(r).toEqual({ text: "hello", usage: { inputTokens: 120, outputTokens: 30 } });
    const req = requests[0];
    expect(req.url).toBe("/v1/chat/completions");
    expect(req.body).toMatchObject({
      model: "qwen2.5-coder:7b",
      max_tokens: 77,
      temperature: 0,
      stream: false,
      options: { num_ctx: 4096 },
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "user prompt" },
      ],
    });
    expect(req.headers.authorization).toBe("Bearer local-key");
  });

  it("drives LLMPredictor end to end (including <think> blocks from reasoning models)", async () => {
    handler = () => ({
      body: completion(
        '<think>maybe [read the] file first</think>\n```json\n[{"name":"read_file","args":{"path":"src/a.ts"},"p":0.8}]\n```',
      ),
    });
    const llm = new LLMPredictor({
      client: new OpenAICompatibleLLMClient({ baseURL, model: "m" }),
      tools: [{ name: "read_file", description: "Read a file" }],
    });
    const r = await llm.predict({ history: [{ call: { name: "grep", args: { pattern: "x" } }, result: "src/a.ts:1: x" }] }, 3);
    expect(r.predictions).toEqual([{ call: { name: "read_file", args: { path: "src/a.ts" } }, score: 0.8, source: "llm" }]);
    expect(r.cost).toBeUndefined(); // no pricing configured: local models are free
  });

  it("runs as a Speculator stage against the local server", async () => {
    handler = () => ({ body: completion('[{"name":"get","args":{"key":"a"}},{"name":"put","args":{"key":"a","value":"evil"}}]') });
    const clock = new VirtualClock();
    const store = makeStore(clock);
    const llm = new LLMPredictor({
      client: new OpenAICompatibleLLMClient({ baseURL, model: "m" }),
      tools: Object.values(store.tools).map((t) => t.spec),
    });
    const s = new Speculator({ tools: store.tools, predictor: llm, clock });
    // real HTTP happens outside the virtual clock: await the round first
    await s.beginRound();
    await clock.run(async () => {
      await clock.sleep(500);
      await s.call({ name: "get", args: { key: "a" } });
    });
    expect(s.metrics().hits).toBe(1);
    expect(store.log.spec).toEqual(['get:{"key":"a"}']); // the predicted put was refused
  });

  it("throws on HTTP errors without leaking the API key", async () => {
    handler = () => ({ status: 404, body: { error: { message: "model 'nope' not found, try pulling it first" } } });
    const c = new OpenAICompatibleLLMClient({ baseURL, model: "nope", apiKey: "sk-should-not-leak" });
    const err = await c.complete({ system: "s", prompt: "p", maxTokens: 5 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/HTTP 404.*not found/);
    expect((err as Error).message).not.toContain("sk-should-not-leak");
  });

  it("throws on non-JSON bodies and empty choices", async () => {
    const c = new OpenAICompatibleLLMClient({ baseURL, model: "m" });
    handler = () => ({ body: "<html>oops</html>" });
    await expect(c.complete({ system: "s", prompt: "p", maxTokens: 5 })).rejects.toThrow(/non-JSON/);
    handler = () => ({ body: { choices: [] } });
    await expect(c.complete({ system: "s", prompt: "p", maxTokens: 5 })).rejects.toThrow(/no choices/);
  });

  it("times out slow servers and honours the caller's AbortSignal", async () => {
    handler = () => ({ body: completion("late"), delayMs: 500 });
    const c = new OpenAICompatibleLLMClient({ baseURL, model: "m", timeoutMs: 50 });
    await expect(c.complete({ system: "s", prompt: "p", maxTokens: 5 })).rejects.toMatchObject({ name: "TimeoutError" });
    const ac = new AbortController();
    const c2 = new OpenAICompatibleLLMClient({ baseURL, model: "m" });
    const p = c2.complete({ system: "s", prompt: "p", maxTokens: 5, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    const pre = new AbortController();
    pre.abort();
    await expect(c2.complete({ system: "s", prompt: "p", maxTokens: 5, signal: pre.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports connection failures clearly", async () => {
    const c = new OpenAICompatibleLLMClient({ baseURL: "http://127.0.0.1:9/v1", model: "m", timeoutMs: 2000 });
    await expect(c.complete({ system: "s", prompt: "p", maxTokens: 5 })).rejects.toThrow(/failed/);
  });

  it("supports an injected fetch and validates options", async () => {
    const seen: string[] = [];
    const c = new OpenAICompatibleLLMClient({
      model: "m",
      responseFormat: { type: "json_object" },
      fetch: async (url, init) => {
        seen.push(url, init.body);
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: null } }] }) };
      },
    });
    expect(await c.complete({ system: "s", prompt: "p", maxTokens: 5 })).toEqual({ text: "", usage: undefined });
    expect(seen[0]).toBe("http://localhost:11434/v1/chat/completions"); // Ollama default
    expect(JSON.parse(seen[1]).response_format).toEqual({ type: "json_object" });
    expect(() => new OpenAICompatibleLLMClient({ model: "" })).toThrow(TypeError);
  });
});

describe("stripReasoning", () => {
  it("removes complete and dangling think blocks", () => {
    expect(stripReasoning("<think>a [b]</think>[1]")).toBe("[1]");
    expect(stripReasoning("reasoning [x] </think> [2]")).toBe(" [2]");
    expect(stripReasoning("[3]")).toBe("[3]");
  });
});
