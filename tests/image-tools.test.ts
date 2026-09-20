import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_ASSUMED_IMAGE_CHARS,
  DEFAULT_IMAGE_TOOLS,
  IMAGE_DROP_MARK,
  IMAGE_DROP_NOTE,
  IMAGE_SIBLING_NOTE,
  hiddenChars,
  matchesImageTool,
} from '../src/payload.js';
import { compact, droppableRatio, messageChars, resolveOptions, transcriptChars } from '../src/compact.js';
import { collectToolCalls } from '../src/state.js';
import { buildCompactionEvent } from '../src/events.js';
import { resolveHookConfig, toSessionMessages } from '../hooks/fast-jev.js';
import { analyzeTranscript, formatReplay, parseTranscript } from '../scripts/replay.js';
import { formatReport, loadEvents, totals } from '../scripts/report.mjs';
import type { JevAsker, Message } from '../src/types.js';

const NOTE = '[fast-jev-compaction dropped any image attached to this tool result (tool name matched imageTools); re-run the tool if needed]';
const RENDER = 'mcp__3dvp__render_product';
const SENTINEL = 'SENTINEL_SECRET_41c7';
const TEXT = `Rendered product view front at 1024x768 for ${SENTINEL}, saved under /synthetic/out (ok).`;
const LONG = 'line of ordinary render log output\n'.repeat(100);
const bytes = 'iVBORw0K'.repeat(1250);
const stored = { type: 'image', file: { base64: bytes } };
const defaults = { imageTools: DEFAULT_IMAGE_TOOLS, assumedImageChars: DEFAULT_ASSUMED_IMAGE_CHARS };
const unassumed = { imageTools: [], assumedImageChars: 0 };
const all = { preserveRecentMessages: 0 };

type Held = Message & { handle: string };

function transcript(tool = RENDER, text = TEXT): Held[] {
  return [
    { role: 'user', text: 'start', toolUses: [], handle: 'first' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'x', tool, input: { view: SENTINEL }, text }], handle: 'call' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'x', text, isError: false }], handle: 'result' },
  ];
}

/** Scores per call id, in order: [keepCall, keepResult]. */
function asker(...scores: [number, number][]): JevAsker {
  return {
    ask: async () => ({
      answers: Object.fromEntries(scores.flatMap(([call, result], i) => [
        [`call_t${i + 1}`, { noul: call }],
        [`result_t${i + 1}`, { noul: result }],
      ])),
    }),
  };
}

/** What the transcript weighs with the assumption switched off: text, inputs, measured payloads. */
const visible = (messages: readonly Message[]) => transcriptChars(messages, unassumed);

describe('matching a tool by name', () => {
  it('matches case-insensitive substrings of the default list', () => {
    for (const tool of [RENDER, 'mcp__3dvp__capture_thumb', 'mcp__playwright__browser_take_SCREENSHOT', 'Mcp__X__Snapshot', 'get_item_images']) {
      expect(matchesImageTool(tool, DEFAULT_IMAGE_TOOLS)).toBe(true);
      expect(hiddenChars({ tool, text: 'ok' }, defaults)).toEqual({ binary: 0, assumed: 6000 });
    }
    expect(hiddenChars({ tool: RENDER, text: 'ok' })).toEqual({ binary: 0, assumed: 6000 });
    expect(hiddenChars({ tool: 'mcp__x__plot_chart' }, { imageTools: ['PLOT'], assumedImageChars: 1234 }).assumed).toBe(1234);
  });

  it('leaves a non-matching tool alone', () => {
    for (const tool of ['Read', 'Bash', 'mcp__3dvp__set_param', '']) {
      expect(hiddenChars({ tool, text: 'ok' }, defaults)).toEqual({ binary: 0, assumed: 0 });
    }
  });

  it('is disabled by an empty list, blank entries or a zero weight', () => {
    expect(hiddenChars({ tool: RENDER }, { imageTools: [], assumedImageChars: 6000 }).assumed).toBe(0);
    expect(hiddenChars({ tool: 'Read' }, { imageTools: ['', '  '], assumedImageChars: 6000 }).assumed).toBe(0);
    expect(hiddenChars({ tool: RENDER }, { imageTools: DEFAULT_IMAGE_TOOLS, assumedImageChars: 0 }).assumed).toBe(0);
    expect(collectToolCalls(transcript(), 0, { imageTools: [], assumedImageChars: 6000 })[0]!.assumedChars).toBe(0);
    expect(droppableRatio(transcript(), { ...all, imageTools: [] })).toBe(0);
  });

  it('never assumes on top of a measured payload or an image already dropped', () => {
    expect(hiddenChars({ tool: RENDER, result: stored, text: '' }, defaults)).toEqual({ binary: 10000, assumed: 0 });
    expect(hiddenChars({ tool: RENDER, text: `${TEXT}\n${NOTE}` }, defaults).assumed).toBe(0);
    expect(hiddenChars({ tool: RENDER, text: `${TEXT}\n${IMAGE_SIBLING_NOTE}` }, defaults).assumed).toBe(0);
    expect(NOTE.startsWith(IMAGE_DROP_MARK)).toBe(true);
    expect(IMAGE_DROP_NOTE).toBe(NOTE);
    expect(IMAGE_SIBLING_NOTE.startsWith(IMAGE_DROP_MARK)).toBe(true);
  });

  it('resolves the options', () => {
    expect(resolveOptions().imageTools).toEqual(DEFAULT_IMAGE_TOOLS);
    expect(resolveOptions().assumedImageChars).toBe(6000);
    expect(resolveOptions({ imageTools: [' Render ', ''] }).imageTools).toEqual(['render']);
    expect(resolveOptions({ imageTools: [] }).imageTools).toEqual([]);
    expect(resolveOptions({ assumedImageChars: Number.NaN }).assumedImageChars).toBe(6000);
    expect(resolveOptions({ assumedImageChars: -5 }).assumedImageChars).toBe(0);
  });
});

