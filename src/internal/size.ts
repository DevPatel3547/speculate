/**
 * Approximate in-memory size of a value in bytes (UTF-16 strings, typed-array
 * byte lengths, small per-object overhead). Stops walking once `cap` is exceeded,
 * so the cost is bounded by `cap` rather than by the size of the value.
 */
export function approxBytes(value: unknown, cap = Number.POSITIVE_INFINITY): number {
  let total = 0;
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length && total <= cap) {
    const v = stack.pop();
    switch (typeof v) {
      case "string":
        total += 2 * v.length;
        continue;
      case "number":
      case "bigint":
        total += 8;
        continue;
      case "boolean":
        total += 4;
        continue;
      case "object":
        break;
      default:
        continue;
    }
    if (v === null || seen.has(v)) continue;
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      total += v.byteLength;
      continue;
    }
    if (v instanceof ArrayBuffer) {
      total += v.byteLength;
      continue;
    }
    total += 16;
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else if (v instanceof Map) {
      for (const [k, x] of v) stack.push(k, x);
    } else if (v instanceof Set) {
      for (const x of v) stack.push(x);
    } else {
      for (const k of Object.keys(v)) {
        total += 2 * k.length;
        stack.push((v as Record<string, unknown>)[k]);
      }
    }
  }
  return total;
}
