import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { formatReport, loadEvents, parseArgs, totals } from '../scripts/report.mjs';

const dir = 'tests/fixtures/events';
it('filters fixtures, sorts newest last, and merges totals', async () => {
  const { events, skipped } = await loadEvents({ dir });
  expect(skipped).toBe(0);
  expect(events.map((e) => e.outcome)).toEqual(['jev', 'fallback', 'skipped']);
  expect(totals(events)).toMatchObject({ outcomes: { jev: 1, fallback: 1, skipped: 1 }, fallbackReasons: { no_api_key: 1 }, medianReduction: 0.6 });
  expect(totals(events).scores.keepCall).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
  expect(formatReport(events, 0)).toContain('Median Jev reduction: 60.0%');
  expect(totals([{ ...events[0], binaryChars: { before: 5000, removed: 5000 } }]).binaryChars).toEqual({ before: 5000, removed: 5000 });
  expect((await loadEvents({ dir, session: '1234', last: 1 })).events[0].outcome).toBe('fallback');
  expect((await loadEvents({ dir, days: 1 }, Date.parse('2026-09-21T10:30:00Z'))).events).toHaveLength(2);
  expect(totals([events[0], { ...events[0], auto: { trigger: 85, compactions: 1 } }]).outcomes.jev).toBe(1);
});

it('skips malformed, wrong-shape and unreadable entries', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'jev-events-'));
  try {
    await writeFile(join(temp, 'broken.json'), '{');
    await writeFile(join(temp, 'wrong.json'), 'null');
    await mkdir(join(temp, 'unreadable.json'));
    expect(await loadEvents({ dir: temp })).toEqual({ events: [], skipped: 3 });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

it('runs both CLI output modes and rejects bad flags', () => {
  expect(execFileSync(process.execPath, ['scripts/report.mjs', '--dir', dir], { encoding: 'utf8' })).toContain('Dispatch totals:');
  expect(JSON.parse(execFileSync(process.execPath, ['scripts/report.mjs', '--dir', dir, '--json', '--last', '1'], { encoding: 'utf8' }))).toHaveLength(1);
  for (const args of [['--last', '0'], ['--days', 'no'], ['--dir'], ['--oops']]) expect(() => parseArgs(args)).toThrow();
});
