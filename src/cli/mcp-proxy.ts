import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { ClassifierOptions } from "../classifier.js";
import { parseTrajectoriesJsonl } from "../eval/trace-format.js";
import { hitRate } from "../metrics.js";
import { NGramPredictor } from "../predictors/ngram.js";
import type { Safety, Trace } from "../types.js";
import { LEVELS, parseIntArg, parseList, processIO, stderrLogger, UsageError, type CliIO, type LogLevel } from "./common.js";

export const MCP_PROXY_HELP = `Usage: speculate-tools mcp-proxy [options] -- <upstream command> [args...]

Runs a stdio MCP server that forwards every tool call to an upstream stdio MCP
server and, between calls (while the client's model is thinking), pre-executes
predicted READ-ONLY calls. A matching call is answered from that result; a wrong
guess is thrown away. Side-effecting tools are never speculated.

Options:
  --top-k <n>               speculative executions per round (default 2)
  --max-concurrency <n>     concurrent speculative executions (default 4)
  --timeout-ms <ms>         abort a speculative execution after this long (default 30000)
  --max-age-ms <ms>         max age of a cached speculative result (default 60000)
  --allow-idempotent        also speculate idempotent tools (their effects happen early!)
  --allow-open-world        also speculate open-world (network) tools
  --read-only <a,b,...>     classify these tools as read_only (explicit override)
  --idempotent <a,b,...>    classify these tools as idempotent
  --side-effecting <a,...>  never speculate these tools
  --no-trust-annotations    ignore MCP tool annotations (use for untrusted servers)
  --no-heuristics           ignore name/description heuristics (use with --read-only as an allowlist)
  --strict-open-world       treat tools without openWorldHint=false as open-world (MCP spec default)
  --traces <file>           pre-train the predictor (.jsonl trace format, or JSON Trace[])
  --log-level <level>       stderr log level: silent|error|warn|info|debug (default warn)
  --log-args                include tool arguments in debug logs (may expose secrets)
  -h, --help                show this help

stdout carries the MCP protocol; all logs and the final metrics line go to stderr.

Example (.mcp.json for Claude Code / Claude Desktop):
  { "command": "npx",
    "args": ["-y", "speculate-tools", "mcp-proxy", "--",
             "npx", "-y", "@modelcontextprotocol/server-filesystem", "."] }
`;

/** Parsed `mcp-proxy` options. */
export interface McpProxyArgs {
  command: string;
  args: string[];
  topK: number;
  maxConcurrency?: number;
  timeoutMs?: number;
  maxAgeMs?: number;
  allow: Safety[];
  allowOpenWorld: boolean;
  classifier: ClassifierOptions;
  traces?: string;
  logLevel: LogLevel;
  logArgs: boolean;
}

