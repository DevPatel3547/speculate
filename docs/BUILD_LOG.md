# Build log

How speculate-tools went from an idea to a hardened library and a negative result. Built by Dev Patel with Claude
(Anthropic) as an AI pair-programmer. Dates are from the changelog and the benchmark reports.
Every number here appears in the repository's benchmark reports, changelog or test suite.

## 0. Motivation and research basis

An agent turn alternates two phases: the model generates a tool call, then the tool runs, then the model reads the
result and generates again. While the model generates, the tools sit idle; while a tool runs, the model sits idle.
CPUs solved the same shape of problem decades ago with branch prediction and speculative execution: guess the next
instruction, execute it early, throw the work away if the guess was wrong. The part that makes it safe is the same
here: **only speculate on work you can discard without anyone noticing.**

Two papers showed the idea had promise:

- *Speculative Actions: A Lossless Framework for Faster Agentic Systems* (Ye et al., arXiv 2510.04371): up to 55%
  next-action prediction accuracy and up to 20% lower latency.
- *Parallelizing Tool Execution and LLM Generation for Low-Latency Agent Serving* (PASTE, Sui et al., arXiv
  2603.18897): a 43.5% reduction in average task completion time.

What was missing was a **usable library**: something provider-agnostic that a developer could put in front of their
own tools, with an explicit answer to "what if it speculates `rm -rf`?". That gap set the goals:

1. Lossless: the agent must see byte-identical results with and without speculation.
2. Safe by default: never execute anything with side effects speculatively; unknown means unsafe.
3. Drop-in: plain tool registries, the Anthropic Messages tool loop, the Claude Agent SDK, and MCP servers.
4. Measured honestly, with every number labeled simulated or real.

## 1. v0.1.0: the prototype (2026-10-11)

The first version was a TypeScript library with:

- **The `Speculator` engine.** Prediction rounds start when the model starts thinking; predicted calls pass a safety
  gate and a concurrency limit, run in the background with an `AbortSignal`, and are cached under a key built from the
  tool name and canonical JSON arguments. A real call is served from the cache only on an exact match.
- **Three invalidation mechanisms**, each closing a different race: a safety gate (only `read_only` tools run
  speculatively), *epoch invalidation* before and after every non-read-only real call, and staleness *validators*
  that fingerprint external state before the speculative run and again at use.
- **Predictors.** An n-gram model over tool sequences with *argument templates* (copy a literal seen before, an
  argument from an earlier call, or a path/identifier extracted from an earlier result), an LLM predictor, and an
  ensemble. Predictors run as independent stages so the microsecond n-gram does not wait for the slow LLM.
- **Adapters** for the Anthropic Messages tool loop, Claude Agent SDK tools (via hooks) and MCP (a stdio proxy).
- **A deterministic simulator.** A scripted but stochastic coding agent on a generated repository, with log-normal
  think times (median 1.8 s per read decision, 7 s per edit) and two tool-latency profiles, all on a *virtual clock*:
  a discrete-event scheduler that advances time only when every promise is blocked on a sleep. Determinism is what
  makes "identical transcript" a meaningful test: if speculation ever changed a result, the trajectory would diverge.
- **45 tests.**

Simulated results on the remote-sandbox profile: 3.7% of wall time saved with read-only tools, 9.0% with `run_tests`
opted in as idempotent, 11.2% with the n-gram plus a simulated 60%-recall LLM predictor, and a 13.7% oracle ceiling,
with 200/200 identical transcripts in every variant. Running the stages independently instead of as a fused ensemble
had raised the best variant from 9.2% to 11.2%. On the local profile (5 ms reads), read-only speculation saved 0.2%.

The prototype README already said every number was simulated, and its roadmap was "record real traces, replay them,
then A/B live". That roadmap is what eventually produced the negative result.

## 2. The hardening pass (v0.1.0 → 1.0.0-rc.1)

The goal was to make the library something a stranger could deploy, which meant treating every predictor, hook and
tool description as untrusted and looking for ways the guarantees could break. The full list is in
[CHANGELOG.md](../CHANGELOG.md); the bugs it found fall into four groups.

**Correctness bugs that could change what the agent sees or does.**

- A throwing predictor `observe()` turned a successful real call into an error *after* the tool had run, so a retry
  could repeat a side effect.
- With `idempotent` opted in, a speculatively completed idempotent call served from the cache did not invalidate reads
  cached before its effect: stale reads.
