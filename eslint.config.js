// @ts-check
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
  js.configs.recommended,
  {
    // type-aware rules for all TypeScript (library, tests, bench, examples)
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { project: "./tsconfig.check.json", tsconfigRootDir: import.meta.dirname },
      globals: globals.node,
    },
    rules: {
      // async correctness matters in a concurrency library
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
      "@typescript-eslint/only-throw-error": "error",
      "no-console": "off",
    },
  },
  {
    // the core library: no `any` leaking out
    files: ["src/**/*.ts"],
    ignores: ["src/adapters/agent-sdk.ts", "src/adapters/mcp-proxy.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
  {
    // adapters are written against structural vendor types; tests poke at internals
    files: ["src/adapters/**/*.ts", "test/**/*.ts", "bench/**/*.ts", "examples/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: { globals: globals.node, sourceType: "module" },
  },
  { files: ["**/*.cjs"], languageOptions: { sourceType: "commonjs" } },
  prettier,
);
