import type { Logger } from "../observability.js";

/** Output sinks (injectable for tests). */
export interface CliIO {
  stdout(s: string): void;
  stderr(s: string): void;
}

export const processIO: CliIO = {
  stdout: (s) => void process.stdout.write(s.endsWith("\n") ? s : s + "\n"),
  stderr: (s) => void process.stderr.write(s.endsWith("\n") ? s : s + "\n"),
};

/** Thrown for invalid command-line usage (exit code 2). */
export class UsageError extends Error {
  override name = "UsageError";
}

export const LEVELS = ["silent", "error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LEVELS)[number];

/** Logger writing one line per record to `io.stderr` (stdout may be a protocol channel). */
export function stderrLogger(level: LogLevel, io: CliIO): Logger {
  const rank = LEVELS.indexOf(level);
  const at = (l: Exclude<LogLevel, "silent">) => (msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS.indexOf(l) > rank) return;
    let extra = "";
    if (fields && Object.keys(fields).length) {
      try {
        extra = " " + JSON.stringify(fields);
      } catch {
        extra = " [unserializable fields]";
      }
    }
    io.stderr(`[speculate] ${l} ${msg}${extra}`);
  };
  return { error: at("error"), warn: at("warn"), info: at("info"), debug: at("debug") };
}

export function parseIntArg(name: string, v: string | undefined, min: number): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!/^\d+$/.test(v.trim()) || !Number.isSafeInteger(n) || n < min)
    throw new UsageError(`${name} must be an integer >= ${min} (got "${v}")`);
  return n;
}

export function parseNumberArg(name: string, v: string | undefined, min: number, max = Infinity): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n) || n < min || n > max)
    throw new UsageError(`${name} must be a number in [${min}, ${max}] (got "${v}")`);
  return n;
}

export function parseList(v: string | undefined): string[] {
  return v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}
