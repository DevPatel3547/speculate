import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Safety } from "../types.js";
import { evaluateTraces, formatEvalReport } from "../eval/evaluate.js";
import { readTrajectoriesFile } from "../eval/trace-format.js";
import { parseIntArg, parseList, parseNumberArg, processIO, UsageError, type CliIO } from "./common.js";

export const EVAL_TRACES_HELP = `Usage: speculate-tools eval-traces [options] <trajectories.jsonl[.gz]>
       npm run eval:traces -- [options] <trajectories.jsonl[.gz]>

Replays recorded agent trajectories (one JSON object per line, see
docs/trace-format.md) and reports how often the n-gram predictor would have
predicted each speculable call exactly (top-1 / top-3), plus an ESTIMATE of the
latency speculation would have saved. Trajectories are split into train/test
sets by a hash of their id.

Options:
  --test-fraction <f>      fraction of trajectories held out for testing (default 0.3)
  --seed <s>               split seed (default "speculate")
  --top-k <n>              speculative executions launched per step (default 3)
  --no-online              do not keep learning while replaying test trajectories
  --allow-idempotent       count idempotent tools as speculable
  --allow-open-world       count open-world (network) tools as speculable
  --read-only <a,b,...>    classify these tools as read_only
  --idempotent <a,b,...>   classify these tools as idempotent
  --side-effecting <a,..>  classify these tools as side_effecting
  --tool-classes <file>    JSON default class per tool: {"tools":{"name":{"class":..}}} or {"name":"read_only"}
  --ignore-step-class      ignore per-step "cls" fields; classify every call by tool name only
  --test-prefix <p,...>    hold out test trajectories only among ids with these prefixes
                           (all other trajectories are training data)
  --only-prefix <p,...>    evaluate only trajectories whose id has one of these prefixes
  --exclude-tools <a,...>  never score or launch these tools (e.g. no-op "think" tools)
  --think-ms <ms>          think time when a step has no think_ms (default 2000)
  --tool-ms <ms>           tool time when a step has no tool_ms (default 300)
  --predictor-ms <ms>      predictor latency subtracted from each window (default 0)
  --json                   print the full report as JSON
  --strict                 fail (exit 1) if any line is invalid
  -h, --help               show this help

A step's own "cls" field (if present) decides whether that call was safe to
speculate. Otherwise tools are classified by --tool-classes, then by the majority
"cls" seen in training, then from their names (read_file -> read_only, write_file
-> side_effecting, unknown -> side_effecting). --read-only etc. override all of it.
`;

/** Run the `eval-traces` command. Resolves with an exit code. */
export async function runEvalTraces(argv: string[], io: CliIO = processIO): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        "test-fraction": { type: "string" },
        seed: { type: "string" },
        "top-k": { type: "string" },
        "no-online": { type: "boolean" },
        "allow-idempotent": { type: "boolean" },
        "allow-open-world": { type: "boolean" },
        "read-only": { type: "string" },
        idempotent: { type: "string" },
        "side-effecting": { type: "string" },
        "think-ms": { type: "string" },
        "tool-ms": { type: "string" },
        "predictor-ms": { type: "string" },
        json: { type: "boolean" },
        "tool-classes": { type: "string" },
        "ignore-step-class": { type: "boolean" },
        "test-prefix": { type: "string" },
        "only-prefix": { type: "string" },
        "exclude-tools": { type: "string" },
        strict: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
    if (values.help) {
      io.stdout(EVAL_TRACES_HELP);
      return 0;
    }
    if (positionals.length !== 1) throw new UsageError("expected exactly one trajectories file");
  } catch (e) {
    io.stderr(`speculate-tools eval-traces: ${e instanceof Error ? e.message : String(e)}\nRun with --help for usage.`);
    return 2;
  }
  const str = (k: string) => values[k] as string | undefined;
  let opts: Parameters<typeof evaluateTraces>[1];
  try {
    const overrides: Record<string, Safety> = {};
    for (const t of parseList(str("read-only"))) overrides[t] = "read_only";
    for (const t of parseList(str("idempotent"))) overrides[t] = "idempotent";
    for (const t of parseList(str("side-effecting"))) overrides[t] = "side_effecting";
    const testFraction = parseNumberArg("--test-fraction", str("test-fraction"), 0, 1);
    if (testFraction !== undefined && (testFraction <= 0 || testFraction >= 1))
      throw new UsageError("--test-fraction must be between 0 and 1 (exclusive)");
    opts = {
      useStepClass: !values["ignore-step-class"],
      testPrefixes: parseList(str("test-prefix")),
      excludeTools: parseList(str("exclude-tools")),
      testFraction,
      seed: str("seed"),
      topK: parseIntArg("--top-k", str("top-k"), 1),
      online: !values["no-online"],
      allow: values["allow-idempotent"] ? ["read_only", "idempotent"] : ["read_only"],
      allowOpenWorld: !!values["allow-open-world"],
      classifier: { overrides },
      timing: {
        defaultThinkMs: parseNumberArg("--think-ms", str("think-ms"), 0),
        defaultToolMs: parseNumberArg("--tool-ms", str("tool-ms"), 0),
        predictorMs: parseNumberArg("--predictor-ms", str("predictor-ms"), 0),
      },
    };
  } catch (e) {
    io.stderr(`speculate-tools eval-traces: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  if (str("tool-classes")) {
    try {
      opts.toolClasses = parseToolClasses(JSON.parse(await readFile(str("tool-classes")!, "utf8")));
    } catch (e) {
      io.stderr(`speculate-tools eval-traces: --tool-classes: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  const file = positionals[0];
  let parsed: Awaited<ReturnType<typeof readTrajectoriesFile>>;
  try {
    parsed = await readTrajectoriesFile(file);
  } catch (e) {
    io.stderr(`speculate-tools eval-traces: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const { errors } = parsed;
  const only = parseList(str("only-prefix"));
  const trajectories = only.length ? parsed.trajectories.filter((t) => only.some((p) => t.id.startsWith(p))) : parsed.trajectories;
  if (errors.length) {
    io.stderr(`speculate-tools eval-traces: ${errors.length} invalid line(s) in ${file}${values.strict ? "" : " (skipped)"}:`);
    for (const e of errors.slice(0, 5)) io.stderr(`  line ${e.line}: ${e.message}`);
    if (errors.length > 5) io.stderr(`  ... and ${errors.length - 5} more`);
    if (values.strict) return 1;
  }
  if (trajectories.length < 2) {
    io.stderr(`speculate-tools eval-traces: need at least 2 valid trajectories for a train/test split, found ${trajectories.length}`);
    return 1;
  }
  const report = evaluateTraces(trajectories, opts);
  io.stdout(values.json ? JSON.stringify(report, null, 2) : formatEvalReport(report));
  return 0;
}

const CLASSES = new Set<Safety>(["read_only", "idempotent", "side_effecting"]);

/** Accept `{"tools": {name: {class}}}` (tool_classes.json style) or a flat `{name: class}` map. */
export function parseToolClasses(v: unknown): Record<string, Safety> {
  const root = v && typeof v === "object" && "tools" in v ? v.tools : v;
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("expected an object mapping tool names to classes");
  const out: Record<string, Safety> = {};
  for (const [name, x] of Object.entries(root as Record<string, unknown>)) {
    const cls = typeof x === "string" ? x : x && typeof x === "object" ? (x as { class?: unknown }).class : undefined;
    if (typeof cls === "string" && CLASSES.has(cls as Safety)) out[name] = cls as Safety;
  }
  return out;
}