- Non-JSON arguments collided in the cache: `Date(1)` and `Date(2)` (and `Map`s) both keyed as `{}`, and `NaN` keyed
  like the string `"NaN"`. Circular arguments made the *real* call throw. Fix: cache keys became SHA-256 hashes of
  canonical JSON, and non-JSON arguments are never cached (`UncacheableArgsError`), they just run normally.
- Tool lookup used `in`/indexing on a plain object, so `constructor`, `toString` and `__proto__` resolved to Object
  built-ins.

**Crashes and hangs.**

- Malformed predictions (missing `call`, `NaN` score) or a throwing `onEvent`/`costOf`/`normalizeArgs` caused an
  unhandled promise rejection, which crashes Node.
- A validator that never resolved hung the real call forever and leaked a concurrency slot;
  `fsValidator({ hash: true })` would read a FIFO or `/dev/zero` forever.
- `timeoutMs` above 2^31−1 (or `Infinity`) made every speculation time out immediately (`setTimeout` overflow).

**Resource leaks.** History, n-gram literal sources and pending entries grew without bound, result size was not
bounded, and a capped history made the n-gram re-learn its whole window on every step.

**Lifecycle and API bugs.** The caller's `AbortSignal` was dropped by `wrapTools()`/`speculate()`; `drain()` returned
before in-progress rounds had launched; `close()` did not stop later rounds; `runAnthropicToolLoop` left speculation
running when `messages.create` threw; description words after the 40th were ignored by the classifier; `--top-k abc`
silently produced `NaN`.

Each fix came with a regression test that fails without it. The pass also added what a production deployment needs:

- **Threat model** ([SECURITY.md](../SECURITY.md)), threats T1–T8, which led to two new mechanisms: the **open-world
  gate** (network tools are not speculated unless opted in, because a prompt injection in a tool result can steer the
  predictor into an exfiltration call the agent never makes) and the rule that a mutating word anywhere in a tool's
  *description* vetoes an MCP `readOnlyHint`.
- **`SpeculatorPool`** for multi-tenant servers: one isolated cache, history, epoch and budget per session.
- **Observability** hooks (`logger`, `otelTelemetry`) that never log arguments unless asked.
- **`OpenAICompatibleLLMClient`**, so the LLM predictor can run on a free local model (Ollama, llama.cpp, vLLM).
- **Packaging:** a dual ESM/CJS build with `.d.ts`/`.d.cts` and an `exports` map (`.`, `./mcp`, `./eval`), support
  for Node 18.18+, a CLI (`speculate-tools mcp-proxy | eval-traces`), and a Dockerfile for the MCP proxy.
- **CI:** lint, typecheck, tests with coverage, build, `npm pack`, examples and a short benchmark on Node 22; smoke
  tests of the built package (ESM, CJS, CLI, real-stdio MCP proxy) on Node 18, 20 and 22; a Docker build.
- **Tests:** 136 Vitest tests plus 8 dist smoke tests; coverage ~96% of lines and ~88% of branches, with thresholds
  enforced at 85%/75%.

After the pass the simulator numbers were essentially unchanged (remote sandbox: 3.7%, 8.9%, 11.2%, ceiling 13.7%;
200/200 identical transcripts).

## 3. Building a real-trace dataset

The prototype's roadmap said to record Claude Code traces on SWE-bench tasks. A cheaper first step was available:
public datasets of coding-agent trajectories already exist. The work was mostly in finding ones with clear licenses
and converting them to one schema.

