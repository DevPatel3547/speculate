import { Rng } from "./rng.js";

/** In-memory filesystem with per-file and global version counters (for staleness validation). */
export class VFS {
  private files = new Map<string, { content: string; version: number }>();
  version = 0;

  write(path: string, content: string): void {
    this.version++;
    this.files.set(path, { content, version: this.version });
  }
  read(path: string): string {
    const f = this.files.get(path);
    if (!f) throw new Error(`ENOENT: no such file '${path}'`);
    return f.content;
  }
  fileVersion(path: string): number {
    return this.files.get(path)?.version ?? -1;
  }
  paths(): string[] {
    return [...this.files.keys()].sort();
  }
  list(dir: string): string[] {
    const prefix = dir === "." || dir === "" ? "" : dir.replace(/\/$/, "") + "/";
    const out = new Set<string>();
    for (const p of this.paths()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      out.add(slash < 0 ? rest : rest.slice(0, slash + 1));
    }
    if (!out.size) throw new Error(`ENOENT: no such directory '${dir}'`);
    return [...out].sort();
  }
  grep(pattern: string, dir: string): string[] {
    const prefix = dir === "." || dir === "" ? "" : dir.replace(/\/$/, "") + "/";
    const hits: string[] = [];
    for (const p of this.paths()) {
      if (!p.startsWith(prefix)) continue;
      this.read(p)
        .split("\n")
        .forEach((line, i) => {
          if (line.includes(pattern)) hits.push(`${p}:${i + 1}: ${line.trim()}`);
        });
    }
    return hits.slice(0, 40);
  }
  digest(): string {
    return this.paths()
      .map((p) => `${p}@${this.read(p).length}:${this.read(p)}`)
      .join("\n");
  }
}

const VERBS = [
  "parse",
  "load",
  "build",
  "render",
  "validate",
  "fetch",
  "resolve",
  "format",
  "merge",
  "compute",
  "encode",
  "decode",
  "normalize",
  "apply",
  "collect",
  "index",
];
const NOUNS = [
  "Config",
  "User",
  "Session",
  "Token",
  "Route",
  "Cache",
  "Order",
  "Invoice",
  "Schema",
  "Payload",
  "Header",
  "Query",
  "Event",
  "Metric",
  "Plugin",
  "Asset",
];
const MODS = [
  "config",
  "auth",
  "router",
  "cache",
  "orders",
  "billing",
  "schema",
  "http",
  "query",
  "events",
  "metrics",
  "plugins",
  "assets",
  "utils",
  "store",
  "logger",
  "session",
  "format",
  "api",
  "jobs",
];

export interface Repo {
  vfs: VFS;
  modules: string[];
  /** function name -> module */
  fnModule: Map<string, string>;
  /** module -> functions defined in it */
  moduleFns: Map<string, string[]>;
  bugFn: string;
  bugModule: string;
}

export function srcPath(mod: string): string {
  return `src/${mod}.ts`;
}
export function testPath(mod: string): string {
  return `test/${mod}.test.ts`;
}

/** Generate a small TypeScript-looking repo with one planted bug. */
export function makeRepo(seed: string): Repo {
  const rng = new Rng(`repo:${seed}`);
  const modules = [...MODS]
    .sort(() => rng.next() - 0.5)
    .slice(0, 10 + rng.int(8))
    .sort();
  const fnModule = new Map<string, string>();
  const moduleFns = new Map<string, string[]>();
  for (const m of modules) {
    const fns: string[] = [];
    const n = 2 + rng.int(3);
    while (fns.length < n) {
      const f = rng.pick(VERBS) + rng.pick(NOUNS);
      if (!fnModule.has(f)) {
        fnModule.set(f, m);
        fns.push(f);
      }
    }
    moduleFns.set(m, fns);
  }
  const allFns = [...fnModule.keys()];
  const bugFn = rng.pick(allFns);
  const bugModule = fnModule.get(bugFn)!;
  const vfs = new VFS();
  vfs.write("README.md", `# demo-service\n\nModules: ${modules.join(", ")}\n`);
  vfs.write("package.json", `{ "name": "demo-service", "scripts": { "test": "vitest" } }\n`);
  for (const m of modules) {
    const lines: string[] = [];
    const calls: string[][] = [];
    for (const f of moduleFns.get(m)!) {
      const callees = [rng.pick(allFns), rng.pick(allFns)].filter((c) => c !== f);
      calls.push(callees);
    }
    const imports = new Map<string, Set<string>>();
    calls.flat().forEach((c) => {
      const cm = fnModule.get(c)!;
      if (cm !== m) (imports.get(cm) ?? imports.set(cm, new Set()).get(cm)!).add(c);
    });
    for (const [im, names] of [...imports].sort()) lines.push(`import { ${[...names].sort().join(", ")} } from "./${im}";`);
    lines.push("");
    moduleFns.get(m)!.forEach((f, i) => {
      lines.push(`export function ${f}(input: unknown) {`);
      for (const c of calls[i]) lines.push(`  const r${c} = ${c}(input);`);
      if (f === bugFn) lines.push(`  return input; // BUG: missing validation`);
      else lines.push(`  return input;`);
      lines.push(`}`, "");
    });
    vfs.write(srcPath(m), lines.join("\n"));
    const t = [`import { ${moduleFns.get(m)!.join(", ")} } from "../src/${m}";`, ""];
    for (const f of moduleFns.get(m)!) t.push(`test("${f} works", () => expect(${f}(1)).toBeDefined());`);
    vfs.write(testPath(m), t.join("\n"));
  }
  return { vfs, modules, fnModule, moduleFns, bugFn, bugModule };
}

/** Deterministic "test runner": a module's tests fail while its source contains a BUG marker. */
export function runTests(vfs: VFS, modules: string[]): string {
  const failed: string[] = [];
  let passed = 0;
  for (const m of modules) {
    const src = vfs.read(srcPath(m));
    const n = (src.match(/export function/g) ?? []).length;
    if (src.includes("BUG")) failed.push(m);
    else passed += n;
  }
  const out: string[] = [];
  for (const m of failed) out.push(`FAIL ${testPath(m)}`, `  x tests in ${testPath(m)} failed: expected validated output`);
  out.push(`Tests: ${failed.length} failed, ${passed} passed`);
  return out.join("\n");
}
