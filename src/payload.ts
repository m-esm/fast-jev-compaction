const BASE64_HEAD = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * True for a string that reads as base64 bytes. Whitespace disqualifies it (the
 * engine stores payloads unwrapped), and so does a head without upper case,
 * lower case and digits together: `seq 1 3000` is digits and newlines, a hex
 * dump has no upper case, and neither is an image.
 */
function looksBinary(value: string): boolean {
  if (value.length <= 4096) return false;
  const head = value.slice(0, 512);
  return BASE64_HEAD.test(head) && /[A-Z]/.test(head) && /[a-z]/.test(head) && /\d/.test(head);
}

/**
 * Estimate stored binary strings without examining or retaining their contents.
 * `modelText` is what the model read for the same result: a stored string that
 * repeats it (Bash keeps `stdout`) is text the plugin already measures, never a
 * hidden payload.
 */
export function binaryPayloadChars(result: unknown, modelText = ''): number {
  const probe = modelText.trim().slice(0, 200);
  const seen = new WeakSet<object>();
  function walk(value: unknown, depth: number): number {
    if (depth > 4) return 0;
    if (typeof value === 'string') {
      if (!looksBinary(value)) return 0;
      if (probe.length >= 32 && value.includes(probe)) return 0;
      return value.length;
    }
    if (value === null || typeof value !== 'object' || seen.has(value)) return 0;
    seen.add(value);
    const total = Object.values(value).reduce<number>((sum, child) => sum + walk(child, depth + 1), 0);
    seen.delete(value);
    return total;
  }
  return walk(result, 0);
}
