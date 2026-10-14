import { abortError } from "./clock.js";
import type { Clock } from "./types.js";

/** Counting semaphore whose acquire() can be cancelled with an AbortSignal. */
export class Semaphore {
  private active = 0;
  private queue: { resolve: () => void; reject: (e: unknown) => void; signal?: AbortSignal; onAbort?: () => void }[] = [];
  constructor(private readonly capacity: number) {
    if (!(capacity >= 1)) throw new Error("Semaphore capacity must be >= 1");
  }

  get inUse(): number {
    return this.active;
  }
  get waiting(): number {
    return this.queue.length;
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    if (this.active < this.capacity) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const item: (typeof this.queue)[number] = { resolve, reject, signal };
      if (signal) {
        item.onAbort = () => {
          const i = this.queue.indexOf(item);
          if (i >= 0) this.queue.splice(i, 1);
          reject(abortError(signal.reason));
        };
        signal.addEventListener("abort", item.onAbort, { once: true });
      }
      this.queue.push(item);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      if (next.onAbort) next.signal!.removeEventListener("abort", next.onAbort);
      next.resolve(); // slot handed over directly; active count unchanged
    } else {
      this.active--;
    }
  }
}

/** Resolve/reject with `p`, or reject as soon as `signal` aborts (p keeps running but is ignored). */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(abortError(signal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- propagate the original rejection unchanged
        reject(e);
      },
    );
  });
}

/**
 * Resolve/reject with `p`, or reject with a TimeoutError after `ms` (on `clock`),
 * or with an AbortError when `signal` aborts — whichever happens first.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, clock: Clock, signal: AbortSignal | undefined, what: string): Promise<T> {
  const t = new AbortController();
  const timeout = new Promise<never>((_, reject) => {
    clock.sleep(ms, t.signal).then(
      () => {
        const e = new Error(`${what} timed out after ${ms}ms`);
        e.name = "TimeoutError";
        reject(e);
      },
      () => {},
    );
  });
  const raced = Promise.race([p, timeout]);
  return (signal ? raceAbort(raced, signal) : raced).finally(() => t.abort());
}
