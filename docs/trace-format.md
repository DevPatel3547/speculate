# Trajectory format for `eval:traces`

`speculate-tools eval-traces` (or `npm run eval:traces -- <file>`) replays recorded agent trajectories offline and
measures how well the n-gram predictor would have predicted each call that is safe to speculate. The input is
**JSON Lines**: one trajectory per line, optionally gzip-compressed (`.jsonl.gz`).

## Schema

```jsonc
{
  "id": "swea-00042",            // required: string or number, unique per trajectory (drives the train/test split)
  "source": "nebius/SWE-agent-trajectories", // optional: provenance, used for the per-source table
  "harness": "swe-agent",        // optional, informational
  "model": "swe-agent-llama-70b",// optional, informational
  "steps": [                     // required: tool calls in the order the agent made them
    {
      "tool": "read_file",       // required: tool name exactly as called
      "args": { "path": "src/a.ts" }, // optional JSON object (default {}); compared exactly (canonical JSON)
      "cls": "read_only",        // optional: read_only | idempotent | side_effecting for THIS call
      "result_bytes": 1234,      // optional: size of the tool result (informational)
      "tool_ms": 350,            // optional: wall time of the tool call
      "think_ms": 1800,          // optional: model time between the previous result (or the prompt) and this call
      "result": "src/a.ts:3: …", // optional: result content; enables result-derived argument templates
      "error": false             // optional: boolean or message
    }
  ]
}
```

Unknown fields (for example `instance_id`, `resolved`) are ignored, so producers can add their own. Blank lines and lines
starting with `//` are skipped. Invalid lines are reported with their line number and skipped (`--strict` fails instead).
A small synthetic example lives in [`examples/traces/sample.jsonl`](../examples/traces/sample.jsonl).

## How the evaluation works

1. **Split by trajectory**, never by step: each trajectory goes to the test set if
   `sha256(seed + "\0" + id)` maps below `--test-fraction` (default 0.3). The split is deterministic and stable when you
   add trajectories. `--test-prefix ohfb-` draws test trajectories only from ids with that prefix and uses all others for
   training. `--only-prefix` evaluates a subset.
2. **Train** an `NGramPredictor` on the training trajectories.
3. **Replay** each test trajectory step by step. Before step *i*, predict from steps *0..i-1* exactly as the live
   `Speculator` does: over-fetch `2k` predictions, drop tools that may not be speculated, keep the top `k`
   (`--top-k`, default 3). By default the model keeps learning online as it replays (`--no-online` to disable).
4. **Score** steps whose call was safe to speculate:
   - the step's own `cls` decides (if present; `--ignore-step-class` to use tool names only);
   - otherwise the tool's class from `--tool-classes`, then the majority `cls` seen for that tool in training, then
     name heuristics (`read_file` → read-only, unknown → side-effecting). `--read-only/--idempotent/--side-effecting`
     override everything. Default policy: only `read_only` (add `--allow-idempotent`, `--allow-open-world`);
   - **top-1 / top-3 hit** = the exact call (tool + canonical args) is the first / among the first three launched
     predictions. "Tool name only" = the top prediction names the right tool.
   - `--exclude-tools think` removes no-op tools (pure reasoning logs) that would inflate the hit rate without saving time.
   - **Unsafe matches** counts predictions that exactly matched a call whose own class was *not* speculable although its
     tool name is (e.g. `grep … > out.txt`). A name-only classifier would have launched those, which is why per-call
     classification matters for shell tools.

## Latency estimate (an upper bound, not a measurement)

The estimate models the MCP-proxy setting: speculation for step *i* starts when step *i-1* returns, so the speculation
window is step *i*'s `think_ms` minus `--predictor-ms`. A hit saves `min(tool_ms, window)`; it is a *full hit* if the
speculative run finished inside the window, otherwise a *join*. The **ceiling** is the saving of a perfect predictor
under the same policy and timings. Missing timings use `--think-ms` (default 2000) and `--tool-ms` (default 300, or
the training median of that tool if measured); the report states which share of steps had measured timings.

It ignores concurrency limits, budgets, validator rejections, invalidation by intervening writes, and contention
between speculative and real work, so real savings are lower. Wasted executions are every launched prediction that was
not the actual call; their cost is estimated with per-tool median tool time.

## Example

```bash
npm run eval:traces -- trajectories.jsonl.gz --tool-classes tool_classes.json \
  --exclude-tools think --think-ms 5300 --tool-ms 450
npm run eval:traces -- trajectories.jsonl.gz --test-prefix ohfb- --test-fraction 0.5 --json > report.json
```

`--tool-classes` accepts `{"tools": {"name": {"class": "read_only"}}}` or a flat `{"name": "read_only"}` map.
