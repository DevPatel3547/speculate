/**
 * speculate-tools command-line interface.
 *
 *   speculate-tools mcp-proxy [options] -- <upstream command> [args...]
 *   speculate-tools eval-traces [options] <trajectories.jsonl>
 */
import { VERSION } from "../version.js";
import { processIO, type CliIO } from "./common.js";

export const MAIN_HELP = `speculate-tools ${VERSION}: speculative tool execution for AI agents

Usage:
  speculate-tools mcp-proxy [options] -- <upstream command> [args...]
      Speculative stdio MCP proxy in front of any stdio MCP server.
  speculate-tools eval-traces [options] <trajectories.jsonl>
      Offline replay of recorded agent trajectories: predictor hit rates and
      estimated latency savings.

Options:
  -h, --help       show help (also: speculate-tools <command> --help)
  -v, --version    print the version

Docs: README.md, SECURITY.md, docs/trace-format.md
`;

/** Dispatch a CLI invocation. Resolves with the process exit code. */
export async function main(argv: string[], io: CliIO = processIO): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "mcp-proxy": {
      const { runMcpProxy } = await import("./mcp-proxy.js");
      return runMcpProxy(rest, io);
    }
    case "eval-traces": {
      const { runEvalTraces } = await import("./eval-traces.js");
      return runEvalTraces(rest, io);
    }
    case undefined:
    case "-h":
    case "--help":
    case "help":
      io.stdout(MAIN_HELP);
      return cmd === undefined ? 2 : 0;
    case "-v":
    case "--version":
      io.stdout(VERSION);
      return 0;
    default:
      io.stderr(`speculate-tools: unknown command "${cmd}"\n\n${MAIN_HELP}`);
      return 2;
  }
}

/** Entry point when executed directly. */
export function run(argv = process.argv.slice(2)): void {
  main(argv).then(
    (code) => {
      // the MCP proxy keeps stdin open; exit explicitly once it has shut down
      if (argv[0] === "mcp-proxy") process.exit(code);
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`speculate-tools: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
