import { describe, expect, it, vi } from 'vitest';
import { GATE_DEFAULTS, buildGateQuestions, buildGateState, decideGate, estimateTokens, evaluateGate, gateEvent, type Message } from '../src/index.js';
import { main, turnEnds, parseArgs } from '../scripts/replay.js';
import { totals } from '../scripts/report.mjs';

const messages: Message[] = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `message ${i} ${'context '.repeat(300)}`, toolUses: [] }));
const answers = (boundary = 0.9, needsRecent = 0.1, choice = 'none', confidence = 0.9) => ({
  boundary: { noul: boundary }, needsRecent: { noul: needsRecent }, taskStart: { choice, confidence, probabilities: {} },
});
const state = buildGateState(messages);

describe('gate state', () => {
  it('keeps the first message and newest window with stable user ids', () => {
    expect(state.first?.i).toBe(0);
    expect(state.window).toHaveLength(24);
    expect(state.window[0]).toMatchObject({ i: 36, id: 'u1' });
    expect(state.window.at(-2)).toMatchObject({ i: 58, id: 'u12' });
    expect(estimateTokens(JSON.stringify(state))).toBeLessThanOrEqual(GATE_DEFAULTS.gateMaxStateTokens);
  });

  it('drops oldest window entries first without relabeling retained prompts', () => {
    const small = buildGateState(messages, { gateMaxStateTokens: 1400 });
    expect(estimateTokens(JSON.stringify(small))).toBeLessThanOrEqual(1400);
    expect(small.first?.i).toBe(0);
    expect(small.window.length).toBeLessThan(state.window.length);
    expect(small.window).toEqual(state.window.slice(-small.window.length));
    expect(() => buildGateState(messages, { gateMaxStateTokens: 1 })).toThrow('token budget');
  });

  it('redacts before abridgement and omits tool output contents', () => {
    const secret = 'PRIVATE_GATE_SENTINEL';
    const input: Message[] = [
      { role: 'user', text: `${'a'.repeat(390)}${secret}${'z'.repeat(500)}`, toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { path: secret } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'RAW_OUTPUT_SENTINEL' }] },
    ];
    const built = buildGateState(input, { redactLiterals: [secret] });
    const serialized = JSON.stringify({ state: built, questions: buildGateQuestions(built.window) });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('RAW_OUTPUT_SENTINEL');
    expect(serialized).toContain('chars (omitted)');
    expect(built.window.filter((entry) => entry.id)).toHaveLength(1);
    expect(buildGateQuestions(built.window).taskStart.criteria).toHaveProperty('none');
    expect(buildGateQuestions(built.window).taskStart.criteria).toHaveProperty('all_done');
  });
});

