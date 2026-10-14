import type { Safety, ToolSpec } from "./types.js";

/** Result of classifying a tool. */
export interface Classification {
  safety: Safety;
  /** Why this label was chosen (for logs and audits). */
  reason: string;
  /**
   * The tool may reach external systems (network egress). Speculating such a tool lets
   * a predictor (possibly steered by prompt injection) choose arguments that are sent to
   * the outside world, so open-world tools are not speculated unless `allowOpenWorld` is set.
   */
  openWorld: boolean;
}

/** Options for {@link classifyTool} / {@link ToolClassifier}. */
export interface ClassifierOptions {
  /** Explicit labels. Always win. */
  overrides?: Record<string, Safety>;
  /**
   * Trust MCP annotations (readOnlyHint / idempotentHint / destructiveHint / openWorldHint).
   * The MCP spec says annotations are hints that must not be trusted from untrusted
   * servers; set `false` for those. Default `true`.
   */
  trustAnnotations?: boolean;
  /** Use name/description heuristics for tools with no override/annotation. Default `true`. */
  heuristics?: boolean;
  /**
   * Treat a missing `openWorldHint` as `true` (the MCP spec default). Default `false`:
   * a tool is considered open-world only if annotated so or if heuristics say so.
   */
  openWorldByDefault?: boolean;
}

// Words that indicate mutation anywhere in the name or description. Any hit vetoes read_only.
// Deliberately broad: a false "side_effecting" only costs speed, a false "read_only" costs safety.
const MUTATING = [
  "write",
  "create",
  "update",
  "delete",
  "remove",
  "rm",
  "put",
  "post",
  "send",
  "set",
  "insert",
  "move",
  "mv",
  "rename",
  "exec",
  "execute",
  "run",
  "apply",
  "commit",
  "push",
  "deploy",
  "install",
  "kill",
  "edit",
  "patch",
  "upload",
  "append",
  "mkdir",
  "drop",
  "truncate",
  "submit",
  "publish",
  "merge",
  "approve",
  "pay",
  "charge",
  "transfer",
  "reply",
  "forward",
  "trash",
  "archive",
  "modify",
  "replace",
  "save",
  "store",
  "add",
  "start",
  "stop",
  "restart",
  "reset",
  "clear",
  "purge",
  "book",
  "fix",
  "sync",
  "enable",
  "disable",
  "grant",
  "revoke",
  "invite",
  "assign",
  "cancel",
  "refund",
  "buy",
  "sell",
  "subscribe",
  "unsubscribe",
  "notify",
  "invoke",
  "trigger",
  "launch",
  "spawn",
  "fork",
  "clone",
  "copy",
  "attach",
  "detach",
  "mount",
  "unmount",
  "upgrade",
  "downgrade",
  "rollback",
  "revert",
  "restore",
  "migrate",
  "compile",
  "generate",
  "eval",
  "shell",
  "bash",
  "click",
  "navigate",
  "fill",
  "login",
  "logout",
  "authorize",
  "emit",
  "broadcast",
  "enqueue",
  "increment",
  "decrement",
  "toggle",
  "upsert",
  "overwrite",
  "sudo",
  "chmod",
  "chown",
  "touch",
  "wipe",
  "destroy",
  "erase",
  "flush",
  "reboot",
  "shutdown",
  "provision",
  "terminate",
  "allocate",
  "reserve",
  "claim",
  "accept",
  "reject",
  "confirm",
  "dispatch",
  "withdraw",
  "deposit",
  "tweet",
  "vote",
  "close",
  "lock",
  "unlock",
];
// Verbs that indicate a pure read when they lead the tool name.
const READING = [
  "get",
  "read",
  "list",
  "ls",
  "search",
  "find",
  "grep",
  "glob",
  "query",
  "describe",
  "show",
  "view",
  "cat",
  "stat",
  "head",
  "tail",
  "count",
  "lookup",
  "inspect",
  "check",
  "status",
  "diff",
  "info",
  "peek",
  "browse",
];
// Name words suggesting network egress to arbitrary destinations.
const OPEN_WORLD_NAME = [
  "web",
  "http",
  "https",
  "url",
  "uri",
  "browse",
  "browser",
  "download",
  "webhook",
  "internet",
  "online",
  "curl",
  "wget",
  "scrape",
  "crawl",
];
// Argument names suggesting the caller chooses a network destination.
const OPEN_WORLD_ARGS = new Set(["url", "uri", "href", "link", "endpoint", "host", "hostname", "domain", "webhook"]);
const MAX_DESCRIPTION_WORDS = 5000;

/** Exact word or a simple inflection of it (creates, created, creating, deletes, ...). */
function inflectionOf(w: string, list: readonly string[]): string | undefined {
  return list.find((m) => {
    if (w === m) return true;
    const stem = m.endsWith("e") ? m.slice(0, -1) : m;
    if (!w.startsWith(stem)) return false;
    const rest = w.slice(stem.length);
    return m.endsWith("e")
      ? ["es", "ed", "ing"].includes(rest)
      : ["s", "es", "ed", "ing", m.slice(-1) + "ed", m.slice(-1) + "ing"].includes(rest);
  });
}

