import { defineConfig } from "tsup";

// TS 6 deprecates `baseUrl`, which the declaration bundler sets internally.
const dts = { compilerOptions: { ignoreDeprecations: "6.0" } };

export default defineConfig([
  {
    // library: dual ESM + CJS with .d.ts / .d.cts. ESM output shares chunks between entry
    // points (one copy of the engine); CJS output is one self-contained file per entry.
    entry: { index: "src/index.ts", mcp: "src/mcp.ts", eval: "src/eval.ts" },
    format: ["esm", "cjs"],
    dts,
    target: "node18",
    platform: "node",
    sourcemap: false, // output is not minified; stack traces stay readable without maps
    clean: false,
    treeshake: true,
  },
  {
    // CLI: ESM only (bin files are executed, never imported)
    entry: { bin: "src/cli/bin.ts", "speculate-mcp": "src/cli/speculate-mcp.ts" },
    outDir: "dist/cli",
    format: ["esm"],
    target: "node18",
    platform: "node",
    sourcemap: false, // output is not minified; stack traces stay readable without maps
    clean: false,
  },
]);
