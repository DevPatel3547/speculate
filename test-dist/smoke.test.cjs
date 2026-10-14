// CommonJS consumers: require() resolves the "require" condition of the exports map.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const lib = require("speculate-tools");
const mcp = require("speculate-tools/mcp");
const evalApi = require("speculate-tools/eval");

test("CJS entry points load and work", async () => {
  assert.equal(typeof lib.Speculator, "function");
  assert.equal(typeof mcp.createSpeculativeMcpProxy, "function");
  assert.equal(typeof evalApi.evaluateTraces, "function");
  let n = 0;
  const tools = { read_thing: { spec: { name: "read_thing" }, handler: async () => ++n } };
  const s = lib.speculate(tools, {
    predictor: { name: "p", predict: async () => ({ predictions: [{ call: { name: "read_thing", args: {} }, score: 1, source: "p" }] }) },
  });
  s.onModelStart();
  await s.speculator.drain();
  assert.equal(await s.tools.read_thing.handler({}, { signal: new AbortController().signal, speculative: false }), 1);
  assert.equal(s.metrics().hits, 1);
  s.close();
  const { trajectories } = evalApi.parseTrajectoriesJsonl('{"id":"a","steps":[{"tool":"read_file","args":{"path":"x"}}]}');
  assert.equal(trajectories.length, 1);
});
