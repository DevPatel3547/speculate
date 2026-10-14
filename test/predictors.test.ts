import { describe, expect, it } from "vitest";
import { AnthropicLLMClient, type AnthropicMessagesLike } from "../src/predictors/anthropic-client.js";
import { EnsemblePredictor } from "../src/predictors/ensemble.js";
import { extractJsonArray, LLMPredictor, type LLMClient } from "../src/predictors/llm.js";
import { NGramPredictor } from "../src/predictors/ngram.js";
import { definedIdentifiers, pathTokens } from "../src/predictors/tokens.js";
import type { Step, Trace } from "../src/types.js";

function trace(files: string[], sym: string): Trace {
  const grepOut = files.map((f, i) => `${f}:${i + 3}: ${sym}(x)`).join("\n");
  return {
    steps: [
      { call: { name: "list_dir", args: { path: "." } }, result: "README.md\nsrc/\ntest/" },
      { call: { name: "grep", args: { pattern: sym, path: "src" } }, result: grepOut },
      {
        call: { name: "read_file", args: { path: files[0] } },
        result: `export function ${sym}Impl() {}\nexport function helper${sym}() {}`,
      },
      { call: { name: "grep", args: { pattern: `${sym}Impl`, path: files[0] } }, result: `${files[0]}:1: ${sym}Impl` },
    ],
  };
}

describe("token extractors", () => {
  it("extracts paths and defined identifiers", () => {
    expect(pathTokens("src/a.ts:3: foo\nsrc/b.tsx:9: bar\nsrc/a.ts:5")).toEqual(["src/a.ts", "src/b.tsx"]);
    expect(pathTokens({ content: [{ type: "text", text: "see README.md and 1.5" }] })).toEqual(["README.md"]);
    expect(definedIdentifiers("export function foo() {}\nclass Bar {}\nconst baz = async (x) => x")).toEqual(["foo", "Bar", "baz"]);
  });
});

describe("NGramPredictor", () => {
  const train = Array.from({ length: 20 }, (_, i) => trace([`src/m${i}.ts`, `src/n${i}.ts`], `sym${i}`));
  const p = new NGramPredictor().train(train);

  it("predicts the first call from the unigram/start context", () => {
    const [top] = p.predictSync([], 3);
    expect(top.call).toEqual({ name: "list_dir", args: { path: "." } });
  });

  it("templates read_file(path) from the previous grep result", () => {
    const h: Step[] = trace(["src/zzz.ts", "src/yyy.ts"], "NEW").steps.slice(0, 2);
    const [top] = p.predictSync(h, 3);
    expect(top.call).toEqual({ name: "read_file", args: { path: "src/zzz.ts" } });
  });

  it("after read_file(X), predicts grep(symbol defined in X, path=X)", () => {
    const h: Step[] = trace(["src/q.ts"], "Q").steps.slice(0, 3);
    const [top] = p.predictSync(h, 3);
    expect(top.call).toEqual({ name: "grep", args: { pattern: "QImpl", path: "src/q.ts" } });
  });

  it("learns online via observe()", () => {
    const q = new NGramPredictor();
    expect(q.predictSync([], 1)).toEqual([]);
    const steps: Step[] = [];
    for (let i = 0; i < 5; i++) {
      steps.push({ call: { name: "status", args: {} }, result: "ok" }, { call: { name: "log", args: { n: 10 } }, result: "..." });
      q.observe(steps);
    }
    expect(q.predictSync([{ call: { name: "status", args: {} }, result: "ok" }], 1)[0].call).toEqual({ name: "log", args: { n: 10 } });
  });
});

describe("LLMPredictor", () => {
  const tools = [
    { name: "read_file", description: "Read a file" },
    { name: "grep", description: "Search" },
  ];

  it("parses top-k calls, drops unknown tools and bad args, reports cost", async () => {
    let seen: { system: string; prompt: string } | undefined;
    const client: LLMClient = {
      async complete(req) {
        seen = req;
        return {
          text: 'Sure!\n```json\n[{"name":"read_file","args":{"path":"src/a.ts"},"p":0.7},{"name":"rm","args":{}},{"name":"grep","args":"bad"},{"name":"grep","args":{"pattern":"x]","path":"."}}]\n```',
          usage: { inputTokens: 1000, outputTokens: 50 },
        };
      },
    };
    const p = new LLMPredictor({ client, tools, pricing: { inputPerMTok: 1, outputPerMTok: 5 } });
    const r = await p.predict({ history: [{ call: { name: "grep", args: { pattern: "a" } }, result: "src/a.ts:1: a" }] }, 3);
    expect(r.predictions.map((x) => x.call)).toEqual([
      { name: "read_file", args: { path: "src/a.ts" } },
      { name: "grep", args: { pattern: "x]", path: "." } },
    ]);
    expect(r.predictions[0].score).toBe(0.7);
    expect(r.cost).toBeCloseTo((1000 * 1 + 50 * 5) / 1e6);
    expect(seen!.prompt).toContain("src/a.ts:1: a");
    expect(seen!.prompt).toContain("read_file: Read a file");
  });

  it("returns nothing on garbage", async () => {
    const p = new LLMPredictor({ client: { complete: async () => ({ text: "no idea" }) }, tools });
    expect((await p.predict({ history: [] }, 3)).predictions).toEqual([]);
    expect(extractJsonArray("[1, 2")).toBeUndefined();
  });

  it("AnthropicLLMClient maps to messages.create (mocked, no network)", async () => {
    const calls: unknown[] = [];
    const ac = new AbortController();
    const mock: AnthropicMessagesLike = {
      messages: {
        async create(body, options) {
          calls.push({ body, options });
          return {
            content: [{ type: "text", text: '[{"name":"grep","args":{"pattern":"p","path":"."}}]' }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    };
    const client = new AnthropicLLMClient(mock);
    const p = new LLMPredictor({ client, tools });
    const r = await p.predict({ history: [], signal: ac.signal }, 2);
    expect(r.predictions[0].call.name).toBe("grep");
    const { body, options } = calls[0] as { body: Record<string, unknown>; options: { signal: AbortSignal } };
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.max_tokens).toBe(400);
    expect(options.signal).toBe(ac.signal);
  });
});

describe("EnsemblePredictor", () => {
  it("merges by call key with noisy-OR and survives a failing member", async () => {
    const a = { name: "a", predict: async () => ({ predictions: [{ call: { name: "x", args: { k: 1 } }, score: 0.5, source: "a" }] }) };
    const b = {
      name: "b",
      predict: async () => ({ predictions: [{ call: { name: "x", args: { k: 1 } }, score: 0.5, source: "b" }], cost: 0.01 }),
    };
    const c = {
      name: "c",
      predict: async () => {
        throw new Error("down");
      },
    };
    const r = await new EnsemblePredictor([a, b, c]).predict({ history: [] }, 3);
    expect(r.predictions).toHaveLength(1);
    expect(r.predictions[0].score).toBeCloseTo(0.75);
    expect(r.cost).toBe(0.01);
  });
});
