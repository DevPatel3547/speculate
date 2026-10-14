/** Runs every offline example in sequence (used in CI). Run: npm run examples */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules/.bin/tsx");
const runs: [string, string[]][] = [
  ["examples/quickstart.ts", []],
  ["examples/session-pool.ts", []],
  ["examples/local-llm-predictor.ts", []],
  ["examples/try-proxy.ts", []],
  ["src/cli/bin.ts", ["eval-traces", "examples/traces/sample.jsonl"]],
];
let failed = 0;
for (const [file, args] of runs) {
  console.log(`\n=== ${file} ${args.join(" ")}`);
  const r = spawnSync(tsx, [join(root, file), ...args], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, LLM_BASE_URL: process.env.LLM_BASE_URL ?? "http://127.0.0.1:9/v1" },
  });
  if (r.status !== 0) {
    failed++;
    console.error(`!!! ${file} exited with ${r.status}`);
  }
}
process.exit(failed ? 1 : 0);
