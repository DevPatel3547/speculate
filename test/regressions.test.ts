/**
 * Regression tests for defects found in the 1.0 code review. Each test fails on 0.1.0.
 */
import { describe, expect, it } from "vitest";
import { canonicalJson, callKey, pathNormalizer, tryCallKey, UncacheableArgsError } from "../src/canonical.js";
import { classifyTool } from "../src/classifier.js";
import { realClock, VirtualClock } from "../src/clock.js";
import { NGramPredictor } from "../src/predictors/ngram.js";
import { Speculator, type SpeculationEvent } from "../src/speculator.js";
import { speculate } from "../src/speculate.js";
import { customValidator } from "../src/validators/index.js";
import type { Predictor } from "../src/predictors/types.js";
import type { Step, ToolCall, ToolRegistry } from "../src/types.js";
import { makeStore, scripted } from "./helpers.js";

const get = (key: string): ToolCall => ({ name: "get", args: { key } });
const put = (key: string, value: string): ToolCall => ({ name: "put", args: { key, value } });

describe("a misbehaving predictor or hook can never break a real call", () => {
  it("observe() throwing does not turn a successful (side-effecting) call into an error", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock);
    const bad: Predictor = {
      name: "bad",
      predict: async () => ({ predictions: [] }),
      observe: () => {
        throw new Error("observe exploded");
      },
    };
    const s = new Speculator({ tools: store.tools, predictor: bad, clock });
    await clock.run(async () => {
      expect(await s.call(put("a", "1"))).toBe("ok"); // 0.1.0: threw after the write happened
    });
    expect(store.log.real).toEqual(['put:{"key":"a","value":"1"}']);
    expect(s.metrics().internalErrors).toBe(1);
  });

  it("malformed predictions are dropped instead of crashing the process (unhandled rejection)", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock);
    const garbage = {
      name: "garbage",
      predict: async () => ({
        predictions: [
          null,
          { score: 1 },
          { call: { name: 7 }, score: 1 },
          { call: get("a"), score: Number.NaN },
          { call: { name: "get", args: [1] }, score: 1 },
          { call: get("b"), score: 0.9 },
        ],
      }),
    } as unknown as Predictor;
    const s = new Speculator({ tools: store.tools, predictor: garbage, clock });
    await clock.run(async () => {
      await s.beginRound(); // 0.1.0: TypeError inside launchAll -> rejected promise nobody handled
      await clock.sleep(500);
    });
    expect(store.log.spec).toEqual(['get:{"key":"b"}']);
    expect(s.metrics().internalErrors).toBe(1);
  });

  it("a predictor returning a non-object is tolerated", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock);
    const s = new Speculator({
      tools: store.tools,
      predictor: { name: "u", predict: async () => undefined } as unknown as Predictor,
      clock,
    });
    await clock.run(async () => {
      await s.beginRound();
      expect(await s.call(get("a"))).toBe(null);
    });
  });

  it("onEvent, logger, telemetry, costOf and normalizeArgs throwing are all contained", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock);
    const boom = () => {
      throw new Error("boom");
    };
    const s = new Speculator({
      tools: store.tools,
      clock,
      predictor: scripted(() => [get("a"), get("b")]),
      onEvent: boom,
      logger: { debug: boom, info: boom, warn: boom, error: boom },
      telemetry: { counter: boom, histogram: boom },
      budget: { costOf: (c) => (c.args.key === "a" ? boom() : 1) },
      normalizeArgs: { put: boom },
    });
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(500);
      expect(await s.call(put("x", "1"))).toBe("ok"); // invalidate() emits events
      expect(await s.call(get("x"))).toBe("1");
    });
    expect(store.log.spec).toEqual(['get:{"key":"b"}']); // costOf threw for "a"
    expect(s.metrics().internalErrors).toBeGreaterThan(0);
  });
});

