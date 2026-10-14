/** Drive the speculative MCP proxy CLI over real stdio. Run: npm run demo:mcp */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules/.bin/tsx");
const c = new Client({ name: "demo", version: "0" });
await c.connect(
  new StdioClientTransport({
    command: tsx,
    args: [join(root, "src/cli/bin.ts"), "mcp-proxy", "--log-level", "info", "--", tsx, join(root, "examples/demo-upstream-server.ts")],
    stderr: "inherit",
    cwd: root,
  }),
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;
// the proxy learns "readme -> setup" online; later repeats are served from speculation
for (let i = 0; i < 3; i++) {
  for (const id of ["readme", "setup"]) {
    const t0 = performance.now();
    const r = await c.callTool({ name: "get_note", arguments: { id } });
    console.log(id.padEnd(7), JSON.stringify(text(r)).padEnd(28), `${(performance.now() - t0).toFixed(0)} ms`);
    await sleep(600); // the client's model "thinks"
  }
}
await c.close();
