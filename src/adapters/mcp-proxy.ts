/**
 * Speculative MCP proxy: sits between an MCP client (e.g. Claude Code / Claude Desktop)
 * and an upstream MCP server. Every tool call is forwarded; after each call returns
 * (i.e. while the model is thinking about the result) the proxy predicts the next
 * calls and pre-executes the *read-only* ones against the upstream server.
 *
 *   client <--stdio--> [speculate proxy] <--stdio--> upstream MCP server
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { NGramPredictor } from "../predictors/ngram.js";
import { Speculator, type SpeculatorOptions } from "../speculator.js";
import type { ToolRegistry } from "../types.js";
import { VERSION } from "../version.js";

/** Options for {@link createSpeculativeMcpProxy}. Speculator options default as usual; the predictor defaults to a fresh `NGramPredictor`. */
export interface SpeculativeMcpProxyOptions extends Partial<Omit<SpeculatorOptions, "tools">> {
  /** A connected client to the upstream server. */
  upstream: Client;
  /** Server name reported to the downstream client. Default "speculate-proxy". */
  name?: string;
  /** Server version reported to the downstream client. Default: this package's version. */
  version?: string;
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

/**
 * Build an MCP server that forwards every tool to `upstream` and speculatively pre-executes
 * predicted read-only calls between requests. Connect the returned `server` to a transport.
 * Only tools are proxied (not resources/prompts), and the tool list is read once at startup.
 */
export async function createSpeculativeMcpProxy(
  o: SpeculativeMcpProxyOptions,
): Promise<{ server: Server; speculator: Speculator; tools: Tool[] }> {
  const tools = await listAllTools(o.upstream);
  const registry: ToolRegistry = {};
  for (const t of tools) {
    registry[t.name] = {
      spec: { name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations },
      handler: (args, ctx) => o.upstream.callTool({ name: t.name, arguments: args }, undefined, { signal: ctx.signal }),
    };
  }
  const { upstream: _u, name: _n, version: _v, ...specOpts } = o;
  const speculator = new Speculator({
    ...specOpts,
    predictor: o.predictor ?? new NGramPredictor(),
    // MCP reports tool failures in-band (isError: true); never cache those speculatively.
    acceptResult: o.acceptResult ?? ((_c, r) => !(r as { isError?: boolean })?.isError),
    tools: registry,
  });

  const server = new Server({ name: o.name ?? "speculate-proxy", version: o.version ?? VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const call = { name: req.params.name, args: req.params.arguments ?? {} };
    try {
      // the upstream result is returned verbatim (from cache or from a real call)
      return (await speculator.call(call, { signal: extra.signal })) as any;
    } finally {
      // the client's model now thinks about this result: speculate on the next call
      void speculator.beginRound();
    }
  });
  return { server, speculator, tools };
}
