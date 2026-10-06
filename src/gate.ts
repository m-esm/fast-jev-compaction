import { resolveOptions } from './compact.js';
import { createRedactor, type Redactor } from './redact.js';
import { collectToolCalls, estimateTokens, fitState, goalFromMessages, truncate } from './state.js';
import { noulAnswer } from './request.js';
import type { CompactOptions, HistoryEntry, JevAsker, JevQuestions, JevResponse, Message } from './types.js';

export const GATE_DEFAULTS = {
  gate: true,
  gateFloorPercent: 40,
  hardCeilingPercent: 80,
  boundaryThreshold: 0.6,
  needsRecentThreshold: 0.4,
  cutConfidence: 0.5,
  gateWindowMessages: 24,
  gateMaxTail: 40,
  gateMaxStateTokens: 8000,
};

export type GateConfig = CompactOptions & typeof GATE_DEFAULTS & { compactAtPercent?: number };
export type GateOptions = Partial<GateConfig> & { contextPercent?: number };
export type GateReason = 'hard_ceiling' | 'boundary' | 'all_done' | 'in_progress' | 'needs_recent' | 'below_floor' | 'jev_unavailable';
export type GateEntry = HistoryEntry & { id?: string };
export type GateState = { context: string; goal: string; contextPercent: number; length: number; first?: GateEntry; window: GateEntry[] };
export type GateScores = { boundary?: number; needsRecent?: number; taskStart?: { choice: string; confidence: number } };
export type GateVerdict = { compact: boolean; reason: GateReason; tail: number | undefined; scores: GateScores };

export function clampGateTail(tail: number, options: GateOptions): number {
  const minimum = resolveOptions(options).preserveRecentMessages;
  return Math.max(minimum, Math.min(Math.max(minimum, options.gateMaxTail ?? GATE_DEFAULTS.gateMaxTail), Math.floor(tail)));
}

export function buildGateState(messages: readonly Message[], options: GateOptions = {}, redactor?: Redactor): GateState {
  const config = { ...GATE_DEFAULTS, ...options };
  const resolved = resolveOptions(options);
  const redact = redactor ?? createRedactor({ level: resolved.redact, extraRules: resolved.redactRules, literals: resolved.redactLiterals });
  const start = Math.max(0, messages.length - Math.max(1, Math.min(253, Math.floor(config.gateWindowMessages))));
  const indices = messages.map((_, i) => i).filter((i) => i === 0 || i >= start);
  const selected = indices.map((i) => messages[i]!);
  const fitted = fitState(selected, collectToolCalls(selected, 0), {
    maxStateTokens: Infinity, preserveRecentMessages: 0, goal: '',
  }, redact);
  const entries = new Map(fitted.state.history.map((entry) => [entry.i, entry]));
  const window = indices.map((i, j): GateEntry => {
    const entry = entries.get(j) ?? { i: j, role: messages[i]!.role, text: '' };
    const text = entry.text.length > 590 ? `${entry.text.slice(0, 400)}\n[…]\n${entry.text.slice(-150)}` : entry.text;
    return { ...entry, i, text };
  });
  let userId = 0;
  for (const entry of window) {
    if (entry.i >= start && entry.role === 'user' && messages[entry.i]!.text.trim() && !messages[entry.i]!.toolResults?.length) {
      entry.id = `u${++userId}`;
    }
  }
  const state: GateState = {
    context: 'A coding conversation, oldest first. `first` is the opening message; `window` is the recent conversation. Tool outputs are omitted and text may be abridged. User prompts in `window` have choice ids. Secrets and personal data are masked before abridgement.',
    goal: truncate(redact(options.goal ?? '') || goalFromMessages(messages, redact), 1500),
    contextPercent: options.contextPercent ?? 0,
    length: messages.length,
    ...(start > 0 ? { first: window.shift() } : {}),
    window,
  };
  const fits = () => estimateTokens(JSON.stringify(state)) <= config.gateMaxStateTokens;
  while (!fits() && state.window.length > 1) {
    if (!state.first) state.first = state.window[0];
    state.window.shift();
  }
  if (!fits()) throw new Error('Gate state exceeds token budget');
  return state;
}

