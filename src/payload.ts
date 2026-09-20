/** Estimate stored binary strings without examining or retaining their contents. */
export function binaryPayloadChars(result: unknown): number {
  const seen = new WeakSet<object>();
  function walk(value: unknown, depth: number): number {
    if (depth > 4) return 0;
    if (typeof value === 'string') {
      return value.length > 4096 && /^[A-Za-z0-9+/=\s]+$/.test(value.slice(0, 256)) ? value.length : 0;
    }
    if (value === null || typeof value !== 'object' || seen.has(value)) return 0;
    seen.add(value);
    const total = Object.values(value).reduce<number>((sum, child) => sum + walk(child, depth + 1), 0);
    seen.delete(value);
    return total;
  }
  return walk(result, 0);
}