describe('gate verdicts', () => {
  it.each([
    [80, 0.1, 0.9, true, 'hard_ceiling'],
    [65, 0.6, 0.4, true, 'boundary'],
    [65, 0.9, 0.8, false, 'needs_recent'],
    [65, 0.2, 0.1, false, 'in_progress'],
    [39, 0.9, 0.1, false, 'below_floor'],
  ])('decides at %s percent with scores %s/%s', (percent, boundary, needsRecent, compact, reason) => {
    expect(decideGate(answers(boundary as number, needsRecent as number), percent as number, state)).toMatchObject({ compact, reason });
  });

  it('uses numeric fallback without answers', () => {
    expect(decideGate(undefined, 59, state)).toMatchObject({ compact: false, reason: 'jev_unavailable' });
    expect(decideGate(undefined, 60, state)).toMatchObject({ compact: true, reason: 'jev_unavailable' });
    expect(decideGate(undefined, 80, state)).toMatchObject({ compact: true, reason: 'hard_ceiling' });
  });

  it('computes the task tail, preserves the default for none and low confidence, and clamps both ends', () => {
    expect(decideGate(answers(0.9, 0.1, 'u1'), 65, state).tail).toBe(24);
    expect(decideGate(answers(), 65, state).tail).toBeUndefined();
    expect(decideGate(answers(0.9, 0.1, 'u1', 0.49), 65, state).tail).toBeUndefined();
    expect(decideGate(answers(0.9, 0.1, 'all_done'), 65, state).tail).toBe(6);
    expect(decideGate(answers(0.9, 0.1, 'u12'), 65, state).tail).toBe(6);
    expect(decideGate(answers(0.9, 0.1, 'u1'), 65, state, { gateMaxTail: 10 }).tail).toBe(10);
  });

  it('makes no request below the floor and one request with all questions above it', async () => {
    const ask = vi.fn(async () => ({ answers: answers(), model: 'jev-test' }));
    expect(await evaluateGate(messages, 39, {}, { ask })).toMatchObject({ reason: 'below_floor' });
    expect(ask).not.toHaveBeenCalled();
    expect(await evaluateGate(messages, 65, {}, { ask })).toMatchObject({ reason: 'boundary', model: 'jev-test' });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(Object.keys(ask.mock.calls[0]![1])).toEqual(['boundary', 'needsRecent', 'taskStart']);
  });

  it('fails open for exceptions, missing answers, invalid scores and unlisted choices', async () => {
    for (const response of [undefined, answers(2), answers(0.9, 0.1, 'PRIVATE_SENTINEL')]) {
      const ask = vi.fn(async () => ({ answers: response! }));
      expect(await evaluateGate(messages, 65, {}, { ask })).toMatchObject({ compact: true, reason: 'jev_unavailable', tail: undefined, scores: {} });
      expect(ask).toHaveBeenCalledTimes(1);
    }
    const ask = vi.fn(async () => { throw new Error('unavailable'); });
    expect(await evaluateGate(messages, 50, {}, { ask })).toMatchObject({ compact: false, reason: 'jev_unavailable' });
    expect(await evaluateGate(messages, 80, {}, { ask })).toMatchObject({ compact: true, reason: 'jev_unavailable' });
  });
});

it('projects gate events and counts only auto observations in report histograms', () => {
  const gate = gateEvent({ boundary: 0.85, needsRecent: 0.2, taskStart: { choice: 'u1', confidence: 0.9 }, tail: 8, reason: 'boundary', model: 'jev-test', ms: 3 });
  const event = { outcome: 'skipped', auto: { trigger: 40 }, gate };
  const aggregate = totals([event, { ...event, gate: { ...gate, tail: 12 } }]);
  expect(aggregate.gate.reasons).toEqual({ boundary: 2 });
  expect(aggregate.gate.scores.boundary[8]).toBe(2);
  expect(aggregate.gate.scores.needsRecent[2]).toBe(2);
  expect(aggregate.gate.medianTail).toBe(10);
  expect(JSON.stringify(gateEvent({ ...gate, taskStart: { choice: '/PRIVATE_SENTINEL', confidence: 1 }, model: 'PRIVATE_SENTINEL' }))).not.toContain('PRIVATE_SENTINEL');
});

it('replays one offline verdict per completed user turn without network access', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline only'));
  try {
    const print = vi.fn();
    await main(['tests/fixtures/transcript.jsonl', '--gate', '--percent', '65'], print);
    expect(print.mock.calls.length).toBeGreaterThan(0);
    expect(print.mock.calls.every(([line]) => /^Turn \d+: jev_unavailable;/.test(line))).toBe(true);
    const below = vi.fn();
    await main(['tests/fixtures/transcript.jsonl', '--gate', '--percent', '30'], below);
    expect(below.mock.calls).toHaveLength(print.mock.calls.length);
    expect(below.mock.calls.every(([line]) => line.includes('below_floor'))).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(turnEnds(messages.slice(0, 6))).toEqual([2, 4, 6]);
    expect(() => parseArgs(['file', '--gate', '--percent', '101'])).toThrow();
  } finally { fetcher.mockRestore(); }
});