describe("cache keys are exact (no false hits) and never break real calls", () => {
  it("rejects non-JSON values instead of collapsing them", () => {
    expect(() => canonicalJson({ d: new Date(1) })).toThrow(UncacheableArgsError);
    expect(() => canonicalJson({ m: new Map([[1, 2]]) })).toThrow(UncacheableArgsError);
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(UncacheableArgsError);
    expect(() => canonicalJson({ x: 10n })).toThrow(UncacheableArgsError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(UncacheableArgsError);
    expect(() => canonicalJson([1, undefined])).toThrow(UncacheableArgsError);
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(/deeper/);
    // 0.1.0 mapped Date(1) and Date(2) both to {} and NaN to "NaN" (same key as the string)
    expect(tryCallKey({ name: "t", args: { x: Number.NaN } })).toBeUndefined();
    expect(callKey({ name: "t", args: { x: "NaN" } })).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson(Object.assign(Object.create(null), { b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });

  it("keys are hashes: argument values (secrets) never appear in them", () => {
    const k = callKey({ name: "get_secret", args: { token: "sk-live-123" } });
    expect(k).not.toContain("sk-live");
    expect(k).toHaveLength(64);
  });

  it("a call with circular or non-JSON args executes normally (0.1.0: threw before running the tool)", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock);
    const s = new Speculator({ tools: store.tools, predictor: scripted(() => [get("a")]), clock });
    const circ: Record<string, unknown> = { key: "a" };
    circ.self = circ;
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(500);
      expect(await s.call({ name: "get", args: circ })).toBe(null);
      expect(await s.call({ name: "get", args: { key: "a", when: new Date(0) } })).toBe(null);
    });
    expect(s.metrics().bypassed).toBe(2);
    expect(store.log.real.length).toBe(2);
  });

  it("predictions with non-JSON args are skipped as uncacheable", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock);
    const events: SpeculationEvent[] = [];
    const s = new Speculator({
      tools: store.tools,
      clock,
      predictor: scripted(() => [{ name: "get", args: { key: new Date(0) } }]),
      onEvent: (e) => events.push(e),
    });
    await clock.run(() => s.beginRound());
    expect(events.some((e) => e.type === "skip" && e.reason === "uncacheable")).toBe(true);
    expect(store.log.spec).toEqual([]);
  });
});

describe("tool lookup uses own properties only", () => {
  it("prototype names are unknown tools, not Object built-ins", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock);
    const events: SpeculationEvent[] = [];
    const s = new Speculator({
      tools: store.tools,
      clock,
      predictor: scripted(() => [
        { name: "constructor", args: {} },
        { name: "__proto__", args: {} },
        { name: "toString", args: {} },
      ]),
      onEvent: (e) => events.push(e),
    });
    await clock.run(async () => {
      await s.beginRound();
      // 0.1.0: "tool.handler is not a function" (TypeError from Object.prototype.constructor)
      await expect(s.call({ name: "constructor", args: {} })).rejects.toThrow("Unknown tool: constructor");
      await expect(s.call({ name: "hasOwnProperty", args: {} })).rejects.toThrow("Unknown tool");
    });
    expect(events.filter((e) => e.type === "skip" && e.reason === "unknown_tool")).toHaveLength(3);
  });

  it("a normalizer cannot rename the tool being keyed", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock);
    const s = new Speculator({
      tools: store.tools,
      clock,
      predictor: scripted(() => [get("a")]),
      normalizeArgs: (c) => ({ name: "put", args: c.args }),
    });
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(500);
      await s.call(get("a"));
    });
    expect(s.metrics().hits).toBe(1);
    expect(store.log.spec).toEqual(['get:{"key":"a"}']);
  });
});

