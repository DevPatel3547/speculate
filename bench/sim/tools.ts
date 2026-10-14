import { canonicalJson } from "../../src/canonical.js";
import type { Clock, ToolCall, ToolRegistry } from "../../src/types.js";
import { runTests, type Repo } from "./repo.js";
import { keyedLognormal } from "./rng.js";

export interface LatencyProfile {
  name: string;
  description: string;
  /** [median ms, log-sigma] per tool */
  tools: Record<string, [number, number]>;
}

/**
 * Remote sandbox: the agent's tools run in a container reached over the network
 * (SWE-agent / cloud coding agents / MCP servers): ~250ms RTT floor per call.
 */
export const REMOTE_SANDBOX: LatencyProfile = {
  name: "remote-sandbox",
  description: "tools in a remote container (network RTT per call)",
  tools: {
    read_file: [350, 0.4],
    list_dir: [300, 0.4],
    grep: [1200, 0.6],
    run_tests: [9000, 0.35],
    write_file: [350, 0.4],
  },
};

/** Local laptop: file tools are nearly free, only grep over a big repo and tests cost real time. */
export const LOCAL: LatencyProfile = {
  name: "local",
  description: "tools on the local machine",
  tools: {
    read_file: [5, 0.5],
    list_dir: [4, 0.5],
    grep: [80, 0.7],
    run_tests: [4000, 0.35],
    write_file: [6, 0.5],
  },
};

export function toolLatency(profile: LatencyProfile, taskId: string, call: ToolCall): number {
  const [median, sigma] = profile.tools[call.name] ?? [500, 0.5];
  // keyed on the readable call (name + canonical args) so latencies are stable across releases
  return keyedLognormal(`${profile.name}|${taskId}|${call.name}\u0000${canonicalJson(call.args ?? {})}`, median, sigma);
}

/**
 * Simulated coding-agent tools over the in-memory repo. Every tool first sleeps
 * its (deterministic) latency on the injected clock, then touches the VFS, so
 * reads observe the state at the END of their execution (worst case for staleness).
 */
export function makeTools(repo: Repo, clock: Clock, profile: LatencyProfile, taskId: string): ToolRegistry {
  const { vfs } = repo;
  const wait = (call: ToolCall, signal: AbortSignal) => clock.sleep(toolLatency(profile, taskId, call), signal);
  const str = (v: unknown, name: string) => {
    if (typeof v !== "string") throw new Error(`${name} must be a string`);
    return v;
  };
  return {
    read_file: {
      spec: {
        name: "read_file",
        description: "Read a file and return its contents.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      handler: async (args, ctx) => {
        await wait({ name: "read_file", args }, ctx.signal);
        return vfs.read(str(args.path, "path"));
      },
    },
    list_dir: {
      spec: {
        name: "list_dir",
        description: "List the entries of a directory.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      handler: async (args, ctx) => {
        await wait({ name: "list_dir", args }, ctx.signal);
        return vfs.list(str(args.path, "path")).join("\n");
      },
    },
    grep: {
      spec: {
        name: "grep",
        description: "Search files under a directory for a literal pattern; returns path:line: text.",
        inputSchema: {
          type: "object",
          properties: { pattern: { type: "string" }, path: { type: "string" } },
          required: ["pattern", "path"],
        },
      },
      handler: async (args, ctx) => {
        await wait({ name: "grep", args }, ctx.signal);
        const hits = vfs.grep(str(args.pattern, "pattern"), str(args.path, "path"));
        return hits.length ? hits.join("\n") : "(no matches)";
      },
    },
    run_tests: {
      spec: { name: "run_tests", description: "Run the test suite and report failures.", inputSchema: { type: "object", properties: {} } },
      handler: async (args, ctx) => {
        await wait({ name: "run_tests", args }, ctx.signal);
        return runTests(vfs, repo.modules);
      },
    },
    write_file: {
      spec: {
        name: "write_file",
        description: "Write content to a file, replacing it.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
      handler: async (args, ctx) => {
        await wait({ name: "write_file", args }, ctx.signal);
        vfs.write(str(args.path, "path"), str(args.content, "content"));
        return `wrote ${String(args.content).length} bytes to ${String(args.path)}`;
      },
    },
  };
}
