import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/clock.js";
import { Speculator, type SpeculatorOptions } from "../src/speculator.js";
import { customValidator } from "../src/validators/index.js";
import { Rng } from "../bench/sim/rng.js";
import type { ToolCall } from "../src/types.js";
import { makeStore, scripted } from "./helpers.js";

const get = (key: string): ToolCall => ({ name: "get", args: { key } });
const put = (key: string, value: string): ToolCall => ({ name: "put", args: { key, value } });

function setup(predict: (h: number) => ToolCall[], opts: Partial<SpeculatorOptions> = {}, latency = {}) {
  const clock = new VirtualClock();
  const store = makeStore(clock, latency);
  const predictor = scripted((ctx) => predict(ctx.history.length));
  const s = new Speculator({ tools: store.tools, predictor, clock, ...opts });
  return { clock, store, s, predictor };
}

describe("safety: side-effecting tools are never speculated", () => {
  it("refuses put/frobnicate/unknown even when predicted with high confidence", async () => {
    const { clock, store, s } = setup(() => [put("a", "1"), { name: "frobnicate", args: {} }, { name: "rm_rf", args: {} }, get("a")], {
      topK: 10,
      allow: ["read_only", "idempotent", "side_effecting"] as any,
    });
    await clock.run(async () => {
      await s.beginRound();
      await clock.sleep(1000);
      await s.drain();
    });
    expect(store.log.spec).toEqual(['get:{"key":"a"}']);
    expect(store.data.size).toBe(0);
    expect(s.metrics().skippedUnsafe).toBe(2);
  });

  it("randomized: across 2000 random predictions only read_only tools ever execute speculatively", async () => {
    const rng = new Rng(7);
    const names = ["get", "put", "frobnicate", "slow_get", "flaky_get", "nope"];
    const { clock, store, s } = setup(
      () => Array.from({ length: 5 }, () => ({ name: rng.pick(names), args: { key: String(rng.int(3)), value: "v" } })),
      { topK: 5, maxConcurrency: 8, timeoutMs: 500 },
    );
    await clock.run(async () => {
      for (let i = 0; i < 400; i++) {
        void s.beginRound();
        await clock.sleep(50);
        if (rng.chance(0.3)) await s.call(put(String(rng.int(3)), `v${i}`));
        else await s.call(get(String(rng.int(3))));
      }
      s.close();
    });
    expect(store.log.spec.length).toBeGreaterThan(100);
    for (const e of store.log.spec) expect(e).toMatch(/^(get|slow_get|flaky_get):/);
    expect(store.log.spec.some((e) => e.startsWith("put") || e.startsWith("frobnicate"))).toBe(false);
  });
});

describe("hits", () => {
  it("serves a completed speculative result without re-executing", async () => {
    const { clock, store, s } = setup(() => [get("a")]);
    store.data.set("a", "A");
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(500); // model thinks longer than get takes (100ms)
      const t0 = clock.now();
      expect(await s.call(get("a"))).toBe("A");
      expect(clock.now() - t0).toBe(0); // instant
    });
    expect(store.log.real).toEqual([]);
    expect(store.log.spec).toEqual(['get:{"key":"a"}']);
    const m = s.metrics();
    expect(m.hits).toBe(1);
    expect(m.latencySavedMs).toBe(100);
  });

  it("joins an in-flight speculation (partial saving)", async () => {
    const { clock, store, s } = setup(() => [get("a")], {}, { get: 1000 });
    store.data.set("a", "A");
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(400);
      const t0 = clock.now();
      expect(await s.call(get("a"))).toBe("A");
      expect(clock.now() - t0).toBe(600);
    });
    expect(s.metrics().joins).toBe(1);
    expect(s.metrics().latencySavedMs).toBe(400);
    expect(store.log.real).toEqual([]);
  });

  it("arg key order does not matter (canonical JSON)", async () => {
    const { clock, s } = setup(() => [{ name: "get", args: { key: "a", opt: { y: 1, x: 2 } } }]);
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(500);
      await s.call({ name: "get", args: { opt: { x: 2, y: 1 }, key: "a" } });
    });
    expect(s.metrics().hits).toBe(1);
  });
});