/** Parse `mcp-proxy` argv (everything after the subcommand). Returns "help" for -h/--help. */
export function parseMcpProxyArgs(argv: string[]): McpProxyArgs | "help" {
  const sep = argv.indexOf("--");
  const flags = sep < 0 ? argv : argv.slice(0, sep);
  const { values, positionals } = parseArgs({
    args: flags,
    allowPositionals: true,
    strict: true,
    options: {
      "top-k": { type: "string" },
      "max-concurrency": { type: "string" },
      "timeout-ms": { type: "string" },
      "max-age-ms": { type: "string" },
      "allow-idempotent": { type: "boolean" },
      "allow-open-world": { type: "boolean" },
      "read-only": { type: "string" },
      idempotent: { type: "string" },
      "side-effecting": { type: "string" },
      "no-trust-annotations": { type: "boolean" },
      "no-heuristics": { type: "boolean" },
      "strict-open-world": { type: "boolean" },
      traces: { type: "string" },
      "log-level": { type: "string" },
      "log-args": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return "help";
  if (positionals.length) throw new UsageError(`unexpected argument "${positionals[0]}" (put the upstream command after --)`);
  if (sep < 0 || sep === argv.length - 1)
    throw new UsageError("missing upstream command: speculate-tools mcp-proxy [options] -- <command> [args...]");
  const [command, ...args] = argv.slice(sep + 1);
  const logLevel = (values["log-level"] ?? "warn") as LogLevel;
  if (!LEVELS.includes(logLevel)) throw new UsageError(`--log-level must be one of ${LEVELS.join("|")}`);
  const overrides: Record<string, Safety> = {};
  for (const t of parseList(values["read-only"])) overrides[t] = "read_only";
  for (const t of parseList(values.idempotent)) overrides[t] = "idempotent";
  for (const t of parseList(values["side-effecting"])) overrides[t] = "side_effecting";
  return {
    command,
    args,
    topK: parseIntArg("--top-k", values["top-k"], 0) ?? 2,
    maxConcurrency: parseIntArg("--max-concurrency", values["max-concurrency"], 1),
    timeoutMs: parseIntArg("--timeout-ms", values["timeout-ms"], 1),
    maxAgeMs: parseIntArg("--max-age-ms", values["max-age-ms"], 0),
    allow: values["allow-idempotent"] ? ["read_only", "idempotent"] : ["read_only"],
    allowOpenWorld: !!values["allow-open-world"],
    classifier: {
      overrides,
      trustAnnotations: !values["no-trust-annotations"],
      heuristics: !values["no-heuristics"],
      openWorldByDefault: !!values["strict-open-world"],
    },
    traces: values.traces,
    logLevel,
    logArgs: !!values["log-args"],
  };
}

/** Load training traces: the normalized JSONL format, or a JSON array of `Trace`. */
export async function loadTraces(path: string): Promise<{ traces: Trace[]; skipped: number }> {
  const text = await readFile(path, "utf8");
  if (/\.jsonl$/i.test(path)) {
    const { trajectories, errors } = parseTrajectoriesJsonl(text);
    return {
      traces: trajectories.map((t) => ({
        id: t.id,
        steps: t.steps.map((s) => ({ call: { name: s.tool, args: s.args }, ...(s.result !== undefined ? { result: s.result } : {}) })),
      })),
      skipped: errors.length,
    };
  }
  const v = JSON.parse(text) as unknown;
  if (!Array.isArray(v)) throw new UsageError(`${path}: expected a JSON array of traces`);
  const traces = v.filter((t): t is Trace => !!t && Array.isArray((t as Trace).steps));
  return { traces, skipped: v.length - traces.length };
}

/** Run the proxy until the client disconnects or a signal arrives. Resolves with an exit code. */
export async function runMcpProxy(argv: string[], io: CliIO = processIO): Promise<number> {
  let a: McpProxyArgs | "help";
  try {
    a = parseMcpProxyArgs(argv);
  } catch (e) {
    io.stderr(`speculate-tools mcp-proxy: ${e instanceof Error ? e.message : String(e)}\nRun with --help for usage.`);
    return 2;
  }
  if (a === "help") {
    io.stdout(MCP_PROXY_HELP);
    return 0;
  }
  const log = stderrLogger(a.logLevel, io);

  // MCP SDK is loaded lazily so `--help` and the eval command work without it
  const [{ Client }, { StdioClientTransport }, { StdioServerTransport }, { createSpeculativeMcpProxy }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("../adapters/mcp-proxy.js"),
  ]);

  const predictor = new NGramPredictor();
  if (a.traces) {
    const { traces, skipped } = await loadTraces(a.traces);
    predictor.train(traces);
    log.info(`trained on ${traces.length} trace(s) from ${a.traces}${skipped ? `, skipped ${skipped} invalid` : ""}`);
  }

  const upstream = new Client({ name: "speculate-proxy-upstream", version: "1.0.0" });
  try {
    await upstream.connect(new StdioClientTransport({ command: a.command, args: a.args, stderr: "inherit" }));
  } catch (e) {
    io.stderr(`speculate-tools mcp-proxy: failed to start upstream "${a.command}": ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const { server, speculator, tools } = await createSpeculativeMcpProxy({
    upstream,
    predictor,
    allow: a.allow,
    allowOpenWorld: a.allowOpenWorld,
    classifier: a.classifier,
    topK: a.topK,
    ...(a.maxConcurrency !== undefined ? { maxConcurrency: a.maxConcurrency } : {}),
    ...(a.timeoutMs !== undefined ? { timeoutMs: a.timeoutMs } : {}),
    ...(a.maxAgeMs !== undefined ? { maxAgeMs: a.maxAgeMs } : {}),
    logger: log,
    logArgs: a.logArgs,
  });
  for (const t of tools) {
    const c = speculator.classify(t.name);
    log.info(`tool ${t.name}: ${c.safety}${speculator.isSpeculable(t.name) ? " (speculated)" : ""} — ${c.reason}`);
  }

  return new Promise<number>((resolve) => {
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      const m = speculator.metrics();
      io.stderr(
        `[speculate] calls=${m.realCalls} hits=${m.hits} joins=${m.joins} hitRate=${(hitRate(m) * 100).toFixed(1)}% ` +
          `saved=${m.latencySavedMs.toFixed(0)}ms launched=${m.launched} wasted=${m.wasted}`,
      );
      speculator.close();
      void upstream.close().finally(() => resolve(code));
    };
    process.once("SIGINT", () => finish(130));
    process.once("SIGTERM", () => finish(143));
    server.onclose = () => finish(0);
    server.connect(new StdioServerTransport()).catch((e: unknown) => {
      io.stderr(`speculate-tools mcp-proxy: ${e instanceof Error ? e.message : String(e)}`);
      finish(1);
    });
  });
}
