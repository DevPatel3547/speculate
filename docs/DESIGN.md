# Design notes

Why the engine is built the way it is. Each point names the race or trade-off it addresses.

1. **Why it is lossless.** Three mechanisms, each closing a different race:
   - a *safety gate* (only allowed classes run speculatively; unknown tools are side-effecting);
   - *epoch invalidation* before **and** after every non-read-only call. "Before" drops results that predate the write;
     "after" drops reads that ran *concurrently* with it, including a read that a real call had already joined;
   - *validators* fingerprint external state **before** the speculative run and again at use. Fingerprinting before
     means a change that lands during the run is still detected.
2. **`idempotent` is not "safe".** Idempotent means f(f(x)) = f(x), not f(x) = x. A speculated `mkdir -p` creates the
   directory even if the agent never asks for it. That is why it is opt-in, why a served idempotent result invalidates
   the cache, and why a completed idempotent speculation invalidates every other cached result.
3. **No path normalization by default.** `grep -n foo ./src` and `grep -n foo src` print different paths. A cache key may
   only merge calls whose *outputs* are identical, so keys are exact canonical JSON; `normalizeArgs` is opt-in.
4. **Where the speedup comes from, and its ceiling.** Saved time per hit is `min(tool latency, think window − predictor
   latency)`. Total saving is capped by the share of wall time spent in speculable tools: the "ceiling" row in the
   simulator and in `eval:traces`. On real SWE trajectories that share is small (tools ~0.45 s, model thinking ~5.3 s).
5. **Hit vs join.** A completed speculation saves the whole tool time; a join (still running when the call arrives)
   saves only the time already elapsed.
6. **Precision vs recall vs cost.** `topK=3` throws away most executions (≈70% in the simulator, ≈98% on real
   trajectories). That is free for local reads and expensive for metered APIs; `budget`, `minScore`, `topK` and
   `maxConcurrency` control it.
7. **n-gram argument templates.** Each argument is explained as `lit:<json>` (a value seen before),
   `arg:<lag>:<tool>:<key>` (copied from an earlier call) or `res:<extractor>:<lag>:<tool>:<idx>` (a token extracted from
   an earlier result). Sources are qualified by tool, because grep's `path` is a directory and read_file's is a file.
   Without result content (as in most public trajectory datasets) only the first two are available.
8. **Stages beat a fused ensemble.** Running the n-gram and the LLM as independent stages lets the fast predictor launch
   immediately instead of waiting for the slow one (11.2% vs 9.2% saved in the simulator).
9. **The virtual clock.** A discrete-event scheduler that only advances time when every promise is blocked on a sleep.
   Benchmarks become deterministic, so "identical transcript" is a meaningful test.
10. **Failure containment.** Predictors, validators and hooks are untrusted code paths. Their output is validated and
    their exceptions are counted (`internalErrors`) rather than propagated: speculation may only ever make a call faster,
    never different, and never fail it.
11. **Sessions.** A `Speculator` is one session (cache, history, epoch, budget). Multi-tenant servers use
    `SpeculatorPool`, which also bounds the number of live sessions (LRU + idle TTL).