describe("staleness", () => {
  it("a real write invalidates speculative reads (epoch)", async () => {
    const { clock, store, s } = setup((n) => (n === 0 ? [get("a")] : []));
    store.data.set("a", "old");
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(500); // speculative get(a) = "old" is cached
      await s.call(put("a", "new"));
      expect(await s.call(get("a"))).toBe("new");
    });
    expect(s.metrics().hits).toBe(0);
    expect(s.metrics().wasted).toBe(1);
  });

  it("a speculative read in flight during a real write is aborted and never served", async () => {
    const { clock, store, s } = setup((n) => (n === 0 ? [get("a")] : []), {}, { get: 1000, put: 10 });
    store.data.set("a", "old");
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(100);
      await s.call(put("a", "new")); // spec get still running
      expect(await s.call(get("a"))).toBe("new");
    });
    expect(store.log.abortedSpec).toEqual(['get:{"key":"a"}']);
    expect(s.metrics().aborted).toBe(1);
  });

  it("validator detects an external change and forces re-execution", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock);
    let version = 0;
    const s = new Speculator({
      tools: store.tools,
      predictor: scripted(() => [get("a")]),
      clock,
      validators: [customValidator(() => `v${version}`)],
    });
    store.data.set("a", "old");
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(500);
      // someone else (not the agent) changes the store
      store.data.set("a", "external");
      version++;
      expect(await s.call(get("a"))).toBe("external");
    });
    expect(s.metrics().staleRejected).toBe(1);
    expect(store.log.real).toEqual(['get:{"key":"a"}']);
  });

  it("results older than maxAgeMs are re-executed", async () => {
    const { clock, store, s } = setup(() => [get("a")], { maxAgeMs: 1000 });
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(5000);
      await s.call(get("a"));
    });
    expect(store.log.real.length).toBe(1);
    expect(s.metrics().hits).toBe(0);
  });
});

describe("cancellation", () => {
  it("a new round aborts unconsumed in-flight speculations via AbortSignal", async () => {
    const { clock, store, s } = setup((n) => (n === 0 ? [{ name: "slow_get", args: { key: "a" } }] : [get("b")]));
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(100);
      await s.call(get("x")); // model went elsewhere
      void s.beginRound();
      await clock.sleep(100);
    });
    expect(store.log.abortedSpec).toEqual(['slow_get:{"key":"a"}']);
    const m = s.metrics();
    expect(m.aborted).toBe(1);
    expect(m.wasted).toBe(1);
  });

  it("close() aborts everything in flight", async () => {
    const { clock, store, s } = setup(() => [
      { name: "slow_get", args: { key: "a" } },
      { name: "slow_get", args: { key: "b" } },
    ]);
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(10);
      s.close();
      await clock.sleep(10);
    });
    expect(store.log.abortedSpec.length).toBe(2);
  });

  it("the speculative timeout aborts slow executions; the real call still works", async () => {
    const { clock, store, s } = setup(() => [{ name: "slow_get", args: { key: "a" } }], { timeoutMs: 2000 });
    store.data.set("a", "A");
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(3000);
      expect(await s.call({ name: "slow_get", args: { key: "a" } })).toBe("A");
    });
    expect(s.metrics().timeouts).toBe(1);
    expect(store.log.real.length).toBe(1);
  });

  it("a joined speculation is not killed by its timeout", async () => {
    const { clock, store, s } = setup(() => [{ name: "slow_get", args: { key: "a" } }], { timeoutMs: 2000 });
    store.data.set("a", "A");
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(1000);
      expect(await s.call({ name: "slow_get", args: { key: "a" } })).toBe("A");
    });
    expect(s.metrics().joins).toBe(1);
    expect(store.log.real.length).toBe(0);
  });
});

describe("staged predictors", () => {
  it("a fast predictor stage launches without waiting for a slow (LLM-like) stage", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock, { get: 100 });
    const fast = scripted(() => [get("a")]);
    const slow = scripted(() => [get("b")], 2000, clock);
    const s = new Speculator({ tools: store.tools, predictor: [fast, slow], clock });
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(500);
      expect(await s.call(get("a"))).toBe(null); // already done thanks to the fast stage
      expect(slow.calls).toBe(1);
    });
    expect(s.metrics().hits).toBe(1);
    expect(store.log.spec).toEqual(['get:{"key":"a"}']); // slow stage was cancelled by the real call
  });
});

