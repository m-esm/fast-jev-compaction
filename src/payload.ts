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

/**
 * Case-insensitive substrings of tool names taken to return an image. Nothing a
 * hook can see identifies such a result, so the name is all there is to go on.
 */
export const DEFAULT_IMAGE_TOOLS: readonly string[] = [
  'screenshot',
  'render',
  'capture',
  'thumb',
  'snapshot',
  'image',
];

/** ASSUMED weight of one such image, in the char units everything else uses. */
export const DEFAULT_ASSUMED_IMAGE_CHARS = 6000;

/**
 * Leading part of every note left where an image was dropped without being
 * measured. A result whose text carries it has no image left, so it is never
 * charged or rewritten a second time.
 */
export const IMAGE_DROP_MARK = '[fast-jev-compaction dropped any image attached to this tool result';

/** The note for a result dropped because its tool name matched `imageTools`. */
export const IMAGE_DROP_NOTE = `${IMAGE_DROP_MARK} (tool name matched imageTools); re-run the tool if needed]`;

/** The note for a kept result whose message had to be rebuilt for a sibling. */
export const IMAGE_SIBLING_NOTE = `${IMAGE_DROP_MARK} (its message was rebuilt to compact another tool result); re-run the tool if needed]`;

export interface HiddenCharsOptions {
  /** Case-insensitive substrings of tool names. Empty disables the assumption. */
  imageTools: readonly string[];
  /** Assumed weight of one image. Not a measurement. */
  assumedImageChars: number;
}

export const DEFAULT_HIDDEN_CHARS_OPTIONS: HiddenCharsOptions = {
  imageTools: DEFAULT_IMAGE_TOOLS,
  assumedImageChars: DEFAULT_ASSUMED_IMAGE_CHARS,
};

/** True when the tool name contains one of `imageTools`, whatever the case. */
export function matchesImageTool(tool: string, imageTools: readonly string[]): boolean {
  const name = tool.toLowerCase();
  return imageTools.some((part) => {
    const needle = part.trim().toLowerCase();
    // An empty entry would match every tool.
    return needle.length > 0 && name.includes(needle);
  });
}

/**
 * What one tool result weighs beyond its text. `binary` is measured from the
 * stored record. `assumed` is a guess, charged only when nothing was measured,
 * the tool name matches `imageTools`, and the text does not already say the
 * image was dropped. This is the one place it is decided: the char totals
 * before and after a compaction and the candidate list all come through here.
 */
export function hiddenChars(
  call: { tool: string; result?: unknown; text?: string },
  options: HiddenCharsOptions = DEFAULT_HIDDEN_CHARS_OPTIONS,
): { binary: number; assumed: number } {
  const text = call.text ?? '';
  const binary = binaryPayloadChars(call.result, text);
  const assumed =
    binary === 0 &&
    options.assumedImageChars > 0 &&
    !text.includes(IMAGE_DROP_MARK) &&
    matchesImageTool(call.tool, options.imageTools)
      ? options.assumedImageChars
      : 0;
  return { binary, assumed };
}
