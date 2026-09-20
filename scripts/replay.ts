import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compact, droppableRatio, resolveOptions } from '../src/compact.js';
import { JevClient } from '../src/client.js';
import { buildCompactionEvent } from '../src/events.js';
import { collectToolCalls } from '../src/state.js';
import { hiddenChars } from '../src/payload.js';
import { resolveHookConfig, summarize } from '../hooks/fast-jev.js';
import type { Message } from '../src/types.js';

type Block = Record<string, unknown>;
const object = (value: unknown): value is Block => value !== null && typeof value === 'object' && !Array.isArray(value);
const blocks = (value: unknown): Block[] => Array.isArray(value) ? value.filter(object) : [];
const textOf = (value: unknown): string => typeof value === 'string' ? value : blocks(value)
  .filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');

function imageChars(value: unknown): number {
  return blocks(value).reduce((sum, block) => sum + (block.type === 'image' && object(block.source) &&
    block.source.type === 'base64' && typeof block.source.data === 'string' ? block.source.data.length : 0), 0);
}

export function parseTranscript(jsonl: string, untilBoundary = 1) {
  if (!Number.isInteger(untilBoundary) || untilBoundary < 1) throw new Error('Boundary must be a positive integer');
  const messages: Message[] = [];
  const images = { inToolResults: 0, inUserMessages: 0, invisibleInToolResults: 0 };
  let boundaries = 0;
  let invalidRows = 0;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { invalidRows += 1; continue; }
    if (!object(row) || row.isSidechain === true || row.isCompactSummary === true) continue;
    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      boundaries += 1;
      if (boundaries === untilBoundary) break;
      continue;
    }
    if (!object(row.message)) continue;
    const { role, content } = row.message;
    if (role !== 'user' && role !== 'assistant') continue;
    const message: Message = { role, text: textOf(content), toolUses: [] };
    const resultBlocks = blocks(content).filter((block) => block.type === 'tool_result');
    for (const block of blocks(content)) {
      if (role === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        message.toolUses.push({ tool_use_id: block.id, tool: block.name, input: object(block.input) ? block.input : {} });
      }
      if (role === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        // Claude transcripts store the native tool record beside message, not in its blocks.
        const result = resultBlocks.length === 1 ? row.toolUseResult : undefined;
        (message.toolResults ??= []).push({ tool_use_id: block.tool_use_id, text: textOf(block.content), isError: block.is_error === true,
          ...(result === undefined ? {} : { result }) });
        const base64Chars = imageChars(block.content);
        images.inToolResults += base64Chars;
        // Real bytes against what the plugin measures. The tool name is not known here, and an assumed weight is no measurement.
        images.invisibleInToolResults += Math.max(0, base64Chars - hiddenChars({ tool: '', result }).binary);
      }
    }
    if (role === 'user') images.inUserMessages += imageChars(content);
    messages.push(message);
  }
  const results = new Map(messages.flatMap((message) => message.toolResults ?? []).map((result) => [result.tool_use_id, result]));
  for (const message of messages) for (const tool of message.toolUses) {
    const result = results.get(tool.tool_use_id);
    if (result) {
      tool.text = result.text;
      if (result.result !== undefined) tool.result = result.result;
      if (result.isError) tool.isError = true;
    }
  }
  return { messages, images, boundaries, invalidRows };
}

export function analyzeTranscript(parsed: ReturnType<typeof parseTranscript>) {
  const config = resolveHookConfig({});
  const chars = { userText: 0, assistantText: 0, toolInputs: 0, toolResultText: 0 };
  for (const message of parsed.messages) {
    chars[message.role === 'user' ? 'userText' : 'assistantText'] += message.text.length;
    for (const tool of message.toolUses) chars.toolInputs += JSON.stringify(tool.input).length;
    for (const result of message.toolResults ?? []) chars.toolResultText += result.text.length;
  }
  const byTool: Record<string, { candidates: number; resultChars: number }> = Object.create(null);
  const resolved = resolveOptions(config);
  for (const call of collectToolCalls(parsed.messages, resolved.preserveRecentMessages, resolved)) {
    if (call.pinned) continue;
    const tool = byTool[call.tool] ??= { candidates: 0, resultChars: 0 };
    tool.candidates += 1;
    tool.resultChars += call.resultChars;
  }
  const ceilingRatio = droppableRatio(parsed.messages, config);
  const ceilingRatioWithoutAssumption = droppableRatio(parsed.messages, { ...config, imageTools: [] });
  const all = collectToolCalls(parsed.messages, 0, resolved);
  const payloadChars = all.reduce((sum, call) => sum + call.payloadChars, 0);
  // Every call charged the assumed weight, pinned ones included: matched by tool name, nothing else.
  const assumedImages = { tools: Object.create(null) as Record<string, number>, calls: 0, chars: 0, charsEach: resolved.assumedImageChars };
  for (const call of all) {
    if (call.assumedChars === 0) continue;
    assumedImages.tools[call.tool] = (assumedImages.tools[call.tool] ?? 0) + 1;
    assumedImages.calls += 1;
    assumedImages.chars += call.assumedChars;
  }
  return { config, chars, byTool, ceilingRatio, ceilingRatioWithoutAssumption, assumedImages, payloadChars, minReductionRatio: config.minReductionRatio,
    verdict: ceilingRatio < config.minReductionRatio ? 'ceiling_below_min: plugin skips; manual/auto fall back' : 'eligible: Jev would be asked if an API key is configured' };
}

