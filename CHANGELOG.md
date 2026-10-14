# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0-rc.1] - 2026-10-12

First release candidate of the stable API.

### Added
- `SpeculatorPool`: one isolated speculation cache/history/epoch/budget per session, LRU + idle-TTL eviction, optional
  process-wide concurrency limit. `ToolContext.sessionId` for per-user credentials.
- Open-world gate: tools that may reach the network (MCP `openWorldHint`, URL-like names/arguments) are not speculated
  unless `allowOpenWorld` is set; `openWorldByDefault` follows the MCP spec default.
- Structured logging hook (`logger`, `console`-compatible; arguments never logged unless `logArgs`) and an
  OpenTelemetry-friendly metrics hook (`telemetry`, `otelTelemetry(meter)`), with no runtime dependency.
- `OpenAICompatibleLLMClient`: run `LLMPredictor` on a free local model via Ollama, llama.cpp `llama-server`, vLLM or
  any OpenAI-compatible server. `stripReasoning` for `<think>` output.
- Trace-replay evaluation: `speculate-tools eval-traces` / `npm run eval:traces` and the `speculate-tools/eval` entry
  point. JSONL (+ gzip) trajectory format with per-step safety classes, train/test split by trajectory, top-1/top-3 hit
  rates, per-source/per-tool tables, and a latency estimate with an oracle ceiling. See `docs/trace-format.md`.
- CLI `speculate-tools` with `mcp-proxy` and `eval-traces` subcommands, `--help`, `--version`; classification flags
  (`--read-only`, `--no-trust-annotations`, `--no-heuristics`, `--strict-open-world`, ...). `speculate-mcp` kept as an alias.
- `Speculator.call(call, { signal })`, `cancelAll()`, `closed`, `lastActivityAt`, `sessionId`; options `maxHistory`,
  `maxCacheBytes`, `validatorTimeoutMs`, `limiter`.
- Dual ESM/CJS build with `.d.ts`/`.d.cts`, `exports` map (`.`, `./mcp`, `./eval`), Node >= 18.18; Dockerfile for the
  MCP proxy; SECURITY.md threat model; CI (lint, typecheck, tests + coverage, build, pack, dist smoke tests on Node
  18/20/22).

### Changed (breaking, relative to 0.1.0)
- `createSpeculativeMcpProxy` moved to `speculate-tools/mcp` so the core entry point does not load the MCP SDK.
- Cache keys (`callKey`) are SHA-256 hashes; `canonicalJson` throws `UncacheableArgsError` for non-JSON values.
- `Classification` has an `openWorld` field. A mutating word in a tool's *description* now vetoes `readOnlyHint`
  (the README already promised this).
- `Speculator.history` is a read-only getter capped at `maxHistory` (default 200).
- Event stream: `round` no longer carries predictions; new `predicted`, `predictor_error`, `miss`, `bypass`,
  `internal_error` events; call events carry the hashed `key`.
- `runAnthropicToolLoop` no longer `close()`s the speculator it was given (it calls `cancelAll()` instead).
- Invalid options throw `RangeError`/`TypeError` at construction.
- `@anthropic-ai/sdk` is no longer a dependency (the adapters are structurally typed).

### Fixed
- A throwing predictor `observe()` turned a successful real call into an error *after* the tool ran (risking a duplicate
  side effect on retry).
- Malformed predictions (missing `call`, `NaN` score) or a throwing `onEvent`/`costOf`/`normalizeArgs` caused an
  unhandled promise rejection, which crashes Node.
- Non-JSON arguments collided in the cache: `Date(1)` and `Date(2)` (and `Map`s) both keyed as `{}`, `NaN` keyed like
  the string `"NaN"`. Circular arguments made the *real* call throw.
- Tool lookup used `in`/indexing on a plain object: `constructor`, `toString`, `__proto__` resolved to Object built-ins.
- With `idempotent` opted in, a speculatively completed idempotent call served from cache did not invalidate reads
  cached before its effect (stale reads).
- Unbounded memory: history grew forever; n-gram literal sources grew forever; pending entries were unbounded with
  `cancelOnNewRound: false`; result size was not bounded.
- With a capped/rotating history the n-gram re-learned the whole window on every step; a predictor shared by sessions
  re-learned histories when sessions interleaved.
- A validator that never resolved hung the real call forever and leaked a concurrency slot. `fsValidator({hash:true})`
  would read FIFOs / `/dev/zero` forever.
- `timeoutMs` above 2^31-1 (or `Infinity`) made every speculation time out immediately (setTimeout overflow).
- The caller's `AbortSignal` was dropped by `wrapTools()`/`speculate()`; aborting a call that joined a speculation did
  not abort it.
- `drain()` returned before in-progress prediction rounds had launched anything.
- `close()` did not stop later rounds from speculating.
- `runAnthropicToolLoop` left speculation running if `messages.create` threw.
- Description words after the 40th were ignored by the classifier; `fetch_metadata` read-verb entry was dead code.
- `--top-k abc` in the CLI silently produced `NaN`.

## [0.1.0] - 2026-10-11

Initial prototype: Speculator engine, n-gram / LLM / ensemble predictors, validators, Anthropic Messages, Claude Agent
SDK and MCP proxy adapters, simulated benchmark.
