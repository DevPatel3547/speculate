/**
 * 60-second quickstart: wrap your tools, start speculating when the model starts
 * thinking, call tools as usual. Run: npx tsx examples/quickstart.ts
 */
import { NGramPredictor, speculate, type ToolRegistry } from "../src/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const files: Record<string, string> = { "README.md": "see src/app.ts", "src/app.ts": "export function main() {}" };

// 1. Your tools. Names/annotations decide what is safe to pre-run: read_file and list_files
//    are read-only; write_file is side-effecting and is NEVER speculated.
const tools: ToolRegistry = {
  list_files: {
    spec: { name: "list_files", description: "List files" },
    handler: async () => (await sleep(300), Object.keys(files).join("\n")),
  },
  read_file: {
    spec: { name: "read_file", description: "Read a file" },
    handler: async (a) => (await sleep(300), files[String(a.path)] ?? "ENOENT"),
  },
  write_file: {
    spec: { name: "write_file", description: "Write a file" },
    handler: async (a) => ((files[String(a.path)] = String(a.content)), "ok"),
  },
};

// 2. A predictor. The n-gram learns call patterns from past sessions (and online).
const past = [
  {
    steps: [
      { call: { name: "list_files", args: {} }, result: "README.md\nsrc/app.ts" },
      { call: { name: "read_file", args: { path: "README.md" } }, result: "see src/app.ts" },
    ],
  },
];
const s = speculate(tools, { predictor: new NGramPredictor().train([...past, ...past]) });

// 3. Your agent loop (the "model" here is a 500 ms sleep and a fixed plan).
const plan = [
  { name: "list_files", args: {} },
  { name: "read_file", args: { path: "README.md" } },
  { name: "write_file", args: { path: "notes.md", content: "hi" } },
];
for (const call of plan) {
  s.onModelStart(); // speculation starts while the model thinks (do not await)
  await sleep(500); // ...model thinking...
  const t0 = performance.now();
  const out = await s.tools[call.name].handler(call.args, { signal: new AbortController().signal, speculative: false });
  console.log(`${call.name.padEnd(10)} -> ${JSON.stringify(out).slice(0, 30).padEnd(32)} ${(performance.now() - t0).toFixed(0)} ms`);
}
const m = s.metrics();
console.log(`hits=${m.hits} joins=${m.joins} saved=${m.latencySavedMs.toFixed(0)}ms launched=${m.launched} wasted=${m.wasted}`);
s.close();
