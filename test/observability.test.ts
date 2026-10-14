import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/clock.js";
import { otelTelemetry, type Attributes, type Logger, type MeterLike } from "../src/observability.js";
import { Speculator } from "../src/speculator.js";
import type { ToolCall } from "../src/types.js";
import { makeStore, scripted } from "./helpers.js";

const get = (key: string): ToolCall => ({ name: "get", args: { key } });

function captureLogger() {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => lines.push({ level, msg, fields });
  const logger: Logger = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
  return { lines, logger };
}

async function scenario(opts: { logArgs?: boolean } = {}) {
  const clock = new VirtualClock();
  const store = makeStore(clock);
  const { lines, logger } = captureLogger();
  const s = new Speculator({
    tools: store.tools,
    clock,
    sessionId: "sess-1",
    logger,
    ...opts,
    predictor: scripted(() => [{ name: "get", args: { key: "sk-secret-token" } }, get("b")]),
  });
  await clock.run(async () => {
    void s.beginRound();
    await clock.sleep(500);
    await s.call({ name: "get", args: { key: "sk-secret-token" } });
    await s.call({ name: "put", args: { key: "a", value: "v" } });
  });
  return lines;
}

describe("structured logging", () => {
  it("never logs argument values by default", async () => {
    const lines = await scenario();
    const all = JSON.stringify(lines);
    expect(all).not.toContain("sk-secret-token");
    const hit = lines.find((l) => l.fields?.event === "hit")!;
    expect(hit.fields).toMatchObject({ tool: "get", sessionId: "sess-1", savedMs: 100 });
    expect(hit.fields!.key).toMatch(/^[0-9a-f]{16}$/);
    expect(lines.some((l) => l.fields?.event === "invalidate")).toBe(true);
    expect(lines.some((l) => l.fields?.event === "launch" && l.fields?.source === "scripted")).toBe(true);
  });

  it("logs arguments only with logArgs: true", async () => {
    const lines = await scenario({ logArgs: true });
    expect(JSON.stringify(lines)).toContain("sk-secret-token");
  });

  it("predictor errors are logged at warn", async () => {
    const clock = new VirtualClock();
    const { lines, logger } = captureLogger();
    const s = new Speculator({
      tools: makeStore(clock).tools,
      clock,
      logger,
      predictor: {
        name: "down",
        predict: async () => {
          throw new Error("503");
        },
      },
    });
    await clock.run(() => s.beginRound());
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({ event: "predictor_error", source: "down", error: "503" }),
      }),
    );
  });
});

describe("OpenTelemetry-friendly metrics", () => {
  it("otelTelemetry records counters and histograms through a Meter", async () => {
    const recorded: { kind: string; name: string; value: number; attrs?: Attributes }[] = [];
    const created: string[] = [];
    const meter: MeterLike = {
      createCounter: (name, o) => {
        created.push(`${name}:${o?.description ? "desc" : "-"}`);
        return { add: (value, attrs) => recorded.push({ kind: "counter", name, value, attrs }) };
      },
      createHistogram: (name, o) => {
        created.push(`${name}:${o?.unit}`);
        return { record: (value, attrs) => recorded.push({ kind: "histogram", name, value, attrs }) };
      },
    };
    const clock = new VirtualClock();
    const store = makeStore(clock);
    const s = new Speculator({
      tools: store.tools,
      clock,
      telemetry: otelTelemetry(meter),
      predictor: scripted(() => [get("a"), { name: "put", args: {} }]),
    });
    await clock.run(async () => {
      void s.beginRound();
      await clock.sleep(500);
      await s.call(get("a"));
      await s.call(get("zzz"));
      await s.call({ name: "put", args: { key: "a", value: "1" } });
    });
    const calls = recorded.filter((r) => r.name === "speculate.calls").map((r) => r.attrs);
    expect(calls).toEqual([
      { tool: "get", outcome: "hit" },
      { tool: "get", outcome: "miss" },
      { tool: "put", outcome: "ineligible" },
    ]);
    expect(recorded).toContainEqual({ kind: "histogram", name: "speculate.latency_saved", value: 100, attrs: { tool: "get" } });
    expect(recorded.some((r) => r.name === "speculate.launches" && r.attrs?.source === "scripted")).toBe(true);
    expect(recorded.some((r) => r.name === "speculate.skipped" && r.attrs?.reason === "unsafe")).toBe(true);
    expect(recorded.some((r) => r.name === "speculate.predictor.duration")).toBe(true);
    expect(recorded.some((r) => r.name === "speculate.invalidations")).toBe(true);
    // instruments are created once each, with descriptions/units
    expect(new Set(created).size).toBe(created.length);
    expect(created).toContain("speculate.latency_saved:ms");
    // no argument values in metric attributes
    expect(JSON.stringify(recorded)).not.toContain('"a"');
  });
});