describe('accounting', () => {
  it('charges the assumed weight once per result, on the result side', () => {
    const messages = transcript();
    const call = collectToolCalls(messages, 0)[0]!;
    expect(call).toMatchObject({ payloadChars: 0, assumedChars: 6000 });
    expect(transcriptChars(messages)).toBe(visible(messages) + 6000);
    expect(visible(messages)).toBe(5 + JSON.stringify({ view: SENTINEL }).length + TEXT.length);
    expect(messageChars(messages[1]!)).toBe(JSON.stringify({ view: SENTINEL }).length);
    expect(droppableRatio(messages, all)).toBeCloseTo(6000 / (visible(messages) + 6000));
    // A call without a result has no image yet.
    expect(transcriptChars(messages.slice(0, 2))).toBe(visible(messages.slice(0, 2)));
  });

  it.each([
    ['a short result', RENDER, TEXT, [0.9, 0]],
    ['a long result', RENDER, LONG, [0.9, 0]],
    ['a removed call', 'Screenshot', TEXT, [0, 0]],
  ] as const)('removes the text taken out plus one assumed image for %s', async (_, tool, text, scores) => {
    const messages = transcript(tool, text);
    const result = await compact(messages, asker([scores[0], scores[1]]), all);
    const { charsBefore, charsAfter } = result.stats;
    expect(charsBefore).toBe(transcriptChars(messages));
    expect(charsBefore - charsAfter).toBe(visible(messages) - visible(result.messages) + DEFAULT_ASSUMED_IMAGE_CHARS);
    expect(transcriptChars(result.messages)).toBe(visible(result.messages));
  });

  it('counts the short result exactly', async () => {
    const result = await compact(transcript(), asker([0.9, 0]), all);
    expect(result.stats.charsBefore - result.stats.charsAfter).toBe(6000 - (1 + NOTE.length));
  });
});

describe('dropping an assumed image', () => {
  it('forces the rebuild of a short result on both sides, with the exact note and no handle', async () => {
    const messages = transcript();
    const result = await compact(messages, asker([0.9, 0]), all);
    const out = toSessionMessages(messages as any, result.messages);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]!.toolUses[0]!.text).toBe(`${TEXT}\n${NOTE}`);
    expect(out[2]!.toolResults![0]!.text).toBe(`${TEXT}\n${NOTE}`);
    expect(out[1]!.handle).toBeUndefined();
    expect(out[2]!.handle).toBeUndefined();
    expect(result.decisions[0]).toMatchObject({ action: 'drop_result', reason: 'result_dropped' });
  });

  it('truncates a long result normally, then adds the note', async () => {
    const result = await compact(transcript(RENDER, LONG), asker([0.9, 0]), all);
    const text = result.messages[2]!.toolResults![0]!.text;
    expect(text.startsWith(LONG.slice(0, 300))).toBe(true);
    expect(text).toContain('truncated');
    expect(text.endsWith(`\n${NOTE}`)).toBe(true);
  });

  it('leaves a kept or pinned result untouched, handle included', async () => {
    const messages = transcript();
    for (const options of [all, { preserveRecentMessages: 6 }]) {
      const result = await compact(messages, asker([1, 1]), options);
      const out = toSessionMessages(messages as any, result.messages);
      expect(result.messages[1]).toBe(messages[1]);
      expect(result.messages[2]).toBe(messages[2]);
      expect(out.map((message) => message.handle)).toEqual(['first', 'call', 'result']);
      expect(result.stats.charsAfter).toBe(result.stats.charsBefore);
    }
    // Pinned wins even when Jev would have dropped it.
    const pinned = await compact(messages, asker([0, 0]), { preserveRecentMessages: 6 });
    expect(pinned.messages[2]).toBe(messages[2]);
  });

  it.each([['short', TEXT], ['long', LONG]])('charges nothing and changes nothing the second time (%s text)', async (_, text) => {
    const first = await compact(transcript(RENDER, text), asker([0.9, 0]), all);
    expect(collectToolCalls(first.messages, 0)[0]!.assumedChars).toBe(0);
    const second = await compact(first.messages, asker([0.9, 0]), all);
    expect(second.stats.charsBefore).toBe(first.stats.charsAfter);
    expect(second.stats.charsAfter).toBe(second.stats.charsBefore);
    second.messages.forEach((message, index) => expect(message).toBe(first.messages[index]));
    expect(second.messages[2]!.toolResults![0]!.text.split(IMAGE_DROP_MARK)).toHaveLength(2);
  });
});

