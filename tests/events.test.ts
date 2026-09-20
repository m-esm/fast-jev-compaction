import { expect, it } from 'vitest';
import { buildCompactionEvent, scoreHistograms, type EventInput } from '../src/events.js';
import { compact } from '../src/compact.js';
import { JevHttpError } from '../src/request.js';
import type { CallDecision, Message } from '../src/types.js';

const sentinel = 'SENTINEL_SECRET_9f3a';
const messages: Message[] = [
  { role: 'user', text: sentinel, toolUses: [] },
  { role: 'assistant', text: sentinel, toolUses: [{ tool_use_id: 'x', tool: 'Read', input: { file_path: `/private/${sentinel}`, secret: sentinel } }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'x', text: sentinel.repeat(100) }] },
];
const input: EventInput = { ts: '2026-09-20T19:00:00.000Z', sessionId: '12345678-session', trigger: 'manual', model: 'jev-latest',
  outcome: 'jev', reasonCode: 'ok', ceilingRatio: 0.9, minReductionRatio: 0.25, options: { preserveRecentMessages: 0 }, messages, totalMs: 25 };

it.each(['jev', 'fallback', 'skipped'] as const)('projects content-free %s events, including malicious error text', async (outcome) => {
  const result = await compact(messages, { ask: async () => ({ answers: { call_t1: { noul: 0.8 }, result_t1: { noul: 0.1 } } }) }, input.options);
  const event = buildCompactionEvent({ ...input, outcome, result, reasonCode: outcome === 'jev' ? 'ok' : 'jev_error', error: new JevHttpError(500, sentinel) });
  expect(JSON.stringify(event)).not.toContain(sentinel);
  expect(JSON.stringify(event)).not.toContain('/private/');
  expect(event.byTool?.Read).toEqual({ keep: 0, drop_result: 1, protected: 0, drop_call: 0, pinned: 0, resultChars: sentinel.length * 100 });
  expect(event.stats).toBe(result.stats);
  expect(event.thresholds).toEqual({ keepResult: 0.4, keepCall: 0.15 });
  expect(event.reason!.length).toBeLessThanOrEqual(300);
});

it('builds an error event without results or raw exceptions', () => {
  const event = buildCompactionEvent({ ...input, outcome: 'fallback', reasonCode: 'error', error: new Error(sentinel) });
  expect(JSON.stringify(event)).not.toContain(sentinel);
  expect(event.scores).toBeUndefined();
  expect(event.messagesBefore).toBe(3);
});

it('buckets boundary probabilities and excludes pinned calls', () => {
  const decisions = [0, 0.1, 0.999, 1].map((n, i): CallDecision => ({ id: String(i), tool: 'Read', action: 'keep', reason: 'kept', keepCall: n, keepResult: n }));
  decisions.push({ ...decisions[0]!, reason: 'pinned' });
  expect(scoreHistograms({ decisions })).toEqual({ keepCall: [1, 1, 0, 0, 0, 0, 0, 0, 0, 2], keepResult: [1, 1, 0, 0, 0, 0, 0, 0, 0, 2] });
});
