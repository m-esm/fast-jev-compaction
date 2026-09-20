import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseArgs(args) {
  const options = { dir: join(homedir(), '.claude/cache/fast-jev-compaction/events'), json: false };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--json') { options.json = true; continue; }
    if (!['--dir', '--days', '--session', '--last'].includes(flag)) throw new Error('Unknown option');
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing option value');
    const key = flag.slice(2);
    if (key === 'days' || key === 'last') {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0 || (key === 'last' && !Number.isInteger(number))) throw new Error('Expected a positive number');
      options[key] = number;
    } else options[key] = value;
  }
  return options;
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const actionKeys = ['keep', 'drop_result', 'protected', 'drop_call', 'pinned', 'resultChars'];
const assumedKeys = ['calls', 'charsBefore', 'charsRemoved'];

function validEvent(event) {
  if (!object(event) || event.v !== 1 || !Number.isFinite(Date.parse(event.ts)) ||
      !['sessionId', 'trigger', 'model'].every((key) => typeof event[key] === 'string') ||
      !['jev', 'fallback', 'skipped'].includes(event.outcome) ||
      !['ok', 'ceiling_below_min', 'reduction_below_min', 'no_api_key', 'jev_error', 'error'].includes(event.reasonCode) ||
      !['ceilingRatio', 'minReductionRatio', 'messagesBefore', 'charsBefore', 'totalMs'].every((key) => finite(event[key])) ||
      !object(event.thresholds) || !finite(event.thresholds.keepResult) || !finite(event.thresholds.keepCall)) return false;
  if (event.byTool !== undefined && (!object(event.byTool) || !Object.values(event.byTool).every((tool) => object(tool) && actionKeys.every((key) => finite(tool[key]))))) return false;
  if (event.scores !== undefined && (!object(event.scores) || !['keepCall', 'keepResult'].every((key) => Array.isArray(event.scores[key]) && event.scores[key].length === 10 && event.scores[key].every(finite)))) return false;
  if (event.jev !== undefined && (!object(event.jev) || !['requests', 'retries', 'ms'].every((key) => finite(event.jev[key])))) return false;
  if (event.reductionRatio !== undefined && !finite(event.reductionRatio)) return false;
  if (event.binaryChars !== undefined && (!object(event.binaryChars) || !finite(event.binaryChars.before) || !finite(event.binaryChars.removed))) return false;
  if (event.assumedImages !== undefined && (!object(event.assumedImages) || !assumedKeys.every((key) => finite(event.assumedImages[key])))) return false;
  return true;
}

export async function loadEvents(options, now = Date.now()) {
  let entries;
  try { entries = await readdir(options.dir, { withFileTypes: true }); }
  catch { return { events: [], skipped: 1 }; }
  let skipped = 0;
  const events = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith('.json')) continue;
    try {
      const event = JSON.parse(await readFile(join(options.dir, entry.name), 'utf8'));
      if (!validEvent(event)) throw new Error('Invalid event');
      if (options.days !== undefined && Date.parse(event.ts) < now - options.days * 86400000) continue;
      if (options.session && !event.sessionId.startsWith(options.session)) continue;
      events.push(event);
    } catch { skipped += 1; }
  }
  events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return { events: options.last === undefined ? events : events.slice(-options.last), skipped };
}

export function totals(events) {
  const outcomes = { jev: 0, fallback: 0, skipped: 0 };
  const autoOutcomes = { jev: 0, fallback: 0, skipped: 0 };
  const fallbackReasons = Object.create(null);
  const byTool = Object.create(null);
  const scores = { keepCall: Array(10).fill(0), keepResult: Array(10).fill(0) };
  const reductions = [];
  const binaryChars = { before: 0, removed: 0 };
  // Events written before 0.5.2 carry no assumed images.
  const assumedImages = Object.fromEntries(assumedKeys.map((key) => [key, 0]));
  for (const event of events) {
    // Auto observations describe the same attempt as the dispatch event.
    if (event.auto) { autoOutcomes[event.outcome] += 1; continue; }
    outcomes[event.outcome] += 1;
    binaryChars.before += event.binaryChars?.before ?? 0;
    binaryChars.removed += event.binaryChars?.removed ?? 0;
    for (const key of assumedKeys) assumedImages[key] += event.assumedImages?.[key] ?? 0;
    if (event.outcome === 'fallback') fallbackReasons[event.reasonCode] = (fallbackReasons[event.reasonCode] ?? 0) + 1;
    if (event.outcome === 'jev' && finite(event.reductionRatio)) reductions.push(event.reductionRatio);
    for (const [name, counts] of Object.entries(event.byTool ?? {})) {
      const tool = byTool[name] ??= Object.fromEntries(actionKeys.map((key) => [key, 0]));
      for (const key of actionKeys) tool[key] += counts[key];
    }
    for (const key of ['keepCall', 'keepResult']) {
      for (let i = 0; i < 10; i += 1) scores[key][i] += event.scores?.[key][i] ?? 0;
    }
  }
  reductions.sort((a, b) => a - b);
  const n = reductions.length;
  const medianReduction = n ? (reductions[Math.floor((n - 1) / 2)] + reductions[Math.floor(n / 2)]) / 2 : undefined;
  return { outcomes, autoOutcomes, fallbackReasons, medianReduction, byTool, scores, binaryChars, assumedImages };
}

const percent = (number) => finite(number) ? `${(number * 100).toFixed(1)}%` : '-';
const safe = (text) => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, '?');

export function formatReport(events, skipped) {
  const lines = ['Local time | session | trigger | outcome | reasonCode | reduction | ceiling | kept/truncated/protected/dropped | requests | ms'];
  for (const event of events) {
    const counts = Object.values(event.byTool ?? {}).reduce((a, t) => {
      a[0] += t.keep + t.pinned; a[1] += t.drop_result; a[2] += t.protected; a[3] += t.drop_call;
      return a;
    }, [0, 0, 0, 0]);
    lines.push(`${new Date(event.ts).toLocaleString()} | ${safe(event.sessionId.slice(0, 8))} | ${safe(event.trigger)}${event.auto ? '/auto' : ''} | ${event.outcome} | ${event.reasonCode} | ${percent(event.reductionRatio)} | ${percent(event.ceilingRatio)} | ${counts.join('/')} | ${event.jev?.requests ?? 0} | ${event.totalMs}`);
  }
  const sum = totals(events);
  lines.push('', `Dispatch totals: ${JSON.stringify(sum.outcomes)}`, `Auto observations: ${JSON.stringify(sum.autoOutcomes)}`,
    `Fallback reasons: ${JSON.stringify(sum.fallbackReasons)}`, `Median Jev reduction: ${percent(sum.medianReduction)}`,
    `Per-tool action totals: ${JSON.stringify(sum.byTool)}`, `Score histograms: ${JSON.stringify(sum.scores)}`,
    `Binary chars: ${JSON.stringify(sum.binaryChars)}`,
    `Assumed images (matched by tool name; chars are an assumed weight, not measured): ${JSON.stringify(sum.assumedImages)}`,
    `Skipped unreadable/invalid entries: ${skipped}`);
  return lines.join('\n');
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const { events, skipped } = await loadEvents(options);
  console.log(options.json ? JSON.stringify(events, null, 2) : formatReport(events, skipped));
  if (options.json && skipped) console.error(`Skipped unreadable/invalid entries: ${skipped}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Report failed. Usage: node scripts/report.mjs [--dir DIR] [--days N] [--session PREFIX] [--json] [--last N]');
    process.exitCode = 1;
  });
}