- **Sources.** Five Hugging Face datasets: nebius/SWE-agent-trajectories (CC BY 4.0), nebius/SWE-rebench-openhands-
  trajectories (CC BY 4.0), SWE-bench/SWE-smith-trajectories (MIT), SWE-Gym/OpenHands-SFT-Trajectories (MIT) and
  all-hands/openhands-feedback (MIT; real users' sessions that they chose to publish). Datasets with no declared
  license, or a license of "other", were skipped.
- **Size.** Subsampled to 8,754 trajectories with 330,942 tool calls (mean 37.8 calls per trajectory).
- **Schema.** One JSON line per trajectory with ordered steps: tool name, normalized and truncated arguments,
  result size, optional timings, and a per-call safety class ([docs/trace-format.md](trace-format.md)). Message text,
  model reasoning and patches were dropped; repository roots became `$REPO`.
- **Per-call classification.** Shell is the hard case: `grep foo src` is read-only, `grep foo src > out.txt` is not.
  Shell commands were classified from their parsed program list and redirects, so the class belongs to the call, not
  the tool name.
- **Timings.** Only the openhands-feedback sessions have wall-clock timestamps, so only they have measured think and
  tool times. That limitation shapes how the latency results are reported.

The derived data is not committed (see [docs/benchmarks/README.md](benchmarks/README.md) for the recipe and
checksums); the attribution required by the licenses is in the main README.

## 4. The real evaluation and the negative result (2026-10-12)

`eval:traces` replays trajectories offline. It splits by trajectory (70/30 by hash, never by step), trains the
n-gram on the training set, and before each test step predicts from the preceding steps exactly as the live
`Speculator` would, launching the top 3 speculable predictions. A hit is an exact match on tool and arguments.

**First surprise: a metric that lied.** Scoring every tool gave top-1 8.2% / top-3 11.4%. A large share of those hits
came from OpenHands' `think` tool, a no-op that logs reasoning: it is "read-only", highly predictable (65.1% top-1),
and saves no time at all. Excluding it gave the honest numbers.

**The results** (read-only policy, 2,643 test trajectories, 40,650 speculable test calls):

| metric | value |
| --- | ---: |
| top-1 / top-3 exact hit rate | 5.0% / 6.4% |
| right tool, any arguments (top-1) | 42.2% |
| estimated wall time saved, all sources | 0.2% |
| ceiling: perfect predictor, same policy | 1.8% |
| held-out real-user sessions: hit rate top-1 / top-3 | 11.9% / 13.2% |
| held-out real-user sessions: saved / ceiling (timings measured on 98.6% / 92.2% of steps) | 0.1% / 0.8% |
| speculative executions wasted (full test set) | 140,793 vs 2,586 hits |

By source the hit rate ranged from 14.4% top-1 (SWE-agent, whose tool set is stereotyped: `scroll_down`,
`search_dir`) down to 0.0% (SWE-smith). Calls whose arguments are new text, such as `grep` and `find` command
lines, were essentially never predicted exactly (0.0%).

**Second surprise: the ceiling.** The hit rate was low, but the ceiling made it nearly irrelevant. In the timed
sessions the median model think time was 5.3 s and the median tool time 0.45 s. Coding agents spend most of their
wall time generating. Only ~41% of calls are read-only, and those are the fastest tools (file views, `ls`, `grep`).
So even a perfect predictor could save at most 1.8% of wall time (0.8% on the fully timed real-user subset). That is
Amdahl's law: the speed-up from accelerating a part is bounded by that part's share of the whole.

**Opting in to idempotent tools** (`python`, `pytest`, `pip install`) raised the ceiling to 5.9% and the estimate to
0.4%, and showed why per-call classification matters: 11 exactly-predicted calls would have been launched by a
name-only classifier although their own class was not speculable.

**Why the simulator was so optimistic.** Its agent thought for less time (1.8 s vs 5.3 s median), its tools were
slower (350 ms–9 s vs 0.45 s), its call patterns were scripted, and its traces contained tool results, which the
n-gram's best templates depend on. Each assumption was reasonable in isolation; together they described a workload
that the public traces do not resemble.

The README was rewritten to lead with this result rather than the simulated one.

## 5. What was learned

1. **Measure the ceiling before the predictor.** The single most informative number was the perfect-predictor
   ceiling, and it needs only timings and safety classes, no predictor at all. Had it been computed first, it would
   have redirected the project toward slow-tool workloads earlier.
2. **Simulators encode their author's assumptions.** The simulator was invaluable for correctness (deterministic,
   identical-transcript checks) and useless as evidence of benefit. Those are different jobs.
3. **Audit metrics for free wins.** The `think` tool inflated top-1 by more than half (5.0% to 8.2%) while saving
   nothing. A hit rate is only meaningful if hits correspond to saved time.
4. **Safety has to be per call, not per tool.** Shell tools mix reads and writes under one name; the evaluation showed
   concrete cases where a name-level classifier would have launched an unsafe call.
5. **Lossless engineering is mostly about races and failure containment.** Most hardening bugs were not in the
   prediction logic but in what happens when a hook throws, a validator hangs, a write lands mid-read, or an argument
   is not JSON.
6. **A negative result is a result.** "This does not help coding agents, here is the bound, and here is where it
   could help" is more useful to the next person than an unqualified 11%.

## 6. Next

The open questions are in the README's roadmap. The most important is to repeat the ceiling measurement on a workload
whose read-only tools are slow, such as a deep-research agent's search and fetch calls or a remote sandbox, under an
explicit open-world policy. If that ceiling is large, measure the LLM predictor on it, then run a live A/B that also
checks task success is unchanged.
