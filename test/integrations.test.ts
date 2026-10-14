import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { runAnthropicToolLoop, type AnthropicToolLoopClient } from "../src/adapters/anthropic.js";
import { createSpeculativeSdkTools } from "../src/adapters/agent-sdk.js";
import { createSpeculativeMcpProxy } from "../src/mcp.js";
import { Speculator } from "../src/speculator.js";
import { speculate } from "../src/speculate.js";
import { fsValidator } from "../src/validators/index.js";
import type { ToolRegistry } from "../src/types.js";
import { scripted } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fsTools(root: string, log: string[]): ToolRegistry {
  return {
    read_file: {
      spec: { name: "read_file", description: "Read a file." },
      handler: async (a, c) => {
        log.push(`${c.speculative ? "spec" : "real"}:read_file:${String(a.path)}`);
        await sleep(30);
        return readFile(join(root, String(a.path)), "utf8");
      },
    },
    write_file: {
      spec: { name: "write_file", description: "Write a file." },
      handler: async (a) => {
        log.push(`real:write_file:${String(a.path)}`);
        await writeFile(join(root, String(a.path)), String(a.content));
        return "ok";
      },
    },
  };
}

describe("fsValidator (real filesystem)", () => {
  it("re-executes a speculative read when the file changed on disk behind the agent's back", async () => {
    const root = await mkdtemp(join(tmpdir(), "speculate-"));
    try {
      await writeFile(join(root, "a.txt"), "v1");
      const log: string[] = [];
      const s = new Speculator({
        tools: fsTools(root, log),
        predictor: scripted(() => [{ name: "read_file", args: { path: "a.txt" } }]),
        validators: [fsValidator({ root, hash: true })],
      });
      await s.beginRound();
      await s.drain();
      // an external process edits the file (same size!)
      await writeFile(join(root, "a.txt"), "v2");
      await utimes(join(root, "a.txt"), new Date(), new Date(Date.now() + 5000));
      expect(await s.call({ name: "read_file", args: { path: "a.txt" } })).toBe("v2");
      expect(s.metrics().staleRejected).toBe(1);

      // unchanged file => hit
      await s.beginRound();
      await s.drain();
      expect(await s.call({ name: "read_file", args: { path: "a.txt" } })).toBe("v2");
      expect(s.metrics().hits).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fingerprints directories recursively", async () => {
    const root = await mkdtemp(join(tmpdir(), "speculate-"));
    try {
      await writeFile(join(root, "x.txt"), "1");
      const v = fsValidator({ root, hash: true });
      const a = await v.snapshot({ name: "grep", args: { path: "." } });
      await writeFile(join(root, "x.txt"), "2");
      const b = await v.snapshot({ name: "grep", args: { path: "." } });
      expect(a).not.toBe(b);
      expect(await v.snapshot({ name: "noop", args: {} })).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("speculate() generic wrapper", () => {
  it("wraps a tool registry transparently", async () => {
    const log: string[] = [];
    const root = await mkdtemp(join(tmpdir(), "speculate-"));
    try {
      await writeFile(join(root, "a.txt"), "hello");
      const s = speculate(fsTools(root, log), { predictor: scripted(() => [{ name: "read_file", args: { path: "a.txt" } }]) });
      s.onModelStart();
      await sleep(100); // "model thinking"
      const out = await s.tools.read_file.handler({ path: "a.txt" }, { signal: new AbortController().signal, speculative: false });
      expect(out).toBe("hello");
      expect(log).toEqual(["spec:read_file:a.txt"]);
      expect(s.metrics().hits).toBe(1);
      s.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Anthropic Messages tool-use loop (mocked client)", () => {
  it("speculates while the model thinks and returns identical tool_results", async () => {
    const root = await mkdtemp(join(tmpdir(), "speculate-"));
    try {
      await writeFile(join(root, "a.txt"), "alpha");
      const turns = [
        { content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.txt" } }], stop_reason: "tool_use" },
        {
          content: [
            { type: "tool_use", id: "t2", name: "write_file", input: { path: "a.txt", content: "beta" } },
            { type: "tool_use", id: "t3", name: "read_file", input: { path: "a.txt" } },
          ],
          stop_reason: "tool_use",
        },
        { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
      ];
      const mkClient = (): AnthropicToolLoopClient => {
        let i = 0;
        return {
          messages: {
            create: async () => {
              await sleep(80);
              return turns[i++];
            },
          },
        };
      };
      const run = async (withSpec: boolean) => {
        await writeFile(join(root, "a.txt"), "alpha");
        const log: string[] = [];
        const tools = fsTools(root, log);
        // predictor always guesses read_file(a.txt) — right in turn 1, and in turn 2 it must NOT be served stale
        const speculator = withSpec
          ? new Speculator({ tools, predictor: scripted(() => [{ name: "read_file", args: { path: "a.txt" } }]) })
          : undefined;
        const res = await runAnthropicToolLoop({
          client: mkClient(),
          model: "claude-sonnet-5-5",
          messages: [{ role: "user", content: "go" }],
          tools,
          speculator,
        });
        return { res, log, m: speculator?.metrics() };
      };
      const base = await run(false);
      const spec = await run(true);
      expect(JSON.stringify(spec.res.messages)).toBe(JSON.stringify(base.res.messages));
      const results = (spec.res.messages[4].content as { content: string }[]).map((b) => b.content);
      expect(results).toEqual(["ok", "beta"]);
      expect(spec.m!.hits).toBe(1);
      expect(spec.log.filter((l) => l.startsWith("real:read_file")).length).toBe(1); // the post-write read ran for real
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Claude Agent SDK adapter (structural)", () => {
  it("wraps tool() handlers, invalidates on built-in writes, starts rounds on PostToolBatch", async () => {
    let calls = 0;
    const def = {
      name: "get_doc",
      description: "Get a doc",
      annotations: { readOnlyHint: true },
      handler: async (args: { id: string }) => {
        calls++;
        return { content: [{ type: "text", text: `doc ${args.id} v${calls}` }] };
      },
    };
    const { tools, hooks, speculator } = createSpeculativeSdkTools([def], {
      serverName: "kb",
      predictor: scripted(() => [{ name: "get_doc", args: { id: "1" } }]),
    });
    const ac = { signal: new AbortController().signal };
    await hooks.PostToolBatch![0].hooks[0]({ hook_event_name: "PostToolBatch" }, undefined, ac);
    await speculator.drain();
    expect(calls).toBe(1);
    expect(await tools[0].handler({ id: "1" })).toEqual({ content: [{ type: "text", text: "doc 1 v1" }] });
    expect(speculator.metrics().hits).toBe(1);

    // speculate again, then a built-in Edit runs: cached result must be dropped
    await hooks.PostToolBatch![0].hooks[0]({ hook_event_name: "PostToolBatch" }, undefined, ac);
    await speculator.drain();
    await hooks.PreToolUse![0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "x" } }, "u1", ac);
    await hooks.PostToolUse![0].hooks[0](
      { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "x" }, tool_response: "ok" },
      "u1",
      ac,
    );
    await tools[0].handler({ id: "1" });
    expect(speculator.metrics().hits).toBe(1);
    expect(speculator.metrics().invalidations).toBeGreaterThanOrEqual(2);
    // built-in Read is observed for context but does not invalidate
    const inv = speculator.metrics().invalidations;
    await hooks.PreToolUse![0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} }, "u2", ac);
    expect(speculator.metrics().invalidations).toBe(inv);
    expect(speculator.history.some((s) => s.call.name === "Edit")).toBe(true);
  });
});

describe("MCP proxy (in-memory transports)", () => {
  it("proxies tools, speculates only read-only ones, and serves hits", async () => {
    const upstream = new McpServer({ name: "upstream", version: "1.0.0" });
    const counts: Record<string, number> = { get_item: 0, set_item: 0 };
    const store = new Map<string, string>([["a", "1"]]);
    upstream.registerTool(
      "get_item",
      { description: "Look up an item", inputSchema: { key: z.string() }, annotations: { readOnlyHint: true } },
      async ({ key }) => {
        counts.get_item++;
        return { content: [{ type: "text", text: store.get(key) ?? "missing" }] };
      },
    );
    upstream.registerTool(
      "set_item",
      { description: "Set an item", inputSchema: { key: z.string(), value: z.string() } },
      async ({ key, value }) => {
        counts.set_item++;
        store.set(key, value);
        return { content: [{ type: "text", text: "ok" }] };
      },
    );
    const [u1, u2] = InMemoryTransport.createLinkedPair();
    await upstream.connect(u1);
    const upClient = new Client({ name: "proxy-up", version: "1.0.0" });
    await upClient.connect(u2);

    const { server, speculator } = await createSpeculativeMcpProxy({
      upstream: upClient,
      predictor: scripted(() => [
        { name: "set_item", args: { key: "a", value: "evil" } },
        { name: "get_item", args: { key: "a" } },
      ]),
    });
    expect(speculator.classify("get_item").safety).toBe("read_only");
    expect(speculator.classify("set_item").safety).toBe("side_effecting");

    const [d1, d2] = InMemoryTransport.createLinkedPair();
    await server.connect(d1);
    const client = new Client({ name: "agent", version: "1.0.0" });
    await client.connect(d2);

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(["get_item", "set_item"]);
    const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

    expect(text(await client.callTool({ name: "get_item", arguments: { key: "a" } }))).toBe("1");
    await sleep(50); // model "thinks"; proxy speculates get_item(a)
    await speculator.drain();
    const before = counts.get_item;
    expect(text(await client.callTool({ name: "get_item", arguments: { key: "a" } }))).toBe("1");
    expect(counts.get_item).toBe(before); // served from speculation
    expect(speculator.metrics().hits).toBe(1);

    await client.callTool({ name: "set_item", arguments: { key: "a", value: "2" } });
    expect(counts.set_item).toBe(1); // only the real one: the predicted set_item never ran
    expect(text(await client.callTool({ name: "get_item", arguments: { key: "a" } }))).toBe("2");
    speculator.close();
    await client.close();
    await upClient.close();
  });
});
