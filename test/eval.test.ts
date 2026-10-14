import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateTraces, formatEvalReport } from "../src/eval/evaluate.js";
import { parseTrajectoriesJsonl, readTrajectoriesFile, validateTrajectory, type Trajectory } from "../src/eval/trace-format.js";
import { parseToolClasses, runEvalTraces } from "../src/cli/eval-traces.js";

const SAMPLE = join(__dirname, "..", "examples", "traces", "sample.jsonl");

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) } };
}

/** grep(sym) -> read_file(first hit) -> write_file, repeated with different symbols/files. */
function synthetic(n: number, timing = true): Trajectory[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    steps: [
      { tool: "list_dir", args: { path: "." }, ...(timing ? { think_ms: 3000, tool_ms: 100 } : {}) },
      {
        tool: "grep",
        args: { pattern: `sym${i}`, path: "src" },
        result: `src/f${i}.ts:3: sym${i}()`,
        ...(timing ? { think_ms: 1000, tool_ms: 800 } : {}),
      },
      { tool: "read_file", args: { path: `src/f${i}.ts` }, ...(timing ? { think_ms: 1500, tool_ms: 200 } : {}) },
      { tool: "write_file", args: { path: `src/f${i}.ts`, content: "x" }, ...(timing ? { think_ms: 5000, tool_ms: 100 } : {}) },
    ],
  }));
}

describe("trace format", () => {
  it("parses JSONL, skipping blank/comment lines and reporting bad lines with line numbers", () => {
    const text = [
      '{"id":"a","steps":[{"tool":"read_file","args":{"path":"x"},"tool_ms":5,"think_ms":10,"result_bytes":3}]}',
      "",
      "// comment",
      "{not json",
      '{"id":"b","steps":[{"tool":""}]}',
      '{"id":"c","steps":[{"tool":"t","args":[1]}]}',
      '{"id":"d","steps":[{"tool":"t","tool_ms":-1}]}',
      '{"steps":[{"tool":"t","args":null,"error":true,"extra":"ignored"}]}',
      "[1,2]",
      '{"id":{"x":1},"steps":[]}',
      '{"id":"e","steps":{}}',
      '{"id":"f","steps":[7]}',
    ].join("\n");
    const { trajectories, errors } = parseTrajectoriesJsonl(text);
    expect(trajectories.map((t) => t.id)).toEqual(["a", "line-8"]);
    expect(trajectories[0].steps[0]).toEqual({ tool: "read_file", args: { path: "x" }, tool_ms: 5, think_ms: 10, result_bytes: 3 });
    expect(trajectories[1].steps[0]).toEqual({ tool: "t", args: {}, error: true });
    expect(errors.map((e) => e.line)).toEqual([4, 5, 6, 7, 9, 10, 11, 12]);
    expect(errors[1].message).toMatch(/steps\[0\]\.tool/);
  });

  it("numeric ids are accepted as strings", () => {
    expect(validateTrajectory({ id: 7, steps: [] }, "x").id).toBe("7");
  });

  it("streams files", async () => {
    const { trajectories, errors } = await readTrajectoriesFile(SAMPLE);
    expect(errors).toEqual([]);
    expect(trajectories.length).toBe(12);
  });
});

