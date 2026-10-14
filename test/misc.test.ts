import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderAnthropicMessages, runAnthropicToolLoop, type AnthropicToolLoopClient } from "../src/adapters/anthropic.js";
import { createSpeculativeSdkTools } from "../src/adapters/agent-sdk.js";
import { scaledClock, VirtualClock } from "../src/clock.js";
import { raceAbort, Semaphore, withTimeout } from "../src/executor.js";
import { approxBytes } from "../src/internal/size.js";
import { eligibleHitRate, emptyMetrics, hitRate, mergeMetrics, precision } from "../src/metrics.js";
import { EnsemblePredictor } from "../src/predictors/ensemble.js";
import { Speculator } from "../src/speculator.js";
import { fsValidator } from "../src/validators/index.js";
import type { ToolRegistry } from "../src/types.js";
import { scripted } from "./helpers.js";

describe("metrics helpers", () => {
  it("rates and merge", () => {
    const m = { ...emptyMetrics(), realCalls: 10, eligibleCalls: 5, hits: 2, joins: 1, launched: 6 };
    expect(hitRate(m)).toBeCloseTo(0.3);
    expect(eligibleHitRate(m)).toBeCloseTo(0.6);
    expect(precision(m)).toBeCloseTo(0.5);
    expect(hitRate(emptyMetrics()) + eligibleHitRate(emptyMetrics()) + precision(emptyMetrics())).toBe(0);
    expect(mergeMetrics(m, m).hits).toBe(4);
  });
});

describe("approxBytes", () => {
  it("estimates common shapes and stops at the cap", () => {
    expect(approxBytes("abcd")).toBe(8);
    expect(approxBytes(Buffer.alloc(100))).toBe(100);
    expect(approxBytes(new ArrayBuffer(64))).toBe(64);
    expect(approxBytes({ a: 1, b: true, c: 10n, d: null, e: undefined, f: () => 1 })).toBeGreaterThan(16);
    expect(approxBytes(new Map([["k", "v"]]))).toBeGreaterThan(16);
    expect(approxBytes(new Set(["x"]))).toBeGreaterThan(16);
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    expect(approxBytes(circ)).toBeLessThan(100);
    expect(
      approxBytes(
        Array.from({ length: 1e5 }, () => "xxxxxxxx"),
        1000,
      ),
    ).toBeLessThan(2000);
  });
});

describe("executor primitives", () => {
  it("Semaphore: queued acquire can be aborted; capacity validated", async () => {
    const s = new Semaphore(1);
    await s.acquire();
    const ac = new AbortController();
    const p = s.acquire(ac.signal);
    expect(s.waiting).toBe(1);
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(s.waiting).toBe(0);
    s.release();
    expect(s.inUse).toBe(0);
    await expect(s.acquire(ac.signal)).rejects.toThrow();
    expect(() => new Semaphore(0)).toThrow();
  });

  it("raceAbort / withTimeout", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(raceAbort(Promise.resolve(1), ac.signal)).rejects.toThrow();
    await expect(raceAbort(Promise.reject(new Error("x")), new AbortController().signal)).rejects.toThrow("x");
    const clock = new VirtualClock();
    await clock.run(async () => {
      await expect(withTimeout(new Promise(() => {}), 10, clock, undefined, "op")).rejects.toThrow("op timed out after 10ms");
      expect(await withTimeout(Promise.resolve(5), 10, clock, undefined, "op")).toBe(5);
    });
  });

  it("scaledClock reports unscaled time", async () => {
    const c = scaledClock(0.01);
    const t0 = c.now();
    await c.sleep(1000);
    expect(c.now() - t0).toBeGreaterThanOrEqual(900);
  });

  it("VirtualClock reports deadlocks and rethrows failures", async () => {
    const c = new VirtualClock();
    await expect(c.run(() => new Promise(() => {}))).rejects.toThrow(/deadlock/);
    await expect(c.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    const ac = new AbortController();
    ac.abort();
    await expect(c.sleep(5, ac.signal)).rejects.toThrow();
  });
});

