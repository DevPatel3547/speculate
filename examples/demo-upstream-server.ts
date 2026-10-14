/** Tiny stdio MCP server used to try the proxy: read-only lookups (slow) + a write. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const notes = new Map<string, string>([
  ["readme", "see notes: setup, deploy"],
  ["setup", "npm i"],
  ["deploy", "ship it"],
]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const server = new McpServer({ name: "demo-notes", version: "0.1.0" });

server.registerTool(
  "get_note",
  { description: "Look up a note by id", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
  async ({ id }) => {
    await sleep(400); // pretend this is a slow remote API
    return { content: [{ type: "text", text: notes.get(id) ?? `no note ${id}` }] };
  },
);
server.registerTool(
  "save_note",
  { description: "Save a note", inputSchema: { id: z.string(), text: z.string() } },
  async ({ id, text }) => {
    notes.set(id, text);
    return { content: [{ type: "text", text: "saved" }] };
  },
);
await server.connect(new StdioServerTransport());