describe("budget and concurrency", () => {
  it("maxTotal caps speculative spend across rounds", async () => {
    let i = 0;
    const { clock, store, s } = setup(() => [get(`k${i++}`), get(`k${i++}`)], { budget: { maxTotal: 3 } });
    await clock.run(async () => {
      for (let r = 0; r < 5; r++) {
        await s.beginRound();
        await clock.sleep(200);
        await s.call(get("z"));
      }
    });
    expect(store.log.spec.length).toBe(3);
    expect(s.metrics().speculativeSpend).toBe(3);
    expect(s.metrics().skippedBudget).toBeGreaterThan(0);
  });

  it("maxPerRound and costOf are respected", async () => {
    const { clock, store, s } = setup(() => [get("a"), get("b"), get("c"), get("d")], {
      topK: 4,
      budget: { maxPerRound: 5, costOf: (c) => (c.args.key === "a" ? 4 : 1) },
    });
    await clock.run(async () => {
      await s.beginRound();
      await clock.sleep(200);
    });
    expect(store.log.spec.sort()).toEqual(['get:{"key":"a"}', 'get:{"key":"b"}']);
  });

  it("never runs more than maxConcurrency speculative executions at once", async () => {
    const { clock, store, s } = setup(() => ["a", "b", "c", "d", "e", "f"].map(get), { topK: 6, maxConcurrency: 2 });
    await clock.run(async () => {
      await s.beginRound();
      await clock.sleep(1000);
    });
    expect(store.log.spec.length).toBe(6);
    expect(store.log.maxConcurrentSpec).toBe(2);
  });

  it("a real call never waits behind the speculative queue", async () => {
    const { clock, store, s } = setup(() => ["a", "b", "c"].map(get), { topK: 3, maxConcurrency: 1 }, { get: 1000 });
    await clock.run(async () => {
      await s.beginRound();
      await clock.sleep(10);
      const t0 = clock.now();
      await s.call(get("c")); // queued behind a, b: executed directly instead
      expect(clock.now() - t0).toBe(1000);
    });
    expect(store.log.real).toEqual(['get:{"key":"c"}']);
  });
});

describe("failures are invisible", () => {
  it("a failing speculative execution falls back to the real call, which fails identically", async () => {
    const { clock, store, s } = setup(() => [{ name: "flaky_get", args: { key: "a" } }]);
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(100);
      await expect(s.call({ name: "flaky_get", args: { key: "a" } })).rejects.toThrow("flaky_get failed for a");
    });
    expect(store.log.real.length).toBe(1);
  });

  it("acceptResult can refuse caching a result", async () => {
    const { clock, store, s } = setup(() => [get("a")], { acceptResult: () => false });
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(500);
      await s.call(get("a"));
    });
    expect(store.log.real.length).toBe(1);
    expect(s.metrics().hits).toBe(0);
  });

  it("a throwing predictor never breaks the agent", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock);
    const s = new Speculator({
      tools: store.tools,
      clock,
      predictor: {
        name: "bad",
        predict: async () => {
          throw new Error("boom");
        },
      },
    });
    await clock.run(async () => {
      await s.beginRound();
      expect(await s.call(get("a"))).toBe(null);
    });
    expect(s.metrics().predictorErrors).toBe(1);
  });
});

describe("lossless: identical results with and without speculation", () => {
  async function runScript(seed: number, speculate: boolean) {
    const clock = new VirtualClock();
    const store = makeStore(clock, { get: 120, put: 40 });
    const rng = new Rng(seed);
    // the "agent" plan is fixed up front; predictions are random (often wrong, sometimes right)
    const plan: ToolCall[][] = Array.from({ length: 60 }, () =>
      Array.from({ length: 1 + rng.int(2) }, () => (rng.chance(0.3) ? put(`k${rng.int(4)}`, `v${rng.int(100)}`) : get(`k${rng.int(4)}`))),
    );
    const predRng = new Rng(seed + 1);
    let turn = 0;
    const s = speculate
      ? new Speculator({
          tools: store.tools,
          clock,
          topK: 3,
          predictor: scripted(() => [...plan[turn].filter(() => predRng.chance(0.6)), get(`k${predRng.int(4)}`), put("k0", "evil")]),
        })
      : undefined;
    const out: string[] = [];
    await clock.run(async () => {
      for (turn = 0; turn < plan.length; turn++) {
        if (s) void s.beginRound();
        await clock.sleep(predRng.int(300)); // think
        for (const c of plan[turn]) {
          const r = s
            ? await s.call(c)
            : await store.tools[c.name].handler(c.args, { signal: new AbortController().signal, speculative: false });
          out.push(`${c.name}${JSON.stringify(c.args)}=${JSON.stringify(r)}`);
        }
      }
      s?.close();
    });
    return { out, data: JSON.stringify([...store.data].sort()), m: s?.metrics(), time: clock.now() };
  }

  it("matches the non-speculative run across 25 random scripts", async () => {
    let hits = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const a = await runScript(seed, false);
      const b = await runScript(seed, true);
      expect(b.out).toEqual(a.out);
      expect(b.data).toEqual(a.data);
      expect(b.time).toBeLessThanOrEqual(a.time);
      hits += b.m!.hits + b.m!.joins;
    }
    expect(hits).toBeGreaterThan(50); // speculation actually did something
  });
});
