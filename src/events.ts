import { transcriptChars, reductionRatio, resolveOptions } from './compact.js';
import { collectToolCalls } from './state.js';
import { JevHttpError } from './request.js';
import type { CompactOptions, CompactResult, Message } from './types.js';

export type ReasonCode = 'ok' | 'ceiling_below_min' | 'reduction_below_min' | 'no_api_key' | 'jev_error' | 'error';
export type Outcome = 'jev' | 'fallback' | 'skipped';
export type ToolTotals = { keep: number; drop_result: number; protected: number; drop_call: number; pinned: number; resultChars: number };
export type Scores = { keepCall: number[]; keepResult: number[] };

export interface CompactionEvent {
  v: 1;
  ts: string;
  sessionId: string;
  agentId?: string;
  trigger: string;
  model: string;
  outcome: Outcome;
  reasonCode: ReasonCode;
  reason?: string;
  ceilingRatio: number;
  minReductionRatio: number;
  thresholds: { keepResult: number; keepCall: number };
  messagesBefore: number;
  messagesAfter?: number;
  charsBefore: number;
  charsAfter?: number;
  reductionRatio?: number;
  contextPercentBefore?: number;
  contextPercentAfter?: number;
  stats?: CompactResult['stats'];
  byTool?: Record<string, ToolTotals>;
  scores?: Scores;
  jev?: { requests: number; retries: number; ms: number };
  totalMs: number;
  binaryChars: { before: number; removed: number };
  /**
   * Images assumed from a tool name matching `imageTools`. The chars are the
   * configured assumption times the calls, never a measurement.
   */
  assumedImages: { calls: number; charsBefore: number; charsRemoved: number };
  auto?: { trigger: number; compactions: number; disabledReason?: string };
}

export const REASONS: Record<ReasonCode, string> = {
  ok: 'Jev compaction completed',
  ceiling_below_min: 'Removable context is below the configured minimum',
  reduction_below_min: 'Jev reduction is below the configured minimum',
  no_api_key: 'TYPESAFE_API_KEY is not configured',
  jev_error: 'Jev request or response processing failed',
  error: 'Compaction failed',
};

/** Never copy arbitrary exception text: upstream responses may echo private input. */
export function eventReason(code: ReasonCode, error?: unknown): string {
  return `${REASONS[code]}${error instanceof JevHttpError ? ` (HTTP ${error.status})` : ''}`.slice(0, 300);
}

export function scoreHistograms(result: Pick<CompactResult, 'decisions'>): Scores {
  const scores: Scores = { keepCall: Array(10).fill(0), keepResult: Array(10).fill(0) };
  for (const decision of result.decisions) {
    if (decision.reason === 'pinned') continue;
    for (const key of ['keepCall', 'keepResult'] as const) {
      const value = decision[key];
      if (!Number.isFinite(value)) continue;
      const bucket = Math.max(0, Math.min(9, Math.floor(value * 10)));
      scores[key][bucket] = (scores[key][bucket] ?? 0) + 1;
    }
  }
  return scores;
}

export interface EventInput {
  ts: string;
  sessionId: string;
  agentId?: string;
  trigger: string;
  model: string;
  outcome: Outcome;
  reasonCode: ReasonCode;
  error?: unknown;
  ceilingRatio: number;
  minReductionRatio: number;
  options?: CompactOptions;
  messages: readonly Message[];
  result?: CompactResult;
  contextPercentBefore?: number;
  contextPercentAfter?: number;
  jev?: CompactionEvent['jev'];
  totalMs: number;
  auto?: CompactionEvent['auto'];
}

/** Explicit projection only. Transcripts, inputs, outputs and exceptions never enter the event. */
export function buildCompactionEvent(input: EventInput): CompactionEvent {
  const options = resolveOptions(input.options);
  const calls = collectToolCalls(input.messages, options.preserveRecentMessages, options);
  const assumed = (list: readonly { assumedChars: number }[]): number =>
    list.reduce((sum, call) => sum + call.assumedChars, 0);
  const assumedBefore = assumed(calls);
  // What is left after counts kept siblings that lost their image to a rebuild too.
  const assumedAfter = input.result
    ? assumed(collectToolCalls(input.result.messages, options.preserveRecentMessages, options))
    : assumedBefore;
  const decisions = new Map(input.result?.decisions.map((d) => [d.id, d]));
  const byTool: Record<string, ToolTotals> = Object.create(null);
  for (const call of calls) {
    const totals = byTool[call.tool] ??= { keep: 0, drop_result: 0, protected: 0, drop_call: 0, pinned: 0, resultChars: 0 };
    totals.resultChars += call.resultChars;
    const decision = decisions.get(call.id);
    if (decision) totals[decision.reason === 'pinned' || decision.reason === 'protected' ? decision.reason : decision.action] += 1;
    else if (call.pinned) totals.pinned += 1;
  }
  const result = input.result;
  return {
    v: 1, ts: input.ts, sessionId: input.sessionId,
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    trigger: input.trigger, model: input.model, outcome: input.outcome,
    reasonCode: input.reasonCode, reason: eventReason(input.reasonCode, input.error),
    ceilingRatio: input.ceilingRatio, minReductionRatio: input.minReductionRatio,
    thresholds: { keepResult: options.keepResultThreshold, keepCall: options.keepCallThreshold },
    messagesBefore: input.messages.length,
    charsBefore: transcriptChars(input.messages, options),
    binaryChars: {
      before: calls.reduce((sum, call) => sum + call.payloadChars, 0),
      removed: calls.reduce((sum, call) => sum + (decisions.has(call.id) && decisions.get(call.id)?.action !== 'keep' ? call.payloadChars : 0), 0),
    },
    assumedImages: {
      calls: calls.filter((call) => call.assumedChars > 0).length,
      charsBefore: assumedBefore,
      charsRemoved: Math.max(0, assumedBefore - assumedAfter),
    },
    ...(result ? { messagesAfter: result.stats.messagesAfter, charsAfter: result.stats.charsAfter,
      reductionRatio: reductionRatio(result), stats: result.stats, scores: scoreHistograms(result) } : {}),
    byTool,
    ...(input.contextPercentBefore === undefined ? {} : { contextPercentBefore: input.contextPercentBefore }),
    ...(input.contextPercentAfter === undefined ? {} : { contextPercentAfter: input.contextPercentAfter }),
    ...(input.jev ? { jev: { requests: input.jev.requests, retries: input.jev.retries, ms: input.jev.ms } } : {}),
    totalMs: input.totalMs,
    ...(input.auto ? { auto: { trigger: input.auto.trigger, compactions: input.auto.compactions,
      ...(input.auto.disabledReason ? { disabledReason: 'compaction stopped freeing context' } : {}) } } : {}),
  };
}