describe('a kept sibling in a rebuilt message', () => {
  function pair(): Held[] {
    return [
      { role: 'user', text: 'start', toolUses: [], handle: 'first' },
      { role: 'assistant', text: '', handle: 'calls', toolUses: [
        { tool_use_id: 'a', tool: 'Read', input: {}, text: LONG },
        { tool_use_id: 'b', tool: 'mcp__3dvp__capture_thumb', input: {}, text: TEXT },
      ] },
      { role: 'user', text: '', toolUses: [], handle: 'results', toolResults: [
        { tool_use_id: 'a', text: LONG, isError: false },
        { tool_use_id: 'b', text: TEXT, isError: false },
      ] },
    ];
  }

  it('notes the lost image on both sides of the pair, once', async () => {
    const messages = pair();
    const result = await compact(messages, asker([0.9, 0], [1, 1]), all);
    expect(result.decisions.map((d) => d.action)).toEqual(['drop_result', 'keep']);
    const out = toSessionMessages(messages as any, result.messages);
    expect(out[1]!.handle).toBeUndefined();
    expect(out[2]!.handle).toBeUndefined();
    expect(out[2]!.toolResults![0]!.text).toContain('truncated');
    expect(out[2]!.toolResults![1]!.text).toBe(`${TEXT}\n${IMAGE_SIBLING_NOTE}`);
    expect(out[1]!.toolUses[1]!.text).toBe(`${TEXT}\n${IMAGE_SIBLING_NOTE}`);
    // The image is gone with the rebuild, so it is no longer charged.
    expect(collectToolCalls(result.messages, 0)[1]!.assumedChars).toBe(0);
    expect(result.stats.charsBefore - result.stats.charsAfter).toBe(visible(messages) - visible(result.messages) + 6000);
    const event = buildCompactionEvent({ ts: '', sessionId: 'test', trigger: 'manual', model: 'jev-latest', outcome: 'jev', reasonCode: 'ok',
      ceilingRatio: 0.9, minReductionRatio: 0.25, options: all, messages, result, totalMs: 0 });
    expect(event.assumedImages).toEqual({ calls: 1, charsBefore: 6000, charsRemoved: 6000 });

    const second = await compact(result.messages, asker([0.9, 0], [1, 1]), all);
    second.messages.forEach((message, index) => expect(message).toBe(result.messages[index]));
    expect(second.messages[2]!.toolResults![1]!.text.split(IMAGE_DROP_MARK)).toHaveLength(2);
  });

  it('notes a kept sibling that holds a measured payload and drops its stored record', async () => {
    const messages = pair();
    messages[1]!.toolUses[1] = { tool_use_id: 'b', tool: 'Read', input: {}, text: '', result: stored };
    messages[2]!.toolResults![1] = { tool_use_id: 'b', text: '', isError: false, result: stored };
    const result = await compact(messages, asker([0.9, 0], [1, 1]), all);
    expect(result.messages[2]!.toolResults![1]!.text).toBe(`\n${IMAGE_SIBLING_NOTE}`);
    expect(result.messages[2]!.toolResults![1]!).not.toHaveProperty('result');
    expect(result.messages[1]!.toolUses[1]!).not.toHaveProperty('result');
    expect(messages[2]!.toolResults![1]!.result).toBe(stored);
  });

  it('says nothing when the sibling result sits in a message that keeps its handle', async () => {
    const messages = pair();
    const [a, b] = messages[2]!.toolResults!;
    messages[2]!.toolResults = [a!];
    messages.push({ role: 'user', text: '', toolUses: [], handle: 'second result', toolResults: [b!] });
    const result = await compact(messages, asker([0.9, 0], [1, 1]), all);
    expect(result.messages[3]).toBe(messages[3]);
    expect(result.messages[1]!.toolUses[1]).toBe(messages[1]!.toolUses[1]);
    expect(collectToolCalls(result.messages, 0)[1]!.assumedChars).toBe(6000);
  });
});

