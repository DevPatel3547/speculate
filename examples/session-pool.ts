/**
 * Multi-tenant server: one isolated speculation cache per session, so one user's
 * speculative results can never be served to another. Run: npx tsx examples/session-pool.ts
 */
import { NGramPredictor, SpeculatorPool, type ToolRegistry } from "../src/index.js";

const inbox: Record<string, string[]> = { alice: ["hi alice"], bob: ["hi bob"] };
const tools: ToolRegistry = {
  list_messages: {
    spec: { name: "list_messages", description: "List the current user's messages" },
    // ctx.sessionId tells the handler whose credentials to use
    handler: async (_a, ctx) => inbox[String(ctx.sessionId).split(":")[0]] ?? [],
  },
};

const pool = new SpeculatorPool({
  tools,
  predictor: () => new NGramPredictor(), // per-session predictor: no cross-user learning
  maxSessions: 10_000,
  idleTtlMs: 15 * 60_000,
  maxGlobalConcurrency: 64,
});

for (const user of ["alice", "bob"]) {
  const s = pool.session(`${user}:conversation-1`);
  for (let turn = 0; turn < 3; turn++) {
    s.beginRound().catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    console.log(user, turn, await s.call({ name: "list_messages", args: {} }));
  }
}
const m = pool.metrics();
console.log(`sessions=${pool.size} calls=${m.realCalls} hits=${m.hits}`);
pool.close();