describe("classifier: misleading metadata", () => {
  it("a mutating word in the DESCRIPTION vetoes readOnlyHint (README promised this; 0.1.0 only checked the name)", () => {
    const c = classifyTool({ name: "frob", description: "Deletes every row in the table.", annotations: { readOnlyHint: true } });
    expect(c.safety).toBe("side_effecting");
    expect(c.reason).toMatch(/description word "deletes"/);
  });

  it("scans the whole description, not just the first 40 words", () => {
    const padding = Array.from({ length: 60 }, () => "lorem").join(" ");
    expect(classifyTool({ name: "get_report", description: `${padding} and then permanently deletes it.` }).safety).toBe("side_effecting");
  });

  it("open-world tools are detected from annotations, names and URL-like arguments", () => {
    expect(classifyTool({ name: "fetch", annotations: { readOnlyHint: true, openWorldHint: true } }).openWorld).toBe(true);
    expect(classifyTool({ name: "web_search" }).openWorld).toBe(true);
    expect(classifyTool({ name: "get_page", inputSchema: { type: "object", properties: { url: { type: "string" } } } }).openWorld).toBe(
      true,
    );
    expect(classifyTool({ name: "read_file" }).openWorld).toBe(false);
    expect(classifyTool({ name: "read_file", annotations: { readOnlyHint: true } }, { openWorldByDefault: true }).openWorld).toBe(true);
    expect(
      classifyTool({ name: "read_file", annotations: { readOnlyHint: true, openWorldHint: false } }, { openWorldByDefault: true })
        .openWorld,
    ).toBe(false);
    expect(classifyTool({ name: "fetch", annotations: { openWorldHint: true } }, { trustAnnotations: false }).openWorld).toBe(false);
  });
});

describe("idempotent opt-in cannot serve reads that predate its effect", () => {
  function setupEnsure() {
    const clock = new VirtualClock();
    const data = new Map<string, string>();
    const log: string[] = [];
    const tools: ToolRegistry = {
      get: {
        spec: { name: "get", description: "Get a value." },
        handler: async (a, c) => {
          log.push(`${c.speculative ? "spec" : "real"}:get`);
          await clock.sleep(10, c.signal);
          return data.get(String(a.key)) ?? null;
        },
      },
      ensure: {
        spec: { name: "ensure", description: "Ensure a key exists.", annotations: { idempotentHint: true } },
        handler: async (a, c) => {
          log.push(`${c.speculative ? "spec" : "real"}:ensure`);
          await clock.sleep(100, c.signal);
          if (!data.has(String(a.key))) data.set(String(a.key), "ensured");
          return "ok";
        },
      },
    };
    const s = new Speculator({
      tools,
      clock,
      allow: ["read_only", "idempotent"],
      predictor: scripted(() => [get("k"), { name: "ensure", args: { key: "k" } }]),
    });
    return { clock, s, log };
  }

  it("a served idempotent call invalidates reads cached before its effect", async () => {
    const { clock, s, log } = setupEnsure();
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(500); // get(k)=null cached at t=10, ensure(k) done at t=100
      expect(await s.call({ name: "ensure", args: { key: "k" } })).toBe("ok"); // served
      expect(await s.call(get("k"))).toBe("ensured"); // 0.1.0 served the stale null
    });
    expect(log).toContain("real:get");
    expect(s.metrics().invalidations).toBeGreaterThanOrEqual(2);
  });
});

