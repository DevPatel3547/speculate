import { callKey, canonicalJson } from "../../src/canonical.js";
import type { Speculator } from "../../src/speculator.js";
import type { Clock, Step, ToolCall, ToolRegistry } from "../../src/types.js";
import { srcPath, testPath, type Repo } from "./repo.js";
import { keyedLognormal, Rng } from "./rng.js";

/** Model "thinking" time per turn kind: [median ms, log-sigma]. Covers TTFT + output tokens. */
export const THINK: Record<string, [number, number]> = {
  orient: [3500, 0.45], // first turn: read the issue, plan
  short: [1800, 0.45], // decide the next read/search
  edit: [7000, 0.45], // generate a file edit (many output tokens)
  final: [4000, 0.45], // write the final answer
};

type Outcome = { ok: true; value: unknown } | { ok: false; error: string };

export interface AgentRun {
  wallMs: number;
  turns: number;
  calls: number;
  /** Every (call, outcome) the agent observed, in order: must be identical with and without speculation. */
  transcript: string[];
  finalFs: string;
  steps: Step[];
}

export interface AgentEnv {
  taskId: string;
  repo: Repo;
  tools: ToolRegistry;
  clock: Clock;
  speculator?: Speculator;
}

function filesFromGrep(out: unknown): string[] {
  if (typeof out !== "string") return [];
  const seen: string[] = [];
  for (const line of out.split("\n")) {
    const m = /^([^:]+):\d+:/.exec(line);
    if (m && !seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

function definedFns(src: unknown): string[] {
  if (typeof src !== "string") return [];
  return [...src.matchAll(/export function (\w+)/g)].map((m) => m[1]);
}

/**
 * A scripted-but-stochastic coding agent: locate a bug by searching/reading,
 * edit, run tests, iterate. Its *decisions* depend only on its own seeded RNG and
 * on tool results, so if speculation ever returned a different result the
 * trajectory (and transcript) would diverge — which the benchmark checks.
 */
export async function runCodingAgent(env: AgentEnv): Promise<AgentRun> {
  const { taskId, repo, tools, clock, speculator } = env;
  const rng = new Rng(`policy:${taskId}`);
  const transcript: string[] = [];
  const steps: Step[] = [];
  let turn = 0;
  let calls = 0;
  const t0 = clock.now();

  const exec = async (c: ToolCall): Promise<unknown> => {
    if (speculator) return speculator.call(c);
    const t = tools[c.name];
    return t.handler(c.args, { signal: new AbortController().signal, speculative: false });
  };

  const act = async (cs: ToolCall[], kind: keyof typeof THINK): Promise<Outcome[]> => {
    const [median, sigma] = THINK[kind];
    const think = keyedLognormal(`think|${taskId}|${turn}`, median, sigma);
    // the model starts generating: this is the speculation window
    if (speculator) void speculator.beginRound({ meta: { taskId, turn, nextCalls: cs } });
    turn++;
    await clock.sleep(think);
    const outs: Outcome[] = [];
    for (const c of cs) {
      calls++;
      try {
        const value = await exec(c);
        outs.push({ ok: true, value });
        steps.push({ call: c, result: value });
        transcript.push(`${callKey(c)} => ${canonicalJson(value)}`);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        outs.push({ ok: false, error });
        steps.push({ call: c, error });
        transcript.push(`${callKey(c)} => ERROR ${error}`);
      }
    }
    return outs;
  };
  const val = (o: Outcome[] | undefined, i = 0) => (o && o[i]?.ok ? (o[i] as { value: unknown }).value : undefined);
  const read = new Set<string>();
  const readFile = async (p: string, kind: keyof typeof THINK = "short") => {
    read.add(p);
    return val(await act([{ name: "read_file", args: { path: p } }], kind));
  };
  const noise = async () => {
    if (!rng.chance(0.2)) return;
    if (rng.chance(0.6)) await readFile(rng.pick(repo.vfs.paths()));
    else await act([{ name: "list_dir", args: { path: rng.pick(["test", "src", "."]) } }], "short");
  };

  const S = repo.bugFn; // the symbol named in the issue text
  const defFile = srcPath(repo.bugModule);

  // 1. orient
  if (rng.chance(0.8)) await act([{ name: "list_dir", args: { path: "." } }], "orient");
  if (rng.chance(0.6)) await act([{ name: "list_dir", args: { path: "src" } }], "short");
  await noise();

  // 2. locate
  const g = val(await act([{ name: "grep", args: { pattern: S, path: rng.chance(0.75) ? "src" : "." } }], "short"));
  const hits = filesFromGrep(g);
  if (hits.length >= 2 && rng.chance(0.25)) {
    hits.slice(0, 2).forEach((h) => read.add(h));
    await act(
      hits.slice(0, 2).map((h) => ({ name: "read_file", args: { path: h } })),
      "short",
    );
  } else if (hits.length) {
    await readFile(hits[0]);
  }
  for (let guard = 0; !read.has(defFile) && guard < 3; guard++) {
    const next = hits.find((h) => !read.has(h)) ?? defFile;
    await readFile(next);
  }
  // after read_file(X), often grep(a symbol defined in X)
  if (rng.chance(0.6)) {
    const fns = definedFns(repo.vfs.read(defFile)).slice(0, 2);
    const ident = rng.pick(fns);
    const g2 = val(await act([{ name: "grep", args: { pattern: ident, path: "src" } }], "short"));
    const h2 = filesFromGrep(g2).find((h) => !read.has(h));
    if (h2 && rng.chance(0.5)) await readFile(h2);
  }
  await noise();
  if (rng.chance(0.5)) {
    const g3 = val(await act([{ name: "grep", args: { pattern: S, path: "test" } }], "short"));
    const h3 = filesFromGrep(g3)[0];
    if (h3) await readFile(h3);
  } else if (rng.chance(0.4)) {
    await readFile(testPath(repo.bugModule));
  }

  // 3. fix / test loop
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = repo.vfs.read(defFile); // the agent "remembers" the file it read
    const good = rng.chance(attempt === 0 ? 0.6 : 0.85);
    const content = good
      ? current.replace("return input; // BUG: missing validation", "if (input == null) throw new Error('invalid');\n  return input;")
      : current + `\n// attempted fix ${attempt}\n`;
    await act([{ name: "write_file", args: { path: defFile, content } }], "edit");
    const t = val(await act([{ name: "run_tests", args: {} }], "short"));
    if (typeof t === "string" && !t.includes("FAIL")) break;
    const failing = typeof t === "string" ? /FAIL (\S+)/.exec(t)?.[1] : undefined;
    if (failing) await readFile(failing);
    if (rng.chance(0.5)) await readFile(defFile); // re-read own edit: must never be served stale
  }

  // 4. final answer
  await act([], "final");
  return { wallMs: clock.now() - t0, turns: turn, calls, transcript, finalFs: repo.vfs.digest(), steps };
}
