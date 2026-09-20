import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { analyzeTranscript, formatReplay, main, parseArgs, parseTranscript } from '../scripts/replay.js';

const fixture = readFileSync('tests/fixtures/transcript.jsonl', 'utf8');
it('stops at the selected boundary and skips non-session rows and summaries', () => {
  const first = parseTranscript(fixture);
  expect(first.messages).toHaveLength(11);
  expect(first.images).toEqual({ inToolResults: 5000, inUserMessages: 8, invisibleInToolResults: 0 });
  expect(first.messages[2]?.toolResults?.[0]?.text).toBe('');
  expect(first.messages[4]?.toolResults?.[0]?.text).toBe('result text');
  expect(first.messages[3]?.toolUses[0]?.text).toBe('result text');
  expect(parseTranscript(fixture, 2).messages).toHaveLength(12);
  expect(parseTranscript(fixture, 99).messages).toHaveLength(13);
  expect(JSON.stringify(first.messages)).not.toContain('IGNORED');
});

it('counts only visible text and inputs, and produces a content-free verdict', () => {
  const parsed = parseTranscript(fixture);
  const analysis = analyzeTranscript(parsed);
  expect(analysis.byTool.Read).toEqual({ candidates: 2, resultChars: 11 });
  expect(analysis.chars.toolResultText).toBe(11);
  expect(analysis.ceilingRatio).toBeGreaterThan(0.9);
  expect(analysis.payloadChars).toBe(5000);
  expect(formatReplay(parsed)).toContain('eligible');
  expect(formatReplay(parsed)).not.toContain('PRIVATE_SENTINEL');
});

it('reports image bytes as invisible when the stored native record is absent', () => {
  const withoutRecords = fixture.split('\n').filter(Boolean).map((line) => {
    const row = JSON.parse(line);
    delete row.toolUseResult;
    return JSON.stringify(row);
  }).join('\n');
  const parsed = parseTranscript(withoutRecords);
  expect(parsed.images.invisibleInToolResults).toBe(5000);
  expect(analyzeTranscript(parsed).payloadChars).toBe(0);
  expect(formatReplay(parsed)).toContain('plugin skips');
});

it('joins text blocks, ignores thinking, and skips malformed JSON', () => {
  const parsed = parseTranscript('broken\n' + JSON.stringify({ message: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' },
  ] } }));
  expect(parsed.invalidRows).toBe(1);
  expect(parsed.messages[0]?.text).toBe('a\nb');
});

it('runs offline without any network and validates arguments', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must stay offline'));
  try {
    const print = vi.fn();
    await main(['tests/fixtures/transcript.jsonl'], print);
    expect(print.mock.calls[0]?.[0]).toContain('Messages: 11');
    expect(fetcher).not.toHaveBeenCalled();
  } finally { fetcher.mockRestore(); }
  for (const args of [[], ['file', '--until-boundary', '0'], ['file', '--until-boundary'], ['file', '--oops']]) expect(() => parseArgs(args)).toThrow();
});