describe('events, hook options and replay', () => {
  it('records assumed images without any content', async () => {
    const messages = transcript();
    const base = { ts: '', sessionId: 'test', trigger: 'manual', model: 'jev-latest', ceilingRatio: 0.9, minReductionRatio: 0.25,
      options: all, messages, totalMs: 0 } as const;
    const result = await compact(messages, asker([0.9, 0]), all);
    const event = buildCompactionEvent({ ...base, outcome: 'jev', reasonCode: 'ok', result });
    expect(event.assumedImages).toEqual({ calls: 1, charsBefore: 6000, charsRemoved: 6000 });
    expect(event.byTool?.[RENDER]?.drop_result).toBe(1);
    expect(JSON.stringify(event)).not.toContain(SENTINEL);
    expect(JSON.stringify(event)).not.toContain('/synthetic/');
    const skipped = buildCompactionEvent({ ...base, outcome: 'fallback', reasonCode: 'ceiling_below_min' });
    expect(skipped.assumedImages).toEqual({ calls: 1, charsBefore: 6000, charsRemoved: 0 });
    expect(JSON.stringify(skipped)).not.toContain(SENTINEL);
    const off = buildCompactionEvent({ ...base, options: { ...all, imageTools: [] }, outcome: 'fallback', reasonCode: 'ceiling_below_min' });
    expect(off.assumedImages).toEqual({ calls: 0, charsBefore: 0, charsRemoved: 0 });
  });

  it('reads the hook options: a list, an empty string that disables, absence that defers', () => {
    expect(resolveHookConfig({ imageTools: 'Render, shot ,' }).imageTools).toEqual(['Render', 'shot']);
    expect(resolveHookConfig({ imageTools: '' }).imageTools).toEqual([]);
    expect(resolveHookConfig({}).imageTools).toBeUndefined();
    expect(resolveHookConfig({ assumedImageChars: 9000 }).assumedImageChars).toBe(9000);
    expect(resolveHookConfig({ assumedImageChars: 'big' }).assumedImageChars).toBeUndefined();
    expect(droppableRatio(transcript(), { ...resolveHookConfig({ imageTools: '' }), ...all })).toBe(0);
    expect(droppableRatio(transcript(), { ...resolveHookConfig({}), ...all })).toBeGreaterThan(0.9);
  });

  it('keeps the manifest defaults equal to the library defaults', () => {
    const manifest = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
    expect(manifest.userConfig.imageTools.default).toBe(DEFAULT_IMAGE_TOOLS.join(','));
    expect(manifest.userConfig.assumedImageChars.default).toBe(DEFAULT_ASSUMED_IMAGE_CHARS);
  });

  it('totals assumed images in the report and tolerates events written before them', async () => {
    const { events, skipped } = await loadEvents({ dir: 'tests/fixtures/events' });
    expect(skipped).toBe(0);
    expect(events[1].assumedImages).toBeUndefined();
    expect({ ...totals(events).assumedImages }).toEqual({ calls: 1, charsBefore: 6000, charsRemoved: 6000 });
    expect(formatReport(events, 0)).toContain('Assumed images (matched by tool name; chars are an assumed weight, not measured): {"calls":1,"charsBefore":6000,"charsRemoved":6000}');
  });

  it('replays a session of MCP images: under the minimum without the assumption, over it with', () => {
    const parsed = parseTranscript(readFileSync('tests/fixtures/transcript-mcp-images.jsonl', 'utf8'));
    expect(parsed.messages).toHaveLength(18);
    expect(parsed.images.invisibleInToolResults).toBe(parsed.images.inToolResults);
    const analysis = analyzeTranscript(parsed);
    expect(analysis.payloadChars).toBe(0);
    expect(analysis.ceilingRatioWithoutAssumption).toBeLessThan(0.25);
    expect(analysis.ceilingRatioWithoutAssumption).toBeGreaterThan(0);
    expect(analysis.ceilingRatio).toBeGreaterThan(0.25);
    expect({ ...analysis.assumedImages, tools: { ...analysis.assumedImages.tools } }).toEqual({ calls: 4, chars: 24000, charsEach: 6000,
      tools: { mcp__3dvp__render_product: 2, mcp__3dvp__capture_thumb: 1, mcp__playwright__browser_take_screenshot: 1 } });
    const text = formatReplay(parsed);
    expect(text).toContain('eligible');
    expect(text).toContain('4 result(s) x 6000 chars = 24000');
    expect(text).toContain(`without the image assumption: ${analysis.ceilingRatioWithoutAssumption.toFixed(4)}; with it: ${analysis.ceilingRatio.toFixed(4)}`);
    expect(text).not.toContain('SYNTHETIC_PRIVATE');
  });
});
