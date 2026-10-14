// Smoke tests against the BUILT package (dist/), run with `node --test` on every
// supported Node version. Imports go through the package's own "exports" map.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Speculator, SpeculatorPool, NGramPredictor, VERSION, callKey, classifyTool } from "speculate-tools";
import { createSpeculativeMcpProxy } from "speculate-tools/mcp";
import { evaluateTraces, readTrajectoriesFile } from "speculate-tools/eval";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const predictor = (calls) => ({
  name: "fixed",
  predict: async () => ({ predictions: calls.map((call) => ({ call, score: 0.9, source: "fixed" })) }),
});

function store() {
  const data = new Map([["a", "1"]]);
  const log = [];
  const tools = {
    get_value: {
      spec: { name: "get_value", description: "Get a value" },
      handler: async (a, c) => (log.push(`${c.speculative ? "spec" : "real"}:get:${a.key}`), await sleep(20), data.get(a.key) ?? null),
    },
    put_value: {
      spec: { name: "put_value", description: "Put a value" },
      handler: async (a) => (log.push(`real:put:${a.key}`), data.set(a.key, a.value), "ok"),
    },
  };
  return { data, log, tools };
}

test("version and keys", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
  assert.equal(callKey({ name: "x", args: { a: 1, b: 2 } }), callKey({ name: "x", args: { b: 2, a: 1 } }));
  assert.equal(classifyTool({ name: "delete_everything", annotations: { readOnlyHint: true } }).safety, "side_effecting");
});

test("hit, then a write invalidates", async () => {
  const { log, tools } = store();
  const s = new Speculator({
    tools,
    predictor: predictor([
      { name: "get_value", args: { key: "a" } },
      { name: "put_value", args: { key: "a", value: "evil" } },
    ]),
  });
  await s.beginRound();
  await s.drain();
  assert.equal(await s.call({ name: "get_value", args: { key: "a" } }), "1");
  assert.equal(s.metrics().hits, 1);
  await s.beginRound();
  await s.drain();
  await s.call({ name: "put_value", args: { key: "a", value: "2" } });
  assert.equal(await s.call({ name: "get_value", args: { key: "a" } }), "2");
  assert.ok(!log.includes("spec:put:a"), "a side-effecting tool was speculated");
  s.close();
});

test("sessions are isolated", async () => {
  const { tools } = store();
  const pool = new SpeculatorPool({ tools, predictor: () => predictor([{ name: "get_value", args: { key: "a" } }]) });
  const a = pool.session("user-a");
  await a.beginRound();
  await a.drain();
  const b = pool.session("user-b");
  await b.call({ name: "get_value", args: { key: "a" } });
  assert.equal(b.metrics().hits, 0);
  assert.equal(pool.size, 2);
  pool.close();
});

test("eval entry point on the sample traces", async () => {
  const { trajectories, errors } = await readTrajectoriesFile(join(root, "examples/traces/sample.jsonl"));
  assert.equal(errors.length, 0);
  const r = evaluateTraces(trajectories);
  assert.ok(r.top1.rate > 0 && r.top3.rate >= r.top1.rate);
  assert.ok(new NGramPredictor());
});

test("CLI: --help, --version, eval-traces --json", () => {
  const bin = join(root, "dist/cli/bin.js");
  const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /mcp-proxy/);
  const ph = spawnSync(process.execPath, [bin, "mcp-proxy", "--help"], { encoding: "utf8" });
  assert.equal(ph.status, 0);
  assert.match(ph.stdout, /Usage: speculate-tools mcp-proxy/);
  const v = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
  assert.equal(v.stdout.trim(), VERSION);
  const ev = spawnSync(process.execPath, [bin, "eval-traces", "--json", join(root, "examples/traces/sample.jsonl")], { encoding: "utf8" });
  assert.equal(ev.status, 0, ev.stderr);
  assert.ok(JSON.parse(ev.stdout).top1.rate > 0);
  const bad = spawnSync(process.execPath, [bin, "mcp-proxy", "--top-k", "x", "--", "true"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
});

test("CLI: mcp-proxy end to end over real stdio", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "dist/cli/bin.js"), "mcp-proxy", "--", process.execPath, join(root, "test-dist/fixtures/upstream-server.mjs")],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  const c = new Client({ name: "smoke", version: "0" });
  await c.connect(transport);
  const text = (r) => r.content[0].text;
  try {
    const tools = await c.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["get_note", "save_note"]);
    // teach the online n-gram: a -> b, three times
    for (let i = 0; i < 3; i++) {
      assert.equal(text(await c.callTool({ name: "get_note", arguments: { id: "a" } })), "alpha");
      await sleep(400);
      assert.equal(text(await c.callTool({ name: "get_note", arguments: { id: "b" } })), "beta");
      await sleep(400);
    }
    const t0 = performance.now();
    assert.equal(text(await c.callTool({ name: "get_note", arguments: { id: "a" } })), "alpha");
    assert.ok(performance.now() - t0 < 250, "expected a speculative hit");
    assert.equal(text(await c.callTool({ name: "save_note", arguments: { id: "a", text: "new" } })), "saved (1)");
    assert.equal(text(await c.callTool({ name: "get_note", arguments: { id: "a" } })), "new");
  } finally {
    await c.close();
  }
  await sleep(200);
  assert.match(stderr, /\[speculate\] calls=\d+ hits=[1-9]/);
});

test("in-process MCP proxy factory is exported", () => {
  assert.equal(typeof createSpeculativeMcpProxy, "function");
});