describe("bounded memory", () => {
  it("history is capped by maxHistory", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock);
    const s = new Speculator({ tools: store.tools, predictor: scripted(() => []), clock, maxHistory: 5 });
    await clock.run(async () => {
      for (let i = 0; i < 20; i++) await s.call(get(`k${i}`));
    });
    expect(s.history).toHaveLength(5);
    expect(s.history[4].call.args.key).toBe("k19");
  });

  it("n-gram online learning counts every step exactly once with a sliding-window history", () => {
    const seq: Step[] = Array.from({ length: 40 }, (_, i) => ({ call: { name: i % 2 ? "b" : "a", args: { i: i % 3 } }, result: "x" }));
    const full = new NGramPredictor().train([{ steps: seq }]);
    const online = new NGramPredictor();
    const window: Step[] = [];
    for (const step of seq) {
      window.push(step);
      if (window.length > 6) window.shift(); // like Speculator's capped history
      online.observe(window);
    }
    // 0.1.0 re-learned the whole window on every step once history[0] changed (6x counts)
    expect(online.stats().observations).toBe(40);
    expect(online.toolDistribution(seq.slice(0, 3))).toEqual(full.toolDistribution(seq.slice(0, 3)));
  });

  it("a predictor shared by interleaved sessions does not re-learn either history", () => {
    const p = new NGramPredictor();
    const h1: Step[] = [];
    const h2: Step[] = [];
    for (let i = 0; i < 10; i++) {
      h1.push({ call: { name: "a", args: {} } });
      p.observe(h1);
      h2.push({ call: { name: "b", args: {} } });
      p.observe(h2);
    }
    expect(p.stats().observations).toBe(20);
  });

  it("n-gram argument sources are pruned (unique literals cannot grow memory without bound)", () => {
    const p = new NGramPredictor({ maxSourcesPerArg: 8 });
    const h: Step[] = [];
    for (let i = 0; i < 2000; i++) {
      h.push({ call: { name: "get", args: { id: `unique-${i}` } } });
      p.observe(h);
    }
    // two conditioning contexts per (tool, arg), each capped at 2 * maxSourcesPerArg
    expect(p.stats().sources).toBeLessThanOrEqual(2 * 2 * 8);
  });

  it("pending entries are bounded even with cancelOnNewRound=false", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock, { slow: 100_000 });
    let i = 0;
    const s = new Speculator({
      tools: store.tools,
      clock,
      cancelOnNewRound: false,
      maxCacheEntries: 5,
      timeoutMs: 1_000_000,
      predictor: scripted(() => [{ name: "slow_get", args: { key: `k${i++}` } }]),
    });
    await clock.run(async () => {
      for (let r = 0; r < 50; r++) await s.beginRound();
      expect((s as unknown as { entries: Map<string, unknown> }).entries.size).toBeLessThanOrEqual(5);
      s.close();
    });
  });

  it("results larger than maxCacheBytes are not kept", async () => {
    const clock = new VirtualClock();
    const tools: ToolRegistry = {
      read_big: { spec: { name: "read_big" }, handler: async () => "x".repeat(10_000) },
      read_small: { spec: { name: "read_small" }, handler: async () => "x" },
    };
    const s = new Speculator({
      tools,
      clock,
      maxCacheBytes: 1000,
      predictor: scripted(() => [
        { name: "read_big", args: {} },
        { name: "read_small", args: {} },
      ]),
    });
    await clock.run(async () => {
      await s.beginRound();
      await s.drain();
      await s.call({ name: "read_big", args: {} });
      await s.call({ name: "read_small", args: {} });
    });
    expect(s.metrics().hits).toBe(1);
    expect(s.metrics().specFailedFallbacks).toBe(0); // the big one was discarded before the call arrived
  });
});

describe("validators cannot hang the agent", () => {
  it("a validator that never resolves: the real call re-executes after validatorTimeoutMs; slot is released", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock);
    let hang = false;
    const s = new Speculator({
      tools: store.tools,
      clock,
      maxConcurrency: 1,
      validatorTimeoutMs: 50,
      predictor: scripted(() => [get("a")]),
      validators: [customValidator(() => (hang ? new Promise<string>(() => {}) : "v"))],
    });
    store.data.set("a", "A");
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(500);
      hang = true;
      const t0 = clock.now();
      expect(await s.call(get("a"))).toBe("A"); // 0.1.0: awaited the validator forever
      expect(clock.now() - t0).toBe(50 + 100);
      // speculation launched while the validator hangs times out and frees the only slot
      void s.beginRound();
      await clock.sleep(40_000);
      hang = false;
      void s.beginRound();
      await clock.sleep(500);
      expect(await s.call(get("a"))).toBe("A");
    });
    expect(s.metrics().staleRejected).toBe(1);
    expect(s.metrics().hits).toBe(1);
  });
});