describe("evaluateTraces", () => {
  it("is deterministic and splits by trajectory, not by step", () => {
    const t = synthetic(40);
    const a = evaluateTraces(t);
    const b = evaluateTraces(t);
    expect(a).toEqual(b);
    expect(a.trajectories.train + a.trajectories.test).toBe(40);
    expect(a.steps.train + a.steps.test).toBe(160);
    expect(a.steps.test % 4).toBe(0);
    const c = evaluateTraces(t, { seed: "other" });
    expect(c.trajectories.test).not.toBe(0);
  });

  it("learns the grep -> read_file(first hit) template and estimates savings from measured timings", () => {
    const r = evaluateTraces(synthetic(40));
    // list_dir(".") and read_file(<first grep hit>) are predictable; grep(new symbol) is not
    const byTool = Object.fromEntries(r.perTool.map((t) => [t.tool, t]));
    expect(byTool.list_dir.top1 / byTool.list_dir.testSteps).toBe(1);
    expect(byTool.read_file.top1 / byTool.read_file.testSteps).toBe(1);
    expect(byTool.grep.top3).toBe(0);
    expect(byTool.write_file.speculable).toBe(false);
    expect(r.speculableShare).toBeCloseTo(0.75);
    expect(r.top1.rate).toBeCloseTo(2 / 3);
    expect(r.toolNameTop1.rate).toBeGreaterThanOrEqual(r.top1.rate);
    // each test trajectory: list_dir saves 100 (fits in 3000), read_file saves 200 (fits in 1500)
    const nTest = r.trajectories.test;
    expect(r.latency.savedMs).toBe(nTest * 300);
    expect(r.latency.baselineMs).toBe(nTest * (3000 + 100 + 1000 + 800 + 1500 + 200 + 5000 + 100));
    expect(r.latency.fullHits).toBe(nTest * 2);
    expect(r.latency.measuredThinkShare).toBe(1);
  });

  it("uses timing assumptions when the trace has no timings, and counts partial (joined) hits", () => {
    const r = evaluateTraces(synthetic(40, false), { timing: { defaultThinkMs: 100, defaultToolMs: 250, predictorMs: 20 } });
    expect(r.latency.measuredThinkShare).toBe(0);
    expect(r.latency.partialHits).toBe(r.latency.fullHits + r.latency.partialHits);
    expect(r.latency.savedMs).toBe(r.top1.hits * 80); // window = 100 - 20 < tool 250
    expect(r.latency.assumptions).toEqual({ defaultThinkMs: 100, defaultToolMs: 250, predictorMs: 20 });
  });

  it("respects policy: overrides, idempotent and open-world opt-ins", () => {
    const t: Trajectory[] = Array.from({ length: 10 }, (_, i) => ({
      id: `w${i}`,
      steps: [
        { tool: "web_fetch", args: { url: "https://example.com" } },
        { tool: "frobnicate", args: {} },
        { tool: "run_tests", args: {} },
      ],
    }));
    const base = evaluateTraces(t);
    expect(base.speculableSteps).toBe(0);
    expect(base.top1.rate).toBe(0);
    const opted = evaluateTraces(t, {
      allowOpenWorld: true,
      allow: ["read_only", "idempotent"],
      classifier: { overrides: { frobnicate: "read_only", run_tests: "idempotent", web_fetch: "read_only" } },
    });
    expect(opted.speculableSteps).toBe(opted.steps.test);
    expect(opted.top1.rate).toBe(1);
  });

  it("forces a non-empty train and test set on tiny inputs and validates options", () => {
    const r = evaluateTraces(synthetic(2));
    expect(r.trajectories).toEqual({ total: 2, train: 1, test: 1 });
    expect(() => evaluateTraces(synthetic(2), { testFraction: 1 })).toThrow(RangeError);
    expect(() => evaluateTraces(synthetic(2), { topK: 0 })).toThrow(RangeError);
    expect(evaluateTraces([]).top1.rate).toBe(0);
  });

  it("offline mode does not learn from test trajectories", () => {
    const t = synthetic(40);
    expect(evaluateTraces(t, { online: false }).top1.rate).toBeLessThanOrEqual(evaluateTraces(t).top1.rate);
  });

  it("formats a readable report", () => {
    const s = formatEvalReport(evaluateTraces(synthetic(20), { topK: 5 }));
    expect(s).toMatch(/top-1/);
    expect(s).toMatch(/top-5 \(launch\)/);
    expect(s).toMatch(/ESTIMATED latency saved/);
    expect(s).toMatch(/write_file .*not speculated/);
  });
});

