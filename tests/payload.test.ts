import { expect, it } from 'vitest';
import { binaryPayloadChars } from '../src/payload.js';
import { compact, droppableRatio, messageChars, transcriptChars } from '../src/compact.js';
import { collectToolCalls } from '../src/state.js';
import { buildCompactionEvent } from '../src/events.js';
import { toSessionMessages } from '../hooks/fast-jev.js';
import type { Message } from '../src/types.js';

const bytes = 'iVBORw0K'.repeat(1250);
const stored = { type: 'image', file: { base64: bytes } };
function transcript(): (Message & { handle: string })[] {
  return [
    { role: 'user', text: 'start', toolUses: [], handle: 'first' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'x', tool: 'Read', input: {}, text: '', result: stored }], handle: 'call' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'x', text: '', result: stored, isError: false }], handle: 'result' },
  ];
}

it('counts only long base64-like strings within four levels', () => {
  expect(binaryPayloadChars(stored)).toBe(10000);
  expect(binaryPayloadChars('A'.repeat(4096))).toBe(0);
  expect(binaryPayloadChars(bytes.slice(0, 4097))).toBe(4097);
  expect(binaryPayloadChars(`!${bytes}`)).toBe(0);
  expect(binaryPayloadChars(`${bytes.slice(0, 256)}!${bytes}`)).toBe(0);
  expect(binaryPayloadChars({ a: { b: { c: { d: bytes } } } })).toBe(10000);
  expect(binaryPayloadChars({ a: { b: { c: { d: { e: bytes } } } } })).toBe(0);
  expect(binaryPayloadChars([stored, stored])).toBe(20000);
  const cyclic: Record<string, unknown> = { bytes };
  cyclic.self = cyclic;
  expect(binaryPayloadChars(cyclic)).toBe(10000);
  expect(binaryPayloadChars(null)).toBe(0);
});

it.each(['both', 'call', 'result'])('charges a mirrored payload once when stored on %s', (side) => {
  const messages = transcript();
  if (side === 'call') delete messages[2]!.toolResults![0]!.result;
  if (side === 'result') delete messages[1]!.toolUses[0]!.result;
  expect(collectToolCalls(messages, 0)[0]!.payloadChars).toBe(10000);
  expect(transcriptChars(messages)).toBe(10007);
  expect(droppableRatio(messages, { preserveRecentMessages: 0 })).toBeCloseTo(10000 / 10007);
  expect(messageChars(messages[side === 'result' ? 2 : 1]!)).toBeGreaterThanOrEqual(10000);
});

it('forces empty image results to be rebuilt without handles or stored records', async () => {
  const messages = transcript();
  const result = await compact(messages, { ask: async () => ({ answers: { call_t1: { noul: 0.9 }, result_t1: { noul: 0 } } }) }, { preserveRecentMessages: 0 });
  const out = toSessionMessages(messages as any, result.messages);
  const marker = '\n[fast-jev-compaction removed a ~10 KB binary payload (image) from this tool result; re-run the tool if needed]';
  expect(out[1]!.toolUses[0]!.text).toBe(marker);
  expect(out[2]!.toolResults![0]!.text).toBe(marker);
  expect(out[1]!.handle).toBeUndefined();
  expect(out[2]!.handle).toBeUndefined();
  expect(out[1]!.toolUses[0]!).not.toHaveProperty('result');
  expect(out[2]!.toolResults![0]!).not.toHaveProperty('result');
  expect(messages[2]!.toolResults![0]!.result).toBe(stored);
  expect(result.stats.charsBefore).toBe(10007);
  expect(result.stats.charsAfter).toBe(7 + marker.length);
  const event = buildCompactionEvent({ ts: '', sessionId: 'test', trigger: 'manual', model: 'jev-latest', outcome: 'jev', reasonCode: 'ok',
    ceilingRatio: 0.99, minReductionRatio: 0.25, options: { preserveRecentMessages: 0 }, messages, result, totalMs: 0 });
  expect(event.binaryChars).toEqual({ before: 10000, removed: 10000 });
  expect(JSON.stringify(event)).not.toContain(bytes);
});

it('keeps pinned or scored-kept images intact', async () => {
  const messages = transcript();
  for (const options of [{ preserveRecentMessages: 0 }, { preserveRecentMessages: 6 }]) {
    const result = await compact(messages, { ask: async () => ({ answers: { call_t1: { noul: 1 }, result_t1: { noul: 1 } } }) }, options);
    expect(result.messages[1]).toBe(messages[1]);
    expect(result.messages[2]).toBe(messages[2]);
    expect(result.stats.charsAfter).toBe(result.stats.charsBefore);
  }
});

it('does not mistake plain tool output for a binary payload', () => {
  const seq = Array.from({ length: 3000 }, (_, i) => String(i + 1)).join('\n');
  // `seq 1 3000`, as Bash stores it: digits and newlines, no letters at all.
  expect(binaryPayloadChars({ stdout: seq, stderr: '' })).toBe(0);
  expect(binaryPayloadChars('A'.repeat(5000))).toBe(0);
  expect(binaryPayloadChars('deadbeef0123'.repeat(500))).toBe(0);
  // A stored copy of what the model read is text already measured, whatever it looks like.
  expect(binaryPayloadChars({ stdout: bytes }, bytes)).toBe(0);
  expect(binaryPayloadChars({ file: { base64: bytes } }, 'a caption the tool returned with it')).toBe(10000);
});

it('truncates long text and notes the payload when a result carries both', async () => {
  const text = 'line of ordinary tool output\n'.repeat(200);
  const messages: Message[] = [
    { role: 'user', text: 'start', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'x', tool: 'Read', input: {}, text, result: stored }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'x', text, result: stored, isError: false }] },
  ];
  const result = await compact(messages, { ask: async () => ({ answers: { call_t1: { noul: 0.9 }, result_t1: { noul: 0 } } }) }, { preserveRecentMessages: 0 });
  const out = result.messages[2]!.toolResults![0]!.text;
  expect(out.startsWith(text.slice(0, 300))).toBe(true);
  expect(out).toContain('truncated');
  expect(out).toContain('binary payload');
  expect(out.length).toBeLessThan(700);
});
