# Contributing

Thanks for helping. This project's core promise is that speculation is **lossless**: it may make a tool call faster,
never different. Every change is reviewed against that.

## Setup

Development needs **Node 22.12+** (the test runner requires it); the published package supports Node 18.18+.

```bash
npm ci
npm run check        # lint + format check + typecheck + tests with coverage + build + dist smoke tests
```

Individual steps:

| command | what it does |
|---|---|
| `npm run lint` / `npm run lint:fix` | ESLint (type-aware) |
| `npm run format` / `npm run format:check` | Prettier |
| `npm run typecheck` | `tsc` over src, tests, bench, examples |
| `npm test` / `npm run test:coverage` | Vitest (coverage thresholds: 85% lines/functions/statements, 75% branches) |
| `npm run build` | tsup: dual ESM/CJS + declarations into `dist/` |
| `npm run test:dist` | `node --test` smoke tests against the built package (run these on Node 18/20/22) |
| `npm run bench` | simulated benchmark (deterministic, ~20 s) |
| `npm run examples` | runs every example |
| `npm run eval:traces -- <file>` | trace-replay evaluation |

## Pull requests

- Keep PRs focused, and add a test for every bug fix (it should fail without the fix).
- Anything that touches the engine (`src/speculator.ts`, `src/canonical.ts`, `src/classifier.ts`) needs a test that
  exercises the race or safety property involved; use `VirtualClock` for deterministic timing.
- Never widen what runs speculatively by default. New heuristics may only make classification *more* conservative.
- Benchmark numbers in the README must say whether they are simulated or measured on real data, and how to reproduce them.
- Update `CHANGELOG.md` under "Unreleased".
- Public API changes need JSDoc and, before 2.0, must be backwards compatible.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Please do not open public issues for vulnerabilities.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