describe("eval-traces CLI", () => {
  it("prints a report for the sample file", async () => {
    const c = io();
    expect(await runEvalTraces([SAMPLE], c.io)).toBe(0);
    expect(c.out.join("\n")).toMatch(/hit rate over speculable test steps/);
  });

  it("--json emits machine-readable output and honours options", async () => {
    const c = io();
    const code = await runEvalTraces(
      [
        SAMPLE,
        "--json",
        "--top-k",
        "1",
        "--seed",
        "x",
        "--test-fraction",
        "0.5",
        "--no-online",
        "--think-ms",
        "10",
        "--tool-ms",
        "5",
        "--predictor-ms",
        "1",
        "--read-only",
        "run_tests",
        "--idempotent",
        "a",
        "--side-effecting",
        "list_dir",
        "--allow-idempotent",
        "--allow-open-world",
      ],
      c.io,
    );
    expect(code).toBe(0);
    const r = JSON.parse(c.out.join(""));
    expect(r.options).toMatchObject({
      topK: 1,
      seed: "x",
      testFraction: 0.5,
      online: false,
      allowOpenWorld: true,
      allow: ["read_only", "idempotent"],
    });
    expect(r.perTool.find((t: { tool: string }) => t.tool === "list_dir").speculable).toBe(false);
  });

  it("usage errors exit 2; unreadable files exit 1; --strict fails on bad lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-eval-"));
    try {
      let c = io();
      expect(await runEvalTraces([], c.io)).toBe(2);
      expect(await runEvalTraces(["a", "b"], c.io)).toBe(2);
      expect(await runEvalTraces(["--bogus", "a"], c.io)).toBe(2);
      expect(await runEvalTraces([SAMPLE, "--top-k", "zero"], c.io)).toBe(2);
      expect(await runEvalTraces([SAMPLE, "--test-fraction", "1"], c.io)).toBe(2);
      expect(await runEvalTraces([join(dir, "missing.jsonl")], c.io)).toBe(1);
      const bad = join(dir, "bad.jsonl");
      await writeFile(bad, "{oops\n" + '{"id":"a","steps":[]}\n{"id":"b","steps":[]}\n');
      c = io();
      expect(await runEvalTraces([bad], c.io)).toBe(0);
      expect(c.err.join("\n")).toMatch(/1 invalid line.*skipped[\s\S]*line 1/);
      expect(await runEvalTraces([bad, "--strict"], io().io)).toBe(1);
      const one = join(dir, "one.jsonl");
      await writeFile(one, '{"id":"a","steps":[]}\n');
      c = io();
      expect(await runEvalTraces([one], c.io)).toBe(1);
      expect(c.err.join("")).toMatch(/at least 2/);
      c = io();
      expect(await runEvalTraces(["--help"], c.io)).toBe(0);
      expect(c.out.join("")).toMatch(/Usage: speculate-tools eval-traces/);
      const many = join(dir, "many.jsonl");
      await writeFile(many, Array.from({ length: 8 }, () => "x").join("\n") + '\n{"id":"a","steps":[]}\n{"id":"b","steps":[]}\n');
      c = io();
      await runEvalTraces([many], c.io);
      expect(c.err.join("\n")).toMatch(/and 3 more/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Real-data shaped trajectories: per-step `cls`, provenance fields, shell pseudo-tools. */
function realShaped(n: number, prefix: string, source: string): Trajectory[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    source,
    steps: [
      { tool: "think", args: { thought: "plan" }, cls: "read_only" as const, think_ms: 4000, tool_ms: 1 },
      { tool: "sh:ls", args: { cmd: "ls" }, cls: "read_only" as const, think_ms: 5000, tool_ms: 400 },
      // same tool, but this instance redirects into a file: its own class is side_effecting
      { tool: "sh:grep", args: { cmd: "grep -r foo . > out.txt" }, cls: "side_effecting" as const },
      { tool: "sh:grep", args: { cmd: `grep -r sym${i} .` }, cls: "read_only" as const },
      { tool: "editor.str_replace", args: { path: `f${i}.py` }, cls: "side_effecting" as const },
    ],
  }));
}

