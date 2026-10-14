import { describe, expect, it } from "vitest";
import { collectTraces, runVariant, taskIds } from "../bench/sim/harness.js";
import { REMOTE_SANDBOX } from "../bench/sim/tools.js";

describe("simulated benchmark", () => {
  it("speculation is lossless on simulated coding-agent tasks and saves time", async () => {
    const train = await collectTraces(taskIds("t", 60), REMOTE_SANDBOX);
    const ids = taskIds("e", 30);
    const base = await runVariant({ name: "base" }, ids, train, { profile: REMOTE_SANDBOX });
    const spec = await runVariant({ name: "spec", predictor: "ngram+sim-llm", allow: ["read_only", "idempotent"] }, ids, train, {
      profile: REMOTE_SANDBOX,
    });
    spec.runs.forEach((r, i) => {
      expect(r.transcript).toEqual(base.runs[i].transcript);
      expect(r.finalFs).toBe(base.runs[i].finalFs);
      expect(r.wallMs).toBeLessThanOrEqual(base.runs[i].wallMs + 1e-6);
    });
    const total = (rs: { wallMs: number }[]) => rs.reduce((a, r) => a + r.wallMs, 0);
    expect(total(spec.runs)).toBeLessThan(total(base.runs) * 0.97);
    // the sim-LLM proposes write_file calls; all must have been refused
    expect(spec.metrics.skippedUnsafe).toBeGreaterThan(0);
  });
});
