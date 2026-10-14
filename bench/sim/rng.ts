/** Deterministic randomness for the simulator. */

export function hash32(s: string): number {
  // FNV-1a then a murmur-style finalizer
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class Rng {
  private s: number;
  constructor(seed: number | string) {
    this.s = typeof seed === "string" ? hash32(seed) : seed >>> 0 || 1;
  }
  /** mulberry32 */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  normal(): number {
    const u = Math.max(1e-12, this.next());
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** Log-normal with the given median and log-space sigma. */
  lognormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }
}

/** A log-normal sample that depends only on `key` (same key => same value). */
export function keyedLognormal(key: string, median: number, sigma: number): number {
  return new Rng(key).lognormal(median, sigma);
}