describe("cancellation & lifecycle", () => {
  it("wrapped tools forward the caller's AbortSignal (0.1.0 dropped it)", async () => {
    let seen: AbortSignal | undefined;
    const tools: ToolRegistry = {
      write_x: {
        spec: { name: "write_x" },
        handler: async (_a, c) => {
          seen = c.signal;
          return "ok";
        },
      },
    };
    const s = speculate(tools, { predictor: scripted(() => []) });
    const ac = new AbortController();
    await s.tools.write_x.handler({}, { signal: ac.signal, speculative: false });
    expect(seen).toBe(ac.signal);
  });

  it("aborting a call that joined a running speculation rejects promptly and aborts the speculation", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock, { slow: 10_000 });
    const s = new Speculator({ tools: store.tools, clock, predictor: scripted(() => [{ name: "slow_get", args: { key: "a" } }]) });
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(100);
      const ac = new AbortController();
      const p = s.call({ name: "slow_get", args: { key: "a" } }, { signal: ac.signal });
      await clock.sleep(100);
      ac.abort();
      await expect(p).rejects.toThrow();
      expect(clock.now()).toBe(200);
      await clock.sleep(10);
    });
    expect(store.log.abortedSpec).toEqual(['slow_get:{"key":"a"}']);
    expect(s.history.at(-1)?.error).toBeDefined();
  });

  it("drain() waits for in-progress prediction rounds, not only launched executions", async () => {
    const store = makeStore(realClock, { get: 5 });
    const slowPredictor: Predictor = {
      name: "slow",
      predict: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { predictions: [{ call: get("a"), score: 1, source: "slow" }] };
      },
    };
    const s = new Speculator({ tools: store.tools, predictor: slowPredictor });
    void s.beginRound();
    await s.drain(); // 0.1.0 returned immediately (nothing launched yet)
    expect(store.log.spec).toEqual(['get:{"key":"a"}']);
    await s.call(get("a"));
    expect(s.metrics().hits).toBe(1);
  });

  it("after close(), rounds are no-ops and calls still execute", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock);
    const s = new Speculator({ tools: store.tools, clock, predictor: scripted(() => [get("a")]) });
    s.close();
    await clock.run(async () => {
      await s.beginRound(); // 0.1.0 kept speculating after close()
      await clock.sleep(500);
      expect(await s.call(get("a"))).toBe(null);
    });
    expect(store.log.spec).toEqual([]);
    expect(s.closed).toBe(true);
  });

  it("cancelAll() aborts in-flight work but keeps the speculator usable", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock);
    const s = new Speculator({ tools: store.tools, clock, predictor: scripted(() => [get("a")]) });
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(10);
      s.cancelAll();
      void s.beginRound();
      await clock.sleep(500);
      await s.call(get("a"));
    });
    expect(store.log.abortedSpec).toHaveLength(1);
    expect(s.metrics().hits).toBe(1);
  });
});

describe("option validation & clocks", () => {
  it("rejects nonsensical options up front", () => {
    const tools = makeStore(new VirtualClock()).tools;
    const predictor = scripted(() => []);
    expect(() => new Speculator({ tools, predictor, topK: Number.NaN })).toThrow(RangeError);
    expect(() => new Speculator({ tools, predictor, topK: 1.5 })).toThrow(RangeError);
    expect(() => new Speculator({ tools, predictor, maxConcurrency: 0 })).toThrow(RangeError);
    expect(() => new Speculator({ tools, predictor, timeoutMs: Infinity })).toThrow(RangeError); // setTimeout overflow
    expect(() => new Speculator({ tools, predictor, maxCacheEntries: -1 })).toThrow(RangeError);
    expect(() => new Speculator({ tools: { x: { spec: { name: "x" } } } as unknown as ToolRegistry, predictor })).toThrow(/handler/);
    expect(() => new Speculator({ tools, predictor: undefined as unknown as Predictor })).toThrow(TypeError);
    expect(() => new Speculator({ tools, predictor, topK: 0 })).not.toThrow();
  });

  it("topK=0 disables speculation", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock);
    const p = scripted(() => [get("a")]);
    const s = new Speculator({ tools: store.tools, clock, predictor: p, topK: 0 });
    await clock.run(() => s.beginRound());
    expect(p.calls).toBe(0);
  });

  it("realClock.sleep never fires early for huge or infinite delays (setTimeout overflow)", async () => {
    let fired = false;
    const ac = new AbortController();
    const p = realClock.sleep(Infinity, ac.signal).then(() => (fired = true));
    const q = realClock.sleep(2 ** 40, ac.signal).then(() => (fired = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toBe(false);
    ac.abort();
    await expect(p).rejects.toThrow();
    await expect(q).rejects.toThrow();
  });

  it("pathNormalizer resolves '..' above the root of an absolute path", () => {
    expect(pathNormalizer()({ name: "r", args: { path: "/../etc//x" } }).args.path).toBe("/etc/x");
  });
});