export function buildGateQuestions(window: readonly GateEntry[]): JevQuestions {
  return {
    boundary: {
      type: 'noul',
      instructions: 'Does the most recent assistant message in `window` close a unit of work by reporting a finished result, a verified outcome, a commit or push, or asking the user what to do next, or does the newest user prompt in `window` switch to a different task? Use `goal` and `first` for context.',
      criteria: {
        true: 'The most recent assistant message reports finished work, a verified outcome, a commit or push, or asks what to do next; or the newest user prompt switches tasks.',
        false: 'Work is mid-sequence: edits are ongoing, debugging continues, a build or test failure is being fixed, or a question was just asked and has not yet been acted on. Asking for missing information needed to finish work does not close it.',
      },
    },
    needsRecent: {
      type: 'noul',
      instructions: 'Will the next turn likely need the full text of tool outputs represented in `window`, given the current work described by `goal`, `first`, and `window`? Judge whether an error is still being fixed, file contents are still being edited, or test output is still being interpreted, even though output text is omitted from this state.',
      criteria: {
        true: 'Recent tool output is active working evidence: an unresolved error, file contents being edited, or test output still being read. Its full text is likely needed next turn.',
        false: 'Recent tool outputs have served their purpose. The work using them is complete or they can be re-run or re-read if needed without interrupting ongoing work.',
      },
    },
    taskStart: {
      type: 'choice',
      instructions: 'Which user prompt identified by `window[].id` began the task currently in progress in `window`, using `goal` and `first` as context? Select its id, select none if that task began before the retained window, or select all_done if the last task is finished and nothing is in progress.',
      criteria: {
        ...Object.fromEntries(window.filter((entry) => entry.id).map((entry) => [entry.id!, `This user prompt began the current task: ${truncate(entry.text, 160)}`])),
        none: 'The current task began before the retained window; no listed user prompt began it.',
        all_done: 'Nothing is in progress; the last task is finished.',
      },
    },
  };
}

export function decideGate(answers: JevResponse['answers'] | undefined, percent: number, state: GateState, options: GateOptions = {}): GateVerdict {
  const config = { ...GATE_DEFAULTS, ...options };
  const scores: GateScores = {};
  let tail: number | undefined;
  if (percent < config.gateFloorPercent && percent < config.hardCeilingPercent) return { compact: false, reason: 'below_floor', tail, scores };
  if (answers) {
    scores.boundary = noulAnswer(answers, 'boundary');
    scores.needsRecent = noulAnswer(answers, 'needsRecent');
    const answer = answers.taskStart;
    if (!answer || !('choice' in answer) || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1 ||
      ![scores.boundary, scores.needsRecent].every((value) => value >= 0 && value <= 1)) throw new Error('Invalid gate answer');
    const entry = state.window.find((entry) => entry.id === answer.choice);
    if (!entry && answer.choice !== 'none' && answer.choice !== 'all_done') throw new Error('Unknown gate choice');
    scores.taskStart = { choice: answer.choice, confidence: answer.confidence };
    if (answer.confidence >= config.cutConfidence) {
      if (entry) tail = clampGateTail(state.length - entry.i, config);
      else if (answer.choice === 'all_done') tail = clampGateTail(resolveOptions(config).preserveRecentMessages, config);
    }
  }
  if (percent >= config.hardCeilingPercent) return { compact: true, reason: 'hard_ceiling', tail, scores };
  if (!answers) return { compact: percent >= (config.compactAtPercent ?? 60), reason: 'jev_unavailable', tail, scores };
  if (scores.needsRecent! > config.needsRecentThreshold) return { compact: false, reason: 'needs_recent', tail, scores };
  const nothingInProgress = scores.taskStart?.choice === 'all_done' && scores.taskStart.confidence >= config.cutConfidence;
  if (scores.boundary! < config.boundaryThreshold && !nothingInProgress) return { compact: false, reason: 'in_progress', tail, scores };
  return { compact: true, reason: nothingInProgress && scores.boundary! < config.boundaryThreshold ? 'all_done' : 'boundary', tail, scores };
}

export async function evaluateGate(messages: readonly Message[], percent: number, options: GateOptions, asker?: JevAsker): Promise<GateVerdict & { model?: string }> {
  const config = { ...GATE_DEFAULTS, ...options };
  const empty: GateState = { context: '', goal: '', contextPercent: percent, length: messages.length, window: [] };
  if (percent < config.gateFloorPercent && percent < config.hardCeilingPercent) return decideGate(undefined, percent, empty, config);
  try {
    if (!asker) throw new Error('Gate asker unavailable');
    const state = buildGateState(messages, { ...config, contextPercent: percent });
    const response = await asker.ask(state, buildGateQuestions(state.window));
    return { ...decideGate(response.answers, percent, state, config), model: response.model };
  } catch {
    return { ...decideGate(undefined, percent, empty, config), reason: 'jev_unavailable' };
  }
}
