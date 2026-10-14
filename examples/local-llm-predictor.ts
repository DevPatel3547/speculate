/**
 * LLM predictor on a FREE local model through any OpenAI-compatible server.
 *
 *   ollama pull qwen2.5-coder:7b && ollama serve          # http://localhost:11434/v1
 *   # or: llama-server -m model.gguf --port 8080          # http://localhost:8080/v1
 *   LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen2.5-coder:7b npx tsx examples/local-llm-predictor.ts
 *
 * Exits 0 with a hint if no server is running.
 */
import { LLMPredictor, OpenAICompatibleLLMClient, type Step } from "../src/index.js";

const baseURL = process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
const model = process.env.LLM_MODEL ?? "qwen2.5-coder:7b";
const llm = new LLMPredictor({
  client: new OpenAICompatibleLLMClient({ baseURL, model, timeoutMs: 60_000 }),
  tools: [
    {
      name: "grep",
      description: "Search files for a pattern",
      inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } } },
    },
    { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  ],
});
const history: Step[] = [
  { call: { name: "grep", args: { pattern: "parseConfig", path: "src" } }, result: "src/config.ts:12: export function parseConfig(" },
];
try {
  const t0 = performance.now();
  const r = await llm.predict({ history }, 3);
  console.log(`${model} predicted in ${(performance.now() - t0).toFixed(0)} ms:`);
  for (const p of r.predictions) console.log(`  ${p.score.toFixed(2)}  ${p.call.name}(${JSON.stringify(p.call.args)})`);
} catch (e) {
  console.log(`No OpenAI-compatible server at ${baseURL} (${e instanceof Error ? e.message : String(e)}).`);
  console.log("Start Ollama or llama.cpp's llama-server (see the comment at the top of this file) and re-run.");
}
