// Minimal stdio MCP server (low-level API, no zod) used by the dist smoke tests.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const notes = new Map([
  ["a", "alpha"],
  ["b", "beta"],
]);
let writes = 0;
const server = new Server({ name: "upstream", version: "0.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_note",
      description: "Get a note by id",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      annotations: { readOnlyHint: true },
    },
    {
      name: "save_note",
      description: "Save a note",
      inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } } },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (name === "get_note") {
    await new Promise((r) => setTimeout(r, 300));
    return { content: [{ type: "text", text: notes.get(String(args.id)) ?? "missing" }] };
  }
  if (name === "save_note") {
    writes++;
    notes.set(String(args.id), String(args.text));
    return { content: [{ type: "text", text: `saved (${writes})` }] };
  }
  return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
});
await server.connect(new StdioServerTransport());
