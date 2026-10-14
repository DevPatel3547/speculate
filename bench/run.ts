/**
 * Benchmark harness — SIMULATED agent, SIMULATED tools, SIMULATED model latency.
 *
 *   npm run bench                      # virtual time, deterministic, both latency profiles
 *   npm run bench -- --tasks 500       # more eval tasks
 *   npm run bench:realtime             # real timers (time-scaled), small run
 */
import { scaledClock } from "../src/clock.js";
import { eligibleHitRate, hitRate, precision } from "../src/metrics.js";
import { collectTraces, describeSafety, runVariant, taskIds, type Variant, type VariantResult } from "./sim/harness.js";
import { LOCAL, REMOTE_SANDBOX, type LatencyProfile } from "./sim/tools.js";

const argv = process.argv.slice(2);
const opt = (name: string, d: number) => {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const realtime = argv.includes("--realtime");

const VARIANTS: Variant[] = [
  { name: "baseline (no speculation)" },
  { name: "n-gram, read-only tools", predictor: "ngram" },
  { name: "n-gram, + run_tests (idempotent opt-in)", predictor: "ngram", allow: ["read_only", "idempotent"] },
  { name: "n-gram + sim-LLM@60%, read-only", predictor: "ngram+sim-llm", llmAccuracy: 0.6 },
  { name: "n-gram + sim-LLM@60%, + run_tests", predictor: "ngram+sim-llm", llmAccuracy: 0.6, allow: ["read_only", "idempotent"] },
  {
    name: "ceiling: oracle 100%, 0ms, + run_tests",
    predictor: "sim-llm",
    llmAccuracy: 1,
    llmLatencyMs: 0,
    llmCostPerCall: 0,
    allow: ["read_only", "idempotent"],
    topK: 8,
  },
];

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function table(rows: string[][]): string {
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  const line = (r: string[]) => "| " + r.map((x, c) => (c === 0 ? x.padEnd(w[c]) : x.padStart(w[c]))).join(" | ") + " |";
  return [
    line(rows[0]),
    "|" + w.map((n, c) => (c === 0 ? "-".repeat(n + 1) + "-" : "-".repeat(n + 1) + ":")).join("|") + "|",
    ...rows.slice(1).map(line),
  ].join("\n");
}

function identical(base: VariantResult, r: VariantResult): number {
  let same = 0;
  r.runs.forEach((run, i) => {
    const b = base.runs[i];
    if (run.transcript.join("\n") === b.transcript.join("\n") && run.finalFs === b.finalFs) same++;
  });
  return same;
}

function render(results: VariantResult[]): string {
  const base = results[0];
  const baseMean = mean(base.runs.map((r) => r.wallMs));
  const rows = [
    [
      "variant",
      "mean task s",
      "p50 s",
      "p90 s",
      "time saved",
      "hit rate",
      "eligible hit",
      "precision",
      "wasted execs/task",
      "wasted tool-s/task",
      "pred. $/task",
      "identical",
    ],
  ];
  for (const r of results) {
    const t = r.runs.map((x) => x.wallMs / 1000);
    const n = r.runs.length;
    const m = r.metrics;
    const spec = !!r.variant.predictor;
    rows.push([
      r.variant.name,
      mean(t).toFixed(1),
      pct(t, 0.5).toFixed(1),
      pct(t, 0.9).toFixed(1),
      spec ? `${(((baseMean - mean(r.runs.map((x) => x.wallMs))) / baseMean) * 100).toFixed(1)}%` : "-",
      spec ? `${(hitRate(m) * 100).toFixed(1)}%` : "-",
      spec ? `${(eligibleHitRate(m) * 100).toFixed(1)}%` : "-",
      spec ? `${(precision(m) * 100).toFixed(1)}%` : "-",
      spec ? (m.wasted / n).toFixed(2) : "-",
      spec ? (m.wastedToolMs / 1000 / n).toFixed(2) : "-",
      spec ? `$${(m.predictorCost / n).toFixed(4)}` : "-",
      `${identical(base, r)}/${n}`,
    ]);
  }
  return table(rows);
}

async function runProfile(profile: LatencyProfile, nTrain: number, nEval: number, variants: Variant[], clockScale?: number) {
  const train = await collectTraces(taskIds("train", nTrain), profile);
  const ids = taskIds("eval", nEval);
  const results: VariantResult[] = [];
  const realMs: number[] = [];
  for (const v of variants) {
    const t0 = performance.now();
    results.push(
      await runVariant(v, ids, train, {
        profile,
        clockFactory: clockScale ? () => scaledClock(clockScale) : undefined,
      }),
    );
    realMs.push(performance.now() - t0);
  }
  return { results, realMs, avgCalls: mean(results[0].runs.map((r) => r.calls)), avgTurns: mean(results[0].runs.map((r) => r.turns)) };
}

async function main() {
  console.log("speculate benchmark — SIMULATED coding agent (synthetic traces, simulated model + tool latency)");
  console.log(`tool safety: ${describeSafety()}`);
  if (realtime) {
    const scale = opt("--scale", 0.02);
    const nEval = opt("--tasks", 15);
    console.log(
      `\nREAL-TIMER mode: every simulated ms sleeps ${scale} real ms (setTimeout), ${nEval} tasks, profile ${REMOTE_SANDBOX.name}`,
    );
    const vs = [VARIANTS[0], VARIANTS[2]];
    const { results, realMs } = await runProfile(REMOTE_SANDBOX, opt("--train", 200), nEval, vs, scale);
    console.log(render(results));
    console.log(`real elapsed: ${vs.map((v, i) => `${v.name}: ${(realMs[i] / 1000).toFixed(2)}s`).join(" | ")}`);
    console.log("(timings include real timer jitter; transcripts must still be identical)");
    return;
  }
  const nTrain = opt("--train", 300);
  const nEval = opt("--tasks", 200);
  for (const profile of [REMOTE_SANDBOX, LOCAL]) {
    const t0 = performance.now();
    const { results, avgCalls, avgTurns } = await runProfile(profile, nTrain, nEval, VARIANTS);
    console.log(`\n## profile: ${profile.name} — ${profile.description}`);
    console.log(
      `tool latency medians: ${Object.entries(profile.tools)
        .map(([k, [m]]) => `${k} ${m}ms`)
        .join(", ")}; ` +
        `train ${nTrain} / eval ${nEval} tasks; ${avgTurns.toFixed(1)} turns, ${avgCalls.toFixed(1)} tool calls per task (virtual time, ${((performance.now() - t0) / 1000).toFixed(1)}s real)`,
    );
    console.log(render(results));
  }
  console.log(
    "\nhit rate = (hits+joins)/all real calls; eligible = over calls to speculable tools; precision = used/launched speculative executions." +
      "\nsim-LLM@60% is an oracle-with-noise stand-in for a cheap-model predictor (assumed 60% recall, ~600ms latency, $0.0003/call) — not a measured model.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
