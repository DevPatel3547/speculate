import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseIntArg, parseNumberArg, stderrLogger, UsageError } from "../src/cli/common.js";
import { main, MAIN_HELP } from "../src/cli/main.js";
import { loadTraces, MCP_PROXY_HELP, parseMcpProxyArgs, runMcpProxy } from "../src/cli/mcp-proxy.js";
import { VERSION } from "../src/version.js";
import pkg from "../package.json" with { type: "json" };

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) } };
}

describe("speculate-tools CLI", () => {
  it("VERSION matches package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("main: help, version, unknown command", async () => {
    let c = io();
    expect(await main(["--help"], c.io)).toBe(0);
    expect(c.out.join("")).toBe(MAIN_HELP);
    c = io();
    expect(await main([], c.io)).toBe(2);
    c = io();
    expect(await main(["--version"], c.io)).toBe(0);
    expect(c.out).toEqual([VERSION]);
    c = io();
    expect(await main(["frobnicate"], c.io)).toBe(2);
    expect(c.err.join("")).toMatch(/unknown command "frobnicate"/);
    c = io();
    expect(await main(["mcp-proxy", "--help"], c.io)).toBe(0);
    expect(c.out.join("")).toBe(MCP_PROXY_HELP);
    c = io();
    expect(await main(["eval-traces", "--help"], c.io)).toBe(0);
  });

  it("parses mcp-proxy flags", () => {
    const a = parseMcpProxyArgs([
      "--top-k",
      "4",
      "--max-concurrency",
      "2",
      "--timeout-ms",
      "500",
      "--max-age-ms",
      "0",
      "--allow-idempotent",
      "--allow-open-world",
      "--read-only",
      "a, b",
      "--idempotent",
      "c",
      "--side-effecting",
      "d",
      "--no-trust-annotations",
      "--no-heuristics",
      "--strict-open-world",
      "--traces",
      "t.jsonl",
      "--log-level",
      "debug",
      "--log-args",
      "--",
      "npx",
      "-y",
      "server",
      "--top-k",
      "9",
    ]);
    expect(a).toEqual({
      command: "npx",
      args: ["-y", "server", "--top-k", "9"], // flags after -- belong to the upstream
      topK: 4,
      maxConcurrency: 2,
      timeoutMs: 500,
      maxAgeMs: 0,
      allow: ["read_only", "idempotent"],
      allowOpenWorld: true,
      classifier: {
        overrides: { a: "read_only", b: "read_only", c: "idempotent", d: "side_effecting" },
        trustAnnotations: false,
        heuristics: false,
        openWorldByDefault: true,
      },
      traces: "t.jsonl",
      logLevel: "debug",
      logArgs: true,
    });
    const d = parseMcpProxyArgs(["--", "server"]);
    expect(d).toMatchObject({ topK: 2, allow: ["read_only"], allowOpenWorld: false, logLevel: "warn", logArgs: false });
    expect(parseMcpProxyArgs(["-h"])).toBe("help");
  });

  it("rejects bad mcp-proxy usage with exit code 2", async () => {
    const bad = [
      ["--top-k", "x", "--", "s"],
      ["--top-k", "-1", "--", "s"],
      ["--log-level", "loud", "--", "s"],
      ["--bogus", "--", "s"],
      ["server"],
      ["--"],
      [],
    ];
    for (const argv of bad) {
      const c = io();
      expect(await runMcpProxy(argv, c.io)).toBe(2);
      expect(c.err.join("")).toMatch(/--help/);
    }
    expect(() => parseMcpProxyArgs(["extra", "--", "s"])).toThrow(UsageError);
  });

  it("reports an upstream that cannot be started (exit 1)", async () => {
    const c = io();
    expect(await runMcpProxy(["--log-level", "silent", "--", "/definitely/not/a/command-xyz"], c.io)).toBe(1);
    expect(c.err.join("")).toMatch(/failed to start upstream/);
  });

  it("loads traces from JSONL (trace format) and JSON (Trace[])", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-cli-"));
    try {
      const jl = join(dir, "t.jsonl");
      await writeFile(jl, '{"id":"a","steps":[{"tool":"grep","args":{"p":1},"result":"src/a.ts:1"}]}\nnope\n');
      const r1 = await loadTraces(jl);
      expect(r1).toEqual({ traces: [{ id: "a", steps: [{ call: { name: "grep", args: { p: 1 } }, result: "src/a.ts:1" }] }], skipped: 1 });
      const js = join(dir, "t.json");
      await writeFile(js, JSON.stringify([{ steps: [{ call: { name: "x", args: {} } }] }, { bad: 1 }]));
      expect(await loadTraces(js)).toMatchObject({ skipped: 1, traces: [{ steps: [{ call: { name: "x" } }] }] });
      await writeFile(js, "{}");
      await expect(loadTraces(js)).rejects.toThrow(UsageError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stderr logger respects levels and never throws on odd fields", () => {
    const c = io();
    const log = stderrLogger("info", c.io);
    log.debug("hidden");
    log.info("shown", { a: 1 });
    log.warn("w");
    log.error("e");
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    log.info("circ", circ);
    expect(c.err).toEqual([
      '[speculate] info shown {"a":1}',
      "[speculate] warn w",
      "[speculate] error e",
      "[speculate] info circ [unserializable fields]",
    ]);
    const silent = io();
    stderrLogger("silent", silent.io).error("x");
    expect(silent.err).toEqual([]);
  });

  it("numeric argument parsing", () => {
    expect(parseIntArg("--n", "3", 1)).toBe(3);
    expect(parseIntArg("--n", undefined, 1)).toBeUndefined();
    expect(() => parseIntArg("--n", "1.5", 1)).toThrow(UsageError);
    expect(parseNumberArg("--f", "0.5", 0, 1)).toBe(0.5);
    expect(() => parseNumberArg("--f", "", 0)).toThrow(UsageError);
    expect(() => parseNumberArg("--f", "2", 0, 1)).toThrow(UsageError);
  });
});
