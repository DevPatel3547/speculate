import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/clock.js";
import { SpeculatorPool } from "../src/pool.js";
import { NGramPredictor } from "../src/predictors/ngram.js";
import type { ToolCall, ToolRegistry } from "../src/types.js";
import { makeStore, scripted } from "./helpers.js";

const get = (key: string): ToolCall => ({ name: "get", args: { key } });

describe("SpeculatorPool: per-session isolation", () => {
  it("a result speculated in one session is never served to another", async () => {
    const clock = new VirtualClock();
    // per-session data: the same call returns different results for different users
    const perUser = new Map([
      ["alice", "alice-secret"],
      ["bob", "bob-data"],
    ]);
    const log: string[] = [];
    const tools: ToolRegistry = {
      get_profile: {
        spec: { name: "get_profile", description: "Get the current user's profile." },
        handler: async (_a, ctx) => {
          log.push(`${ctx.speculative ? "spec" : "real"}:${ctx.sessionId}`);
          await clock.sleep(50, ctx.signal);
          return perUser.get(ctx.sessionId ?? "") ?? null;
        },
      },
    };
    const pool = new SpeculatorPool({ tools, clock, predictor: scripted(() => [{ name: "get_profile", args: {} }]) });
    await clock.run(async () => {
      const alice = pool.session("alice");
      void alice.beginRound();
      await clock.sleep(500); // alice's speculative get_profile is cached
      const bob = pool.session("bob");
      expect(await bob.call({ name: "get_profile", args: {} })).toBe("bob-data");
      expect(await alice.call({ name: "get_profile", args: {} })).toBe("alice-secret");
    });
    expect(log).toEqual(["spec:alice", "real:bob"]);
    expect(pool.get("alice")!.metrics().hits).toBe(1);
    expect(pool.get("bob")!.metrics().hits).toBe(0);
    expect(pool.metrics().hits).toBe(1);
  });

  it("a write in one session does not invalidate another session's cache", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock);
    const pool = new SpeculatorPool({ tools: store.tools, clock, predictor: () => scripted(() => [get("a")]) });
    await clock.run(async () => {
      const a = pool.session("a");
      void a.beginRound();
      await clock.sleep(500);
      await pool.session("b").call({ name: "put", args: { key: "z", value: "1" } });
      await a.call(get("a"));
    });
    expect(pool.get("a")!.metrics().hits).toBe(1);
  });

  it("predictor factory gives each session its own predictor", () => {
    const made: string[] = [];
    const pool = new SpeculatorPool({
      tools: makeStore(new VirtualClock()).tools,
      predictor: (id) => {
        made.push(id);
        return new NGramPredictor();
      },
    });
    pool.session("x");
    pool.session("y");
    pool.session("x");
    expect(made).toEqual(["x", "y"]);
  });

  it("evicts the least recently used session beyond maxSessions (and closes it)", () => {
    const pool = new SpeculatorPool({ tools: makeStore(new VirtualClock()).tools, predictor: scripted(() => []), maxSessions: 2 });
    const a = pool.session("a");
    pool.session("b");
    pool.session("a"); // refresh a
    pool.session("c"); // evicts b
    expect(pool.get("b")).toBeUndefined();
    expect(pool.get("a")).toBe(a);
    expect(pool.size).toBe(2);
    expect(pool.delete("nope")).toBe(false);
  });

  it("closes sessions idle longer than idleTtlMs", async () => {
    const clock = new VirtualClock();
    const pool = new SpeculatorPool({ tools: makeStore(clock).tools, clock, predictor: scripted(() => []), idleTtlMs: 1000 });
    await clock.run(async () => {
      const a = pool.session("a");
      pool.session("b");
      await clock.sleep(600);
      await pool.session("b").call(get("x")); // b active
      await clock.sleep(600);
      pool.sweep();
      expect(a.closed).toBe(true);
      expect(pool.get("a")).toBeUndefined();
      expect(pool.get("b")).toBeDefined();
    });
    pool.close();
    expect(pool.size).toBe(0);
  });

  it("maxGlobalConcurrency is shared across sessions", async () => {
    const clock = new VirtualClock();
    const store = makeStore(clock, { get: 1000 });
    let i = 0;
    const pool = new SpeculatorPool({
      tools: store.tools,
      clock,
      topK: 3,
      maxGlobalConcurrency: 2,
      predictor: () => scripted(() => [get(`k${i++}`), get(`k${i++}`), get(`k${i++}`)]),
    });
    await clock.run(async () => {
      void pool.session("a").beginRound();
      void pool.session("b").beginRound();
      await clock.sleep(5000);
    });
    expect(store.log.spec.length).toBe(6);
    expect(store.log.maxConcurrentSpec).toBe(2);
  });

  it("validates its options", () => {
    const tools = makeStore(new VirtualClock()).tools;
    expect(() => new SpeculatorPool({ tools, predictor: scripted(() => []), maxSessions: 0 })).toThrow(RangeError);
    expect(() => new SpeculatorPool({ tools, predictor: scripted(() => []), idleTtlMs: -1 })).toThrow(RangeError);
    expect(() => new SpeculatorPool({ tools, predictor: undefined as never })).toThrow(TypeError);
    expect(() => new SpeculatorPool({ tools, predictor: scripted(() => []) }).session("")).toThrow(TypeError);
  });
});