function words(s: string): string[] {
  // split snake/kebab/camel/dot case into lowercase ASCII words
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function schemaPropertyNames(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const props = (schema as { properties?: unknown }).properties;
  return props && typeof props === "object" ? Object.keys(props) : [];
}

function detectOpenWorld(spec: ToolSpec, opts: ClassifierOptions): { openWorld: boolean; why?: string } {
  const hint = opts.trustAnnotations === false ? undefined : spec.annotations?.openWorldHint;
  if (hint === true) return { openWorld: true, why: "annotation openWorldHint" };
  const nameHit = words(spec.name).find((w) => OPEN_WORLD_NAME.includes(w));
  if (nameHit) return { openWorld: true, why: `name word "${nameHit}"` };
  const argHit = schemaPropertyNames(spec.inputSchema).find((p) => OPEN_WORLD_ARGS.has(p.toLowerCase()));
  if (argHit) return { openWorld: true, why: `argument "${argHit}"` };
  if (hint === false) return { openWorld: false };
  if (opts.openWorldByDefault) return { openWorld: true, why: "openWorldByDefault" };
  return { openWorld: false };
}

/**
 * Classify a tool. Decision order:
 *   1. explicit override
 *   2. MCP annotations (if trusted); a mutating word in the name *or description* vetoes `readOnlyHint`
 *   3. name/description heuristics
 *   4. default: `side_effecting` (never speculated)
 *
 * Heuristics are a convenience, not a security boundary: tool metadata can lie.
 * For untrusted tool providers use `trustAnnotations: false, heuristics: false`
 * plus explicit `overrides` (an allowlist).
 */
export function classifyTool(spec: ToolSpec, opts: ClassifierOptions = {}): Classification {
  const { overrides = {}, trustAnnotations = true, heuristics = true } = opts;
  const ow = detectOpenWorld(spec, opts);
  const openWorld = ow.openWorld;
  const tag = (reason: string) => (openWorld ? `${reason}; open-world (${ow.why})` : reason);
  if (Object.prototype.hasOwnProperty.call(overrides, spec.name)) {
    return { safety: overrides[spec.name], reason: tag("override"), openWorld };
  }
  const nameWords = words(spec.name);
  const descWords = words(spec.description ?? "").slice(0, MAX_DESCRIPTION_WORDS);
  const nameMutating = nameWords.find((w) => inflectionOf(w, MUTATING));
  const descMutating = descWords.find((w) => inflectionOf(w, MUTATING));
  const mutatingHit = nameMutating ?? descMutating;

  const a = spec.annotations;
  if (trustAnnotations && a) {
    if (a.readOnlyHint === true) {
      if (mutatingHit) {
        return {
          safety: "side_effecting",
          reason: `annotation readOnlyHint contradicted by ${nameMutating ? "name" : "description"} word "${mutatingHit}"`,
          openWorld,
        };
      }
      return { safety: "read_only", reason: tag("annotation readOnlyHint"), openWorld };
    }
    if (a.idempotentHint === true && a.destructiveHint !== true) {
      return { safety: "idempotent", reason: tag("annotation idempotentHint"), openWorld };
    }
    if (a.readOnlyHint === false) return { safety: "side_effecting", reason: "annotation readOnlyHint=false", openWorld };
  }

  if (heuristics) {
    if (mutatingHit) return { safety: "side_effecting", reason: `heuristic: mutating word "${mutatingHit}"`, openWorld };
    // handles namespaced names like mcp__fs__read_file / fs.read_file
    const leadVerb = nameWords.find((w) => READING.includes(w));
    if (leadVerb && nameWords.indexOf(leadVerb) <= 2) {
      return { safety: "read_only", reason: tag(`heuristic: read verb "${leadVerb}"`), openWorld };
    }
  }
  return { safety: "side_effecting", reason: "default (unknown tools are never speculated)", openWorld };
}

/** Caching classifier over a fixed set of tool specs. */
export class ToolClassifier {
  private cache = new Map<string, Classification>();
  constructor(
    private specs: Map<string, ToolSpec>,
    private opts: ClassifierOptions = {},
  ) {}

  /** Classify a tool by name. Unregistered tools are `side_effecting` unless overridden. */
  classify(name: string): Classification {
    let c = this.cache.get(name);
    if (!c) {
      const spec = this.specs.get(name);
      const overrides = this.opts.overrides ?? {};
      c = spec
        ? classifyTool(spec, this.opts)
        : Object.prototype.hasOwnProperty.call(overrides, name)
          ? { safety: overrides[name], reason: "override", openWorld: !!this.opts.openWorldByDefault }
          : { safety: "side_effecting", reason: "unregistered tool", openWorld: true };
      this.cache.set(name, c);
    }
    return c;
  }

  /** Set (or replace) an explicit label for one tool. */
  setOverride(name: string, safety: Safety): void {
    this.opts = { ...this.opts, overrides: { ...(this.opts.overrides ?? {}), [name]: safety } };
    this.cache.delete(name);
  }
}
