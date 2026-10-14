import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import type { Safety } from "../types.js";

/**
 * One step of a normalized agent trajectory (see docs/trace-format.md).
 * Unknown fields are ignored, so producers may add their own.
 */
export interface TraceStep {
  /** Tool name exactly as the agent called it. */
  tool: string;
  /** Tool arguments (JSON object). Missing = `{}`. */
  args: Record<string, unknown>;
  /** Size of the tool result in bytes (informational). */
  result_bytes?: number;
  /** Wall time the tool took, ms. */
  tool_ms?: number;
  /** Model time between the previous tool result (or the prompt) and this call, ms. */
  think_ms?: number;
  /**
   * Optional result content (string or JSON). Lets the n-gram predictor learn argument
   * templates copied from previous results (e.g. grep -> read_file(first hit)).
   */
  result?: unknown;
  /** Optional: the call failed. */
  error?: boolean | string;
  /**
   * Optional safety class of THIS step (e.g. a shell command classified from its parsed
   * program list). When present it is used instead of name-based classification.
   */
  cls?: Safety;
}

/** One agent trajectory: one JSON object per line of a `.jsonl` file. */
export interface Trajectory {
  id: string;
  steps: TraceStep[];
  /** Optional provenance: dataset or system that produced the trajectory (used for per-source breakdowns). */
  source?: string;
  /** Optional: agent harness (e.g. "openhands", "swe-agent"). */
  harness?: string;
  /** Optional: model that drove the agent. */
  model?: string;
}

const SAFETY: readonly Safety[] = ["read_only", "idempotent", "side_effecting"];

/** A line that could not be parsed. */
export interface TraceParseError {
  line: number;
  message: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const NUMERIC = ["result_bytes", "tool_ms", "think_ms"] as const;

/** Validate one parsed JSON value as a {@link Trajectory}. Throws a descriptive Error. */
export function validateTrajectory(v: unknown, fallbackId: string): Trajectory {
  if (!isPlainObject(v)) throw new Error("trajectory must be a JSON object");
  const id = v.id === undefined ? fallbackId : v.id;
  if (typeof id !== "string" && typeof id !== "number") throw new Error("`id` must be a string or number");
  if (!Array.isArray(v.steps)) throw new Error("`steps` must be an array");
  const steps: TraceStep[] = v.steps.map((s: unknown, i: number) => {
    if (!isPlainObject(s)) throw new Error(`steps[${i}] must be an object`);
    if (typeof s.tool !== "string" || s.tool.length === 0) throw new Error(`steps[${i}].tool must be a non-empty string`);
    if (s.args !== undefined && s.args !== null && !isPlainObject(s.args)) throw new Error(`steps[${i}].args must be an object`);
    const step: TraceStep = { tool: s.tool, args: (s.args as Record<string, unknown> | undefined) ?? {} };
    for (const k of NUMERIC) {
      const x = s[k];
      if (x === undefined || x === null) continue;
      if (typeof x !== "number" || !Number.isFinite(x) || x < 0) throw new Error(`steps[${i}].${k} must be a non-negative number`);
      step[k] = x;
    }
    if (s.result !== undefined) step.result = s.result;
    if (typeof s.error === "boolean" || typeof s.error === "string") step.error = s.error;
    if (s.cls !== undefined && s.cls !== null) {
      if (!SAFETY.includes(s.cls as Safety)) throw new Error(`steps[${i}].cls must be one of ${SAFETY.join("|")}`);
      step.cls = s.cls as Safety;
    }
    return step;
  });
  const t: Trajectory = { id: String(id), steps };
  for (const k of ["source", "harness", "model"] as const) if (typeof v[k] === "string") t[k] = v[k];
  return t;
}

/** Parse JSONL text. Blank lines and lines starting with `//` are skipped; bad lines are reported, not thrown. */
export function parseTrajectoriesJsonl(text: string): { trajectories: Trajectory[]; errors: TraceParseError[] } {
  const trajectories: Trajectory[] = [];
  const errors: TraceParseError[] = [];
  text.split(/\r?\n/).forEach((line, i) => parseLine(line, i + 1, trajectories, errors));
  return { trajectories, errors };
}

/** Stream-parse a JSONL file, gzip-compressed if the name ends in `.gz` (constant memory per line). */
export async function readTrajectoriesFile(path: string): Promise<{ trajectories: Trajectory[]; errors: TraceParseError[] }> {
  const trajectories: Trajectory[] = [];
  const errors: TraceParseError[] = [];
  const file = createReadStream(path);
  const input = /\.gz$/i.test(path) ? file.pipe(createGunzip()) : file;
  input.setEncoding("utf8");
  // surface read/decompression errors through the async iterator below
  file.on("error", (e) => input.destroy(e));
  const rl = createInterface({ input, crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) parseLine(line, ++n, trajectories, errors);
  return { trajectories, errors };
}

function parseLine(line: string, lineNo: number, out: Trajectory[], errors: TraceParseError[]): void {
  const t = line.trim();
  if (!t || t.startsWith("//")) return;
  try {
    out.push(validateTrajectory(JSON.parse(t), `line-${lineNo}`));
  } catch (e) {
    errors.push({ line: lineNo, message: e instanceof Error ? e.message : String(e) });
  }
}
