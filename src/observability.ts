/**
 * Structured logging and metrics hooks. No runtime dependencies: plug in any
 * logger (console, pino, winston) and any metrics backend (OpenTelemetry,
 * Prometheus, StatsD) through the small interfaces below.
 */

/** Attribute values accepted by metrics backends (OpenTelemetry-compatible). */
export type Attributes = Record<string, string | number | boolean>;

/**
 * Minimal structured logger. `console` satisfies it (`logger: console`).
 * For pino-style `(obj, msg)` loggers wrap it: `{ debug: (m, f) => pino.debug(f, m), ... }`.
 *
 * Fields never contain tool arguments or results unless `logArgs: true` is set.
 */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Metrics sink. Counters are monotonic sums; histograms record distributions (ms).
 * Use {@link otelTelemetry} to bridge to an OpenTelemetry `Meter`.
 *
 * Emitted instruments (attributes in brackets):
 * - counter   `speculate.calls`              [tool, outcome = hit|join|miss|stale|spec_failed|bypass]
 * - counter   `speculate.launches`           [tool, source]
 * - counter   `speculate.wasted`             [tool]
 * - counter   `speculate.skipped`            [reason]
 * - counter   `speculate.invalidations`
 * - counter   `speculate.predictor.errors`   [predictor]
 * - counter   `speculate.internal_errors`    [where]
 * - histogram `speculate.latency_saved`      [tool]        (ms)
 * - histogram `speculate.predictor.duration` [predictor]   (ms)
 */
export interface TelemetrySink {
  counter(name: string, value: number, attributes?: Attributes): void;
  histogram(name: string, value: number, attributes?: Attributes): void;
}

/** Structural subset of an OpenTelemetry `Meter` (from `@opentelemetry/api`). */
export interface MeterLike {
  createCounter(name: string, options?: { description?: string; unit?: string }): { add(value: number, attributes?: Attributes): void };
  createHistogram(
    name: string,
    options?: { description?: string; unit?: string },
  ): { record(value: number, attributes?: Attributes): void };
}

const DESCRIPTIONS: Record<string, [string, string?]> = {
  "speculate.calls": ["Real tool calls by speculation outcome"],
  "speculate.launches": ["Speculative executions started"],
  "speculate.wasted": ["Speculative executions whose result was never used"],
  "speculate.skipped": ["Predictions not launched"],
  "speculate.invalidations": ["Speculative cache invalidations"],
  "speculate.predictor.errors": ["Predictor failures"],
  "speculate.internal_errors": ["Swallowed internal errors (bugs in hooks/predictors)"],
  "speculate.latency_saved": ["Agent-visible latency removed per served call", "ms"],
  "speculate.predictor.duration": ["Predictor latency", "ms"],
};

/**
 * Adapt an OpenTelemetry `Meter` to a {@link TelemetrySink}. Instruments are created lazily.
 *
 * ```ts
 * import { metrics } from "@opentelemetry/api";
 * new Speculator({ ..., telemetry: otelTelemetry(metrics.getMeter("speculate-tools")) });
 * ```
 */
export function otelTelemetry(meter: MeterLike): TelemetrySink {
  const counters = new Map<string, { add(v: number, a?: Attributes): void }>();
  const histograms = new Map<string, { record(v: number, a?: Attributes): void }>();
  const opts = (name: string) => {
    const d = DESCRIPTIONS[name];
    return d ? { description: d[0], ...(d[1] ? { unit: d[1] } : {}) } : undefined;
  };
  return {
    counter(name, value, attributes) {
      let c = counters.get(name);
      if (!c) counters.set(name, (c = meter.createCounter(name, opts(name))));
      c.add(value, attributes);
    },
    histogram(name, value, attributes) {
      let h = histograms.get(name);
      if (!h) histograms.set(name, (h = meter.createHistogram(name, opts(name))));
      h.record(value, attributes);
    },
  };
}

/** A logger that drops everything (the default). */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
