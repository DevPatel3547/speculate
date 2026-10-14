/** Token extractors used by the pattern predictor to template args from previous results. */

export type TokenExtractor = (result: unknown) => string[];

function collectStrings(v: unknown, out: string[], budget = { n: 200_000 }): void {
  if (budget.n <= 0 || v == null) return;
  if (typeof v === "string") {
    out.push(v.length > budget.n ? v.slice(0, budget.n) : v);
    budget.n -= v.length;
  } else if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out, budget);
  } else if (typeof v === "object") {
    for (const x of Object.values(v)) collectStrings(x, out, budget);
  }
}

function uniq(xs: Iterable<string>, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

const PATH_RE = /(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\.[A-Za-z][A-Za-z0-9]{0,7}(?![A-Za-z0-9_])/g;

/** File-path-looking tokens ("src/a.ts", "README.md"), in order of first appearance. */
export const pathTokens: TokenExtractor = (result) => {
  const strs: string[] = [];
  collectStrings(result, strs);
  const found: string[] = [];
  for (const s of strs) for (const m of s.matchAll(PATH_RE)) found.push(m[0]);
  return uniq(found, 32);
};

const DEF_RE =
  /\b(?:function|class|def|interface|type|struct|fn|func|enum)\s+([A-Za-z_][A-Za-z0-9_]*)|\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(/g;

/** Identifiers *defined* in a code-ish result (function/class/def/...), in order. */
export const definedIdentifiers: TokenExtractor = (result) => {
  const strs: string[] = [];
  collectStrings(result, strs);
  const found: string[] = [];
  for (const s of strs) for (const m of s.matchAll(DEF_RE)) found.push(m[1] ?? m[2]);
  return uniq(found, 32);
};

export const defaultExtractors: Record<string, TokenExtractor> = {
  path: pathTokens,
  ident: definedIdentifiers,
};
