/**
 * `speculate-tools/mcp`: speculative MCP proxy. Separate entry point so the core
 * library does not load `@modelcontextprotocol/sdk`.
 */
export { createSpeculativeMcpProxy, type SpeculativeMcpProxyOptions } from "./adapters/mcp-proxy.js";