describe("real-data format support", () => {
  it("parses cls and provenance fields, rejects invalid cls", () => {
    const { trajectories, errors } = parseTrajectoriesJsonl(
      '{"id":"a","source":"ds","harness":"h","model":"m","instance_id":"x","resolved":true,"steps":[{"tool":"sh:ls","args":{"cmd":"ls"},"cls":"read_only"}]}\n' +
        '{"id":"b","steps":[{"tool":"t","cls":"maybe"}]}',
    );
    expect(trajectories[0]).toEqual({
      id: "a",
      source: "ds",
      harness: "h",
      model: "m",
      steps: [{ tool: "sh:ls", args: { cmd: "ls" }, cls: "read_only" }],
    });
    expect(errors[0].message).toMatch(/cls must be one of/);
  });

  it("reads .jsonl.gz files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-gz-"));
    try {
      const f = join(dir, "t.jsonl.gz");
      await writeFile(
        f,
        gzipSync(
          realShaped(3, "x", "s")
            .map((t) => JSON.stringify(t))
            .join("\n"),
        ),
      );
      const { trajectories, errors } = await readTrajectoriesFile(f);
      expect(errors).toEqual([]);
      expect(trajectories).toHaveLength(3);
      await writeFile(join(dir, "bad.gz"), "not gzip");
      await expect(readTrajectoriesFile(join(dir, "bad.gz"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses per-step classes for scoring and flags exact matches of unsafe instances", () => {
    const t = realShaped(30, "a", "dsA");
    const r = evaluateTraces(t);
    const grep = r.perTool.find((x) => x.tool === "sh:grep")!;
    // tool-level class from the training majority is a tie -> the conservative side_effecting
    expect(grep.safety).toBe("side_effecting");
    const r2 = evaluateTraces(t, { toolClasses: { "sh:grep": "read_only" } });
    const grep2 = r2.perTool.find((x) => x.tool === "sh:grep")!;
    expect(grep2.speculableSteps).toBe(grep2.testSteps / 2); // the redirecting instance is not speculable
    // "grep > out.txt" repeats verbatim: a name-only classifier would have launched it
    expect(r2.unsafeMatches).toBe(r2.trajectories.test);
    const byName = evaluateTraces(t, { toolClasses: { "sh:grep": "read_only" }, useStepClass: false });
    expect(byName.unsafeMatches).toBe(0);
    expect(byName.perTool.find((x) => x.tool === "sh:grep")!.speculableSteps).toBe(grep2.testSteps);
  });

  it("excludeTools removes no-op tools from scoring; ceiling bounds the savings", () => {
    const t = realShaped(30, "a", "dsA");
    const withThink = evaluateTraces(t);
    const without = evaluateTraces(t, { excludeTools: ["think"] });
    expect(withThink.perTool.find((x) => x.tool === "think")!.top1).toBeGreaterThan(0);
    expect(without.perTool.find((x) => x.tool === "think")!.speculableSteps).toBe(0);
    expect(without.options.excludeTools).toEqual(["think"]);
    expect(without.latency.savedMs).toBeLessThanOrEqual(without.latency.ceilingMs);
    expect(without.latency.ceilingFraction).toBeGreaterThan(0);
  });

  it("testPrefixes holds out only matching trajectories and reports per source", () => {
    const t = [...realShaped(20, "big", "big-ds"), ...realShaped(10, "small", "small-ds")];
    const r = evaluateTraces(t, { testPrefixes: ["small-"], testFraction: 0.5 });
    expect(r.perSource.map((x) => x.source)).toEqual(["small-ds"]);
    expect(r.trajectories.train).toBe(30 - r.trajectories.test);
    const all = evaluateTraces(t, { testFraction: 0.5 });
    expect(all.perSource.map((x) => x.source).sort()).toEqual(["big-ds", "small-ds"]);
    expect(formatEvalReport(all)).toMatch(/per source/);
    // id prefix is the fallback source name
    const anon = evaluateTraces(realShaped(10, "p", "x").map(({ source: _s, ...rest }) => rest));
    expect(anon.perSource[0].source).toBe("p");
  });

  it("parseToolClasses accepts tool_classes.json and flat maps", () => {
    expect(parseToolClasses({ classes: {}, tools: { "sh:ls": { class: "read_only", steps: 3 }, x: { class: "nope" } } })).toEqual({
      "sh:ls": "read_only",
    });
    expect(parseToolClasses({ a: "idempotent", b: 3 })).toEqual({ a: "idempotent" });
    expect(() => parseToolClasses([])).toThrow();
  });

  it("CLI: --tool-classes, --only-prefix, --test-prefix, --exclude-tools, --ignore-step-class on a .gz file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-cli-gz-"));
    try {
      const f = join(dir, "t.jsonl.gz");
      const t = [...realShaped(20, "big", "big-ds"), ...realShaped(10, "small", "small-ds")];
      await writeFile(f, gzipSync(t.map((x) => JSON.stringify(x)).join("\n")));
      const classes = join(dir, "classes.json");
      await writeFile(classes, JSON.stringify({ tools: { "sh:grep": { class: "read_only" } } }));
      const c = io();
      const code = await runEvalTraces(
        [
          f,
          "--json",
          "--tool-classes",
          classes,
          "--only-prefix",
          "big-,small-",
          "--test-prefix",
          "small-",
          "--exclude-tools",
          "think",
          "--ignore-step-class",
          "--test-fraction",
          "0.5",
        ],
        c.io,
      );
      expect(code).toBe(0);
      const r = JSON.parse(c.out.join(""));
      expect(r.options).toMatchObject({ useStepClass: false, testPrefixes: ["small-"], excludeTools: ["think"] });
      expect(r.perSource.map((x: { source: string }) => x.source)).toEqual(["small-ds"]);
      const bad = join(dir, "bad.json");
      await writeFile(bad, "[]");
      expect(await runEvalTraces([f, "--tool-classes", bad], io().io)).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