describe("fsValidator hardening", () => {
  it("never reads special files (would hang / read forever with hash: true)", async () => {
    const v = fsValidator({ root: "/", hash: true });
    const fp = await v.snapshot({ name: "read_file", args: { path: "/dev/zero" } });
    expect(fp).toMatch(/^path=s:/);
  });

  it.skipIf(process.platform === "win32")("a FIFO is fingerprinted without opening it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-fifo-"));
    try {
      execFileSync("mkfifo", [join(dir, "pipe")]);
      const v = fsValidator({ root: dir, hash: true });
      expect(await v.snapshot({ name: "read_file", args: { path: "pipe" } })).toMatch(/^path=s:/);
      expect(await v.snapshot({ name: "grep", args: { dir: "." } })).toMatch(/^dir=d:/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("large files are not hashed; missing paths and tool filters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-big-"));
    try {
      await writeFile(join(dir, "big"), Buffer.alloc(2048));
      const v = fsValidator({ root: dir, hash: true, maxHashBytes: 1024, tools: ["read_file"] });
      expect(await v.snapshot({ name: "read_file", args: { path: "big" } })).toMatch(/^path=f:[\d.]+:2048$/);
      expect(await v.snapshot({ name: "read_file", args: { path: "nope" } })).toBe("path=missing");
      expect(await v.snapshot({ name: "other", args: { path: "big" } })).toBeUndefined();
      const walk = fsValidator({ root: dir, maxEntries: 0 });
      expect(await walk.snapshot({ name: "ls", args: { path: "." } })).toMatch(/^path=d:/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Anthropic tool loop robustness", () => {
  const tools = (log: string[]): ToolRegistry => ({
    read_x: {
      spec: { name: "read_x", description: "Read x." },
      handler: async (_a, c) => {
        log.push(c.speculative ? "spec" : "real");
        await new Promise((r) => setTimeout(r, 200));
        return { x: 1 };
      },
    },
  });

  it("aborts in-flight speculation when messages.create throws, and leaves the speculator usable", async () => {
    const log: string[] = [];
    const t = tools(log);
    const speculator = new Speculator({ tools: t, predictor: scripted(() => [{ name: "read_x", args: {} }]) });
    const client: AnthropicToolLoopClient = {
      messages: {
        create: async () => {
          await new Promise((r) => setTimeout(r, 20));
          throw new Error("overloaded");
        },
      },
    };
    await expect(
      runAnthropicToolLoop({ client, model: "m", messages: [{ role: "user", content: "hi" }], tools: t, speculator }),
    ).rejects.toThrow("overloaded");
    expect(speculator.metrics().aborted).toBe(1); // 0.1.0 left it running
    expect(speculator.closed).toBe(false); // 0.1.0 permanently closed the caller's speculator
  });

  it("works without a speculator, reports unknown tools and non-JSON results as tool errors/strings", async () => {
    const log: string[] = [];
    const t = tools(log);
    let i = 0;
    const client: AnthropicToolLoopClient = {
      messages: {
        create: async () =>
          i++ === 0
            ? {
                stop_reason: "tool_use",
                content: [
                  { type: "tool_use", id: "1", name: "read_x", input: {} },
                  { type: "tool_use", id: "2", name: "nope", input: {} },
                  { type: "text", text: "thinking" },
                ],
              }
            : { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
      },
    };
    const r = await runAnthropicToolLoop({
      client,
      model: "m",
      system: "s",
      messages: [{ role: "user", content: "go" }],
      tools: t,
      maxTurns: 3,
    });
    const results = r.messages[2].content as { content: string; is_error?: boolean }[];
    expect(results[0].content).toBe('{"x":1}');
    expect(results[1]).toMatchObject({ is_error: true, content: "Unknown tool: nope" });
    expect(r.stopReason).toBe("end_turn");
    const text = renderAnthropicMessages(r.messages, 60);
    expect(text.length).toBeLessThanOrEqual(60);
    expect(renderAnthropicMessages([{ role: "user", content: "plain" }])).toBe("user: plain");
  });
});

describe("Agent SDK adapter edge cases", () => {
  it("prototype-named tools are not treated as ours; PostToolUse can start rounds", async () => {
    const def = { name: "get_doc", description: "Get a doc", handler: async () => ({ content: [] }) };
    const p = scripted(() => []);
    const { hooks, speculator } = createSpeculativeSdkTools([def], { serverName: "kb", predictor: p, usePostToolBatch: false });
    const ac = { signal: new AbortController().signal };
    const inv = speculator.metrics().invalidations;
    await hooks.PreToolUse![0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: "mcp__kb__constructor" }, "u", ac);
    expect(speculator.metrics().invalidations).toBe(inv + 1); // 0.1.0: `in` matched Object.prototype
    await hooks.PostToolUse![0].hooks[0]({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} }, "u", ac);
    await speculator.drain();
    expect(p.calls).toBe(1);
    expect(hooks.PostToolBatch).toBeUndefined();
    expect(await hooks.PreToolUse![0].hooks[0]({ hook_event_name: "Other" }, "u", ac)).toEqual({});
  });
});

describe("EnsemblePredictor", () => {
  it("forwards observe() and skips uncacheable predictions", async () => {
    let observed = 0;
    const a = {
      name: "a",
      predict: async () => ({ predictions: [{ call: { name: "x", args: { d: new Date(0) } }, score: 0.9, source: "a" }] }),
      observe: () => void observed++,
    };
    const e = new EnsemblePredictor([a]);
    e.observe([]);
    expect(observed).toBe(1);
    expect((await e.predict({ history: [] }, 3)).predictions).toEqual([]);
  });
});
