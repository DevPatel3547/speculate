import { createHash } from "node:crypto";
import type { ToolCall } from "./types.js";

/**
 * Thrown when tool arguments cannot be turned into an unambiguous cache key
 * (non-JSON values such as `Date`, `Map`, `BigInt`, `NaN`, functions, cycles,
 * or nesting deeper than {@link MAX_ARG_DEPTH}). Calls with such arguments are
 * never served from speculation; they always execute for real.
 */
export class UncacheableArgsError extends Error {
  override name = "UncacheableArgsError";
}

/** Maximum nesting depth of tool arguments that can be keyed. */
export const MAX_ARG_DEPTH = 64;

/**
 * Canonical JSON: object keys sorted recursively, `undefined` object members
 * dropped (as `JSON.stringify` does), `-0` normalized to `0`.
 *
 * Only JSON-representable values are accepted: two argument objects map to the
 * same string **iff** they serialize to the same JSON, so a cache hit can never
 * merge calls a JSON-transport tool could tell apart. Anything else throws
 * {@link UncacheableArgsError}.
 *
 * Deliberately NOT done: path normalization ("./a" vs "a"), default-filling
 * from schemas, whitespace trimming. Those can change a tool's *output* (grep
 * echoes the path you passed), which would break the lossless guarantee. Opt in
 * per tool via `normalizeArgs`.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canon(value, 0, new Set()));
}

function canon(v: unknown, depth: number, ancestors: Set<object>): unknown {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new UncacheableArgsError(`non-finite number (${String(v)}) in tool arguments`);
    return Object.is(v, -0) ? 0 : v;
  }
  if (typeof v !== "object") throw new UncacheableArgsError(`unsupported ${typeof v} in tool arguments`);
  if (depth >= MAX_ARG_DEPTH) throw new UncacheableArgsError(`tool arguments nested deeper than ${MAX_ARG_DEPTH}`);
  if (ancestors.has(v)) throw new UncacheableArgsError("circular reference in tool arguments");
  ancestors.add(v);
  try {
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        if (!(i in v) || v[i] === undefined) throw new UncacheableArgsError("undefined/hole in array argument");
        out.push(canon(v[i], depth + 1, ancestors));
      }
      return out;
    }
    const proto = Object.getPrototypeOf(v) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      const ctor = (v as { constructor?: { name?: string } }).constructor?.name ?? "object";
      throw new UncacheableArgsError(`non-plain object (${ctor}) in tool arguments`);
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined) continue;
      out[k] = canon(x, depth + 1, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(v);
  }
}

/**
 * Cache key of a tool call: SHA-256 (hex) of `name + "\0" + canonicalJson(args)`.
 * Keys are hashed so argument values (which may contain secrets) never appear in
 * keys, logs, or metrics. Throws {@link UncacheableArgsError} for non-JSON args.
 */
export function callKey(call: ToolCall): string {
  return createHash("sha256")
    .update(call.name)
    .update("\u0000")
    .update(canonicalJson(call.args ?? {}))
    .digest("hex");
}

/**
 * Unhashed canonical identity of a call (`name + "\0" + canonicalJson(args)`), or `undefined`
 * if the arguments are not JSON. Cheaper than {@link callKey}; for in-memory comparisons only
 * (it contains argument values, so never log it).
 */
export function canonicalCallString(call: ToolCall): string | undefined {
  try {
    return `${call.name}\u0000${canonicalJson(call.args ?? {})}`;
  } catch {
    return undefined;
  }
}

/** {@link callKey}, or `undefined` if the arguments are not cacheable. */
export function tryCallKey(call: ToolCall): string | undefined {
  try {
    return callKey(call);
  } catch (e) {
    if (e instanceof UncacheableArgsError) return undefined;
    throw e;
  }
}

/** Rewrites a call's arguments into a canonical form before keying. Must not change the tool name. */
export type ArgNormalizer = (call: ToolCall) => ToolCall;

/**
 * Opt-in normalizer for filesystem-style tools: posix-normalizes values of the
 * given keys ("./src//a.ts" -> "src/a.ts"). Only use it when the tool's output
 * does not depend on the exact spelling of the path.
 */
export function pathNormalizer(keys: string[] = ["path", "file_path", "file", "dir"]): ArgNormalizer {
  return (call) => {
    const args = { ...call.args };
    for (const k of keys) {
      const v = args[k];
      if (typeof v === "string") args[k] = normalizePosix(v);
    }
    return { name: call.name, args };
  };
}

function normalizePosix(p: string): string {
  const abs = p.startsWith("/");
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
    else if (seg === ".." && abs)
      continue; // "/.." is "/"
    else parts.push(seg);
  }
  const s = parts.join("/");
  return abs ? "/" + s : s || ".";
}
