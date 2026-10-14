import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ToolCall } from "../types.js";

/**
 * A staleness validator fingerprints the external state a call depends on.
 * The fingerprint is taken right BEFORE the speculative execution starts and
 * again when the real call arrives; any difference => the cached result is
 * stale and the call is re-executed for real.
 */
export interface StalenessValidator {
  /** Return a fingerprint, or undefined if this validator does not apply to the call. */
  snapshot(call: ToolCall): Promise<string | undefined>;
}

export interface FsValidatorOptions {
  /** Arg keys holding paths. Default: path, file_path, file, dir, directory. */
  pathKeys?: string[];
  /** Base dir for relative paths. Default: process.cwd(). */
  root?: string;
  /** Hash file contents too (catches same-size edits within mtime granularity). Default false. */
  hash?: boolean;
  /** Max entries walked for a directory argument. Default 5000. */
  maxEntries?: number;
  /** Directory names skipped while walking. */
  skipDirs?: string[];
  /** Restrict to these tools (default: any call that has a path arg). */
  tools?: string[];
  /** Files larger than this are fingerprinted by mtime+size only, never read. Default 16 MiB. */
  maxHashBytes?: number;
}

/**
 * Filesystem validator: regular files are fingerprinted by mtime+size(+sha256);
 * directories by a bounded recursive walk of (name, mtime, size). Special files
 * (FIFOs, devices, sockets) are never opened, so a path like `/dev/zero` or a named
 * pipe cannot hang or exhaust memory.
 */
export function fsValidator(opts: FsValidatorOptions = {}): StalenessValidator {
  const keys = opts.pathKeys ?? ["path", "file_path", "file", "dir", "directory"];
  const root = opts.root ?? process.cwd();
  const maxEntries = opts.maxEntries ?? 5000;
  const skip = new Set(opts.skipDirs ?? ["node_modules", ".git"]);
  const maxHashBytes = opts.maxHashBytes ?? 16 * 1024 * 1024;

  async function fpPath(p: string, st: Stats): Promise<string> {
    if (!st.isFile()) return `s:${st.mode}:${st.mtimeMs}:${st.size}`; // special file: never read it
    if (!opts.hash || st.size > maxHashBytes) return `f:${st.mtimeMs}:${st.size}`;
    const h = createHash("sha256")
      .update(await readFile(p))
      .digest("hex");
    return `f:${st.mtimeMs}:${st.size}:${h}`;
  }

  async function fpDir(dir: string): Promise<string> {
    const h = createHash("sha256");
    let n = 0;
    const walk = async (d: string): Promise<void> => {
      const st = await stat(d);
      h.update(`D${d}:${st.mtimeMs}\n`);
      const ents = (await readdir(d, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const e of ents) {
        if (++n > maxEntries) {
          h.update("TRUNCATED");
          return;
        }
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (!skip.has(e.name)) await walk(p);
        } else {
          const s = await stat(p).catch(() => undefined);
          h.update(`F${p}:${s ? await fpPath(p, s).catch(() => "unreadable") : "missing"}\n`);
        }
      }
    };
    await walk(dir);
    return `d:${h.digest("hex")}`;
  }

  return {
    async snapshot(call) {
      if (opts.tools && !opts.tools.includes(call.name)) return undefined;
      const parts: string[] = [];
      for (const k of keys) {
        const v = call.args?.[k];
        if (typeof v !== "string") continue;
        const p = resolve(root, v);
        try {
          const st = await stat(p);
          parts.push(`${k}=${st.isDirectory() ? await fpDir(p) : await fpPath(p, st)}`);
        } catch {
          parts.push(`${k}=missing`);
        }
      }
      return parts.length ? parts.join("|") : undefined;
    },
  };
}

/** Validator from a plain function (e.g. a version counter in your own store). */
export function customValidator(fn: (call: ToolCall) => string | undefined | Promise<string | undefined>): StalenessValidator {
  return { snapshot: async (call) => fn(call) };
}
