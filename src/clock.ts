import type { Clock } from "./types.js";

/** Normalize an abort reason into an Error (name "AbortError" unless the reason already is an Error). */
export function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const e = new Error(typeof reason === "string" ? reason : "Aborted");
  e.name = "AbortError";
  return e;
}

/** True for AbortError / TimeoutError errors (cancellation, not failure). */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

/** Largest delay `setTimeout` supports; larger values would fire immediately. */
const MAX_TIMER_MS = 2_147_483_647;

/** Real wall-clock time (`performance.now()` + `setTimeout`). */
export const realClock: Clock = {
  now: () => performance.now(),
  sleep(ms, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal.reason));
      let t: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (t !== undefined) clearTimeout(t);
        reject(abortError(signal!.reason));
      };
      // setTimeout overflows above 2^31-1 ms and fires immediately; an infinite sleep never fires.
      if (Number.isFinite(ms)) {
        t = setTimeout(
          () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          },
          Math.min(MAX_TIMER_MS, Math.max(0, ms)),
        );
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};

/** Scaled real clock: sleep(ms) really sleeps ms*scale, now() reports unscaled ms. */
export function scaledClock(scale: number): Clock {
  const t0 = performance.now();
  return {
    now: () => (performance.now() - t0) / scale,
    sleep: (ms, signal) => realClock.sleep(ms * scale, signal),
  };
}

interface Timer {
  t: number;
  seq: number;
  fire: () => void;
}

const idle = () => new Promise<void>((r) => setImmediate(r));

/**
 * Deterministic discrete-event clock. Time only advances when every pending
 * promise chain is blocked on a virtual sleep. All code under test must use
 * this clock (no real timers / IO) for runs to be deterministic.
 */
export class VirtualClock implements Clock {
  private t = 0;
  private seq = 0;
  private timers: Timer[] = [];

  now(): number {
    return this.t;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal.reason));
      const timer: Timer = {
        t: this.t + Math.max(0, ms),
        seq: this.seq++,
        fire: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const i = this.timers.indexOf(timer);
        if (i >= 0) this.timers.splice(i, 1);
        reject(abortError(signal!.reason));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      // sorted insert by (t, seq)
      let i = this.timers.length;
      while (i > 0 && (this.timers[i - 1].t > timer.t || (this.timers[i - 1].t === timer.t && this.timers[i - 1].seq > timer.seq))) i--;
      this.timers.splice(i, 0, timer);
    });
  }

  /** Drive `fn` to completion on virtual time. Leftover background timers are dropped. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let done = false;
    let value: T | undefined;
    let error: unknown;
    fn().then(
      (v) => {
        done = true;
        value = v;
      },
      (e) => {
        done = true;
        error = e;
      },
    );
    for (;;) {
      await idle();
      if (done) break;
      const next = this.timers.shift();
      if (!next) throw new Error("VirtualClock deadlock: main task is pending but no timers are scheduled");
      this.t = next.t;
      next.fire();
    }
    this.timers = [];
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- rethrow whatever fn() rejected with, unchanged
    if (error !== undefined) throw error;
    return value as T;
  }
}