export function formatReplay(parsed: ReturnType<typeof parseTranscript>): string {
  const analysis = analyzeTranscript(parsed);
  return [
    `Messages: ${parsed.messages.length}`,
    `Chars: user text ${analysis.chars.userText}; assistant text ${analysis.chars.assistantText}; tool inputs ${analysis.chars.toolInputs}; tool result text ${analysis.chars.toolResultText}`,
    `Base64 image chars outside model-facing text: in tool results ${parsed.images.inToolResults}; in user messages ${parsed.images.inUserMessages}`,
    `Stored binary payload chars visible to the plugin: ${analysis.payloadChars}`,
    `Base64 image chars the plugin cannot see: in tool results ${parsed.images.invisibleInToolResults}; in user messages ${parsed.images.inUserMessages}`,
    `Tools matched by name as returning an image (imageTools): ${JSON.stringify(analysis.assumedImages.tools)}`,
    `Assumed image weight (an assumption, not a measurement): ${analysis.assumedImages.calls} result(s) x ${analysis.assumedImages.charsEach} chars = ${analysis.assumedImages.chars}`,
    `droppableRatio: ${analysis.ceilingRatio.toFixed(4)}; configured minimum: ${analysis.minReductionRatio}`,
    `droppableRatio without the image assumption: ${analysis.ceilingRatioWithoutAssumption.toFixed(4)}; with it: ${analysis.ceilingRatio.toFixed(4)}`,
    `Candidates per tool: ${JSON.stringify(analysis.byTool)}`,
    `Verdict: ${analysis.verdict}`,
    `Invalid JSON rows skipped: ${parsed.invalidRows}`,
  ].join('\n');
}

export function parseArgs(args: string[]) {
  let path: string | undefined;
  let ask = false;
  let untilBoundary = 1;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--ask') ask = true;
    else if (arg === '--until-boundary') {
      untilBoundary = Number(args[++i]);
      if (!Number.isInteger(untilBoundary) || untilBoundary < 1) throw new Error('Boundary must be a positive integer');
    } else if (!arg.startsWith('-') && path === undefined) path = arg;
    else throw new Error('Unexpected argument');
  }
  if (!path) throw new Error('Transcript required');
  return { path, ask, untilBoundary };
}

export async function main(args = process.argv.slice(2), print: (text: string) => void = console.log) {
  const options = parseArgs(args);
  const parsed = parseTranscript(await readFile(options.path, 'utf8'), options.untilBoundary);
  print(formatReplay(parsed));
  if (!options.ask) return;
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is required with --ask');
  const analysis = analyzeTranscript(parsed);
  const client = new JevClient({ apiKey });
  const started = Date.now();
  const result = await compact(parsed.messages, client, analysis.config);
  const event = buildCompactionEvent({ ts: new Date().toISOString(), sessionId: 'offline-replay', trigger: 'manual',
    model: analysis.config.model, outcome: 'jev', reasonCode: 'ok', options: analysis.config,
    ceilingRatio: analysis.ceilingRatio, minReductionRatio: analysis.minReductionRatio, messages: parsed.messages,
    result, jev: { ...client.stats, ms: Date.now() - started }, totalMs: Date.now() - started });
  print(summarize(result));
  print(`Per-tool actions: ${JSON.stringify(event.byTool)}`);
  print(`Score histograms: ${JSON.stringify(event.scores)}`);
  print(`Binary chars: ${JSON.stringify(event.binaryChars)}`);
  print(`Assumed images (matched by tool name, assumed weight): ${JSON.stringify(event.assumedImages)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Replay failed. Check the transcript, arguments, and API configuration if using --ask. Usage: tsx scripts/replay.ts TRANSCRIPT [--until-boundary N] [--ask]');
    process.exitCode = 1;
  });
}
