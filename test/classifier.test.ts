import { describe, expect, it } from "vitest";
import { callKey, canonicalJson, pathNormalizer } from "../src/canonical.js";
import { classifyTool } from "../src/classifier.js";

describe("classifyTool", () => {
  it("defaults unknown tools to side_effecting", () => {
    expect(classifyTool({ name: "frobnicate" }).safety).toBe("side_effecting");
    expect(classifyTool({ name: "frobnicate" }, { heuristics: false }).safety).toBe("side_effecting");
    expect(classifyTool({ name: "read_file" }, { heuristics: false }).safety).toBe("side_effecting");
  });

  it("uses name heuristics", () => {
    expect(classifyTool({ name: "read_file" }).safety).toBe("read_only");
    expect(classifyTool({ name: "listDirectory" }).safety).toBe("read_only");
    expect(classifyTool({ name: "mcp__github__get_issue" }).safety).toBe("read_only");
    expect(classifyTool({ name: "write_file" }).safety).toBe("side_effecting");
    expect(classifyTool({ name: "run_tests" }).safety).toBe("side_effecting");
    expect(classifyTool({ name: "get_and_delete" }).safety).toBe("side_effecting");
  });

  it("a mutating word in the description vetoes a read-sounding name", () => {
    expect(classifyTool({ name: "get_token", description: "Get a token; creates one if missing." }).safety).toBe("side_effecting");
  });

  it("respects MCP annotations, but a mutating name vetoes readOnlyHint", () => {
    expect(classifyTool({ name: "frob", annotations: { readOnlyHint: true } }).safety).toBe("read_only");
    expect(classifyTool({ name: "ensure_dir", annotations: { idempotentHint: true } }).safety).toBe("idempotent");
    expect(classifyTool({ name: "nuke", annotations: { idempotentHint: true, destructiveHint: true } }).safety).toBe("side_effecting");
    expect(classifyTool({ name: "delete_row", annotations: { readOnlyHint: true } }).safety).toBe("side_effecting");
    expect(classifyTool({ name: "get_x", annotations: { readOnlyHint: false } }).safety).toBe("side_effecting");
    expect(classifyTool({ name: "frob", annotations: { readOnlyHint: true } }, { trustAnnotations: false }).safety).toBe("side_effecting");
  });

  it("overrides always win", () => {
    expect(classifyTool({ name: "run_tests" }, { overrides: { run_tests: "idempotent" } })).toEqual({
      safety: "idempotent",
      reason: "override",
      openWorld: false,
    });
    expect(classifyTool({ name: "read_file" }, { overrides: { read_file: "side_effecting" } }).safety).toBe("side_effecting");
  });
});

describe("canonical keys", () => {
  it("sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
    expect(callKey({ name: "x", args: { a: 1, b: 2 } })).toBe(callKey({ name: "x", args: { b: 2, a: 1 } }));
    expect(callKey({ name: "x", args: { a: 1 } })).not.toBe(callKey({ name: "y", args: { a: 1 } }));
    expect(canonicalJson(-0)).toBe("0");
  });

  it("does not normalize paths unless asked", () => {
    expect(callKey({ name: "r", args: { path: "./a" } })).not.toBe(callKey({ name: "r", args: { path: "a" } }));
    const n = pathNormalizer();
    expect(n({ name: "r", args: { path: "./src//x/../a.ts" } }).args.path).toBe("src/a.ts");
    expect(n({ name: "r", args: { path: "." } }).args.path).toBe(".");
  });
});
