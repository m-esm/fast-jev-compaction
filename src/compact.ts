import { createRedactor, type Redactor } from './redact.js';
import { noulAnswer } from './request.js';
import {
  DEFAULT_ASSUMED_IMAGE_CHARS,
  DEFAULT_HIDDEN_CHARS_OPTIONS,
  DEFAULT_IMAGE_TOOLS,
  IMAGE_DROP_MARK,
  IMAGE_DROP_NOTE,
  IMAGE_SIBLING_NOTE,
  hiddenChars,
  type HiddenCharsOptions,
} from './payload.js';
import { collectToolCalls, estimateTokens, fitState } from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CallReason,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolResult,
  ToolUse,
} from './types.js';

/**
 * Tools whose call is never removed outright, only truncated. Their input is
 * the only record that a side effect happened, and no amount of re-running
 * brings back what a command did or what an edit replaced.
 */
export const DEFAULT_SIDE_EFFECT_TOOLS: readonly string[] = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Task',
  'Agent',
  'SlashCommand',
  'ExitPlanMode',
];

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  // Asymmetric on purpose: truncating a result is recoverable by re-running
  // the tool, removing the call is not.
  keepResultThreshold: 0.4,
  keepCallThreshold: 0.15,
  sideEffectTools: DEFAULT_SIDE_EFFECT_TOOLS,
  protectErrors: true,
  redact: 'standard',
  redactRules: [],
  redactLiterals: [],
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  // Matched by name only, and the weight is an assumption: see `hiddenChars`.
  imageTools: DEFAULT_IMAGE_TOOLS,
  assumedImageChars: DEFAULT_ASSUMED_IMAGE_CHARS,
};

/** A tool whose calls the safety rules refuse to remove entirely. */
export function isSideEffectTool(
  tool: string,
  sideEffectTools: readonly string[] = DEFAULT_SIDE_EFFECT_TOOLS,
): boolean {
  // An MCP tool is a black box: assume it touched something.
  return tool.startsWith('mcp__') || sideEffectTools.includes(tool);
}

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  // `keepThreshold` is the legacy single knob; the split thresholds win over it.
  const both = typeof options.keepThreshold === 'number' && Number.isFinite(options.keepThreshold)
    ? options.keepThreshold
    : undefined;
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepResultThreshold: finite(
      options.keepResultThreshold ?? both,
      DEFAULT_OPTIONS.keepResultThreshold,
    ),
    keepCallThreshold: finite(
      options.keepCallThreshold ?? both,
      DEFAULT_OPTIONS.keepCallThreshold,
    ),
    sideEffectTools: options.sideEffectTools ?? DEFAULT_OPTIONS.sideEffectTools,
    protectErrors: options.protectErrors ?? DEFAULT_OPTIONS.protectErrors,
    redact: options.redact ?? DEFAULT_OPTIONS.redact,
    redactRules: options.redactRules ?? DEFAULT_OPTIONS.redactRules,
    redactLiterals: options.redactLiterals ?? DEFAULT_OPTIONS.redactLiterals,
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    imageTools: (options.imageTools ?? DEFAULT_OPTIONS.imageTools)
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0),
    assumedImageChars: Math.max(
      0,
      Math.floor(finite(options.assumedImageChars, DEFAULT_OPTIONS.assumedImageChars)),
    ),
  };
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Decides what happens to one call: keep it, truncate its result, or remove it
 * with its result. The destructive step needs a far lower probability than the
 * recoverable one, and a call is removed only when Jev is confident it is dead
 * weight *and* the tool left nothing behind that removing it would erase.
 */
export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'> & Partial<Pick<ToolCall, 'isError'>>,
  answer: CallAnswer,
  options: CompactOptions = {},
): CallDecision {
  const resolved = resolveOptions(options);
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep' as const, reason: 'pinned' as CallReason };
  if (answer.keepResult >= resolved.keepResultThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= resolved.keepCallThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  const protectedCall =
    isSideEffectTool(call.tool, resolved.sideEffectTools) ||
    (resolved.protectErrors && call.isError === true);
  if (protectedCall) return { ...base, action: 'drop_result', reason: 'protected' };
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

function removedPayloadText(text: string, payloadChars: number): string {
  return `${text}\n[fast-jev-compaction removed a ~${Math.ceil(payloadChars / 1024)} KB binary payload (image) from this tool result; re-run the tool if needed]`;
}

type HiddenWeight = Pick<ToolCall, 'payloadChars' | 'assumedChars'>;

function hasHiddenChars(call: HiddenWeight | undefined): boolean {
  return call !== undefined && (call.payloadChars > 0 || call.assumedChars > 0);
}

/**
 * The text a dropped result is left with: the normal truncation, then a note
 * for whatever goes with the rebuild (a measured payload, or an assumed image).
 * A note an earlier compaction left is set aside first and put back, so
 * truncating again never cuts the mark off and a second pass changes nothing.
 */
function droppedResultText(
  text: string,
  isError: boolean,
  headChars: number,
  call: HiddenWeight | undefined,
): string {
  const at = text.indexOf(IMAGE_DROP_MARK);
  const body = at < 0 ? text : text.slice(0, at).replace(/\n$/, '');
  const truncated = truncatedResultText(body, isError, headChars);
  const kept = at < 0 ? truncated : `${truncated}\n${text.slice(at)}`;
  if (call && call.payloadChars > 0) return removedPayloadText(kept, call.payloadChars);
  // `assumedChars` is read off the result side; the mirrored text may be marked already.
  if (call && call.assumedChars > 0 && at < 0) return `${kept}\n${IMAGE_DROP_NOTE}`;
  return kept;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as. A result with a measured
 * payload or an assumed image is always rebuilt when dropped, on both sides
 * of its pair, because only a rebuilt message loses the image. A kept result
 * that shares a rebuilt message loses its image with it and is told so.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const byUseId = new Map(calls.map((call) => [call.tool_use_id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const copyUse = (tool: ToolUse, text: string): ToolUse => {
    const copy: ToolUse = {
      tool_use_id: tool.tool_use_id,
      tool: tool.tool,
      input: tool.input,
      text,
    };
    if (tool.isError) copy.isError = true;
    return copy;
  };
  const copyResult = (result: ToolResult, text: string): ToolResult => ({
    tool_use_id: result.tool_use_id,
    text,
    isError: result.isError,
  });
  /** What the decisions alone make of one message, or undefined when it stands as it came. */
  const rewrite = (
    message: Message,
  ): { toolUses: ToolUse[]; toolResults: ToolResult[] } | undefined => {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) return undefined;
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const call = byUseId.get(tool.tool_use_id);
        const text = droppedResultText(tool.text ?? '', tool.isError ?? false, headChars, call);
        // A payload or an assumed image forces the rebuild: only a message
        // without its handle loses the image.
        return !hasHiddenChars(call) && (tool.text ?? '') === text ? tool : copyUse(tool, text);
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const call = byUseId.get(result.tool_use_id);
        const text = droppedResultText(result.text, result.isError ?? false, headChars, call);
        return !hasHiddenChars(call) && text === result.text ? result : copyResult(result, text);
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      return undefined;
    }
    return { toolUses, toolResults };
  };
  const rewrites = messages.map(rewrite);
  // A rebuilt message loses every image in it, the ones of kept results too.
  // The image lives with the result, so that side decides what was lost.
  const lost = new Set<string>();
  rewrites.forEach((rewritten) => {
    for (const result of rewritten?.toolResults ?? []) {
      if (actions.has(result.tool_use_id) || result.text.includes(IMAGE_DROP_MARK)) continue;
      if (hasHiddenChars(byUseId.get(result.tool_use_id))) lost.add(result.tool_use_id);
    }
  });
  const kept: Message[] = [];
  for (const [index, message] of messages.entries()) {
    const rewritten = rewrites[index];
    if (!rewritten) {
      kept.push(message);
      continue;
    }
    // Both sides of the pair say so, wherever the side is being rebuilt anyway.
    const toolUses = rewritten.toolUses.map((tool) =>
      lost.has(tool.tool_use_id) && !(tool.text ?? '').includes(IMAGE_DROP_MARK)
        ? copyUse(tool, `${tool.text ?? ''}\n${IMAGE_SIBLING_NOTE}`)
        : tool,
    );
    const toolResults = rewritten.toolResults.map((result) =>
      lost.has(result.tool_use_id)
        ? copyResult(result, `${result.text}\n${IMAGE_SIBLING_NOTE}`)
        : result,
    );
    const dropped = message.toolUses.filter((tool) => actions.get(tool.tool_use_id) === 'drop_call');
    const counts = new Map<string, number>();
    for (const tool of dropped) counts.set(tool.tool, (counts.get(tool.tool) ?? 0) + 1);
    const marker = dropped.length === 0 ? '' :
      `[fast-jev-compaction removed ${dropped.length} tool call(s) and their results here: ${
        [...counts].map(([tool, n]) => `${tool} x${n}`).join(', ')
      }; re-run them if needed]`;
    const text = marker ? [message.text, marker].filter(Boolean).join('\n') : message.text;
    if (text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Tool name per `tool_use_id`: a tool result does not carry the name of its tool. */
function toolNames(messages: readonly Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const tool of message.toolUses) names.set(tool.tool_use_id, tool.tool);
  }
  return names;
}

/**
 * Characters of text, tool input and tool output a message holds, plus what
 * `hiddenChars` says its tool results weigh beyond their text. `payloads`
 * carries what was already charged per `tool_use_id`, and `tools` names the
 * tool behind a result held by another message; both default to this message
 * alone. An assumed image is charged where it lives, on the result.
 */
export function messageChars(
  message: Message,
  payloads = new Map<string, number>(),
  hidden: HiddenCharsOptions = DEFAULT_HIDDEN_CHARS_OPTIONS,
  tools: ReadonlyMap<string, string> = toolNames([message]),
): number {
  let total = message.text.length + hiddenChars({ tool: '', result: message.result }, hidden).binary;
  const countHidden = (id: string, result: unknown, modelText: string, onResult: boolean) => {
    const weight = hiddenChars({ tool: tools.get(id) ?? '', result, text: modelText }, hidden);
    const counted = payloads.get(id) ?? 0;
    // Same rule as `collectToolCalls`: a measured payload wins over the assumption.
    const size = weight.binary > 0 ? weight.binary : onResult && counted === 0 ? weight.assumed : 0;
    payloads.set(id, Math.max(counted, size));
    return Math.max(0, size - counted);
  };
  for (const tool of message.toolUses) {
    total += countHidden(tool.tool_use_id, tool.result, tool.text ?? '', false);
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) {
    total += result.text.length + countHidden(result.tool_use_id, result.result, result.text, true);
  }
  return total;
}

/** Stored results appear on both sides of a tool pair; charge their payload once. */
export function transcriptChars(
  messages: readonly Message[],
  hidden: HiddenCharsOptions = DEFAULT_HIDDEN_CHARS_OPTIONS,
): number {
  const payloads = new Map<string, number>();
  const tools = toolNames(messages);
  return messages.reduce((sum, message) => sum + messageChars(message, payloads, hidden, tools), 0);
}

/**
 * The best reduction this transcript could possibly reach, if Jev dropped
 * every candidate. Cheap, local, and no request: a caller can use it to decide
 * that a compaction is not worth asking for at all.
 */
export function droppableRatio(
  messages: readonly Message[],
  options: CompactOptions = {},
): number {
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages, resolved);
  const total = transcriptChars(messages, resolved);
  if (total === 0) return 0;
  const byResultId = new Map<string, number>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      byResultId.set(result.tool_use_id, result.text.length);
    }
  }
  let droppable = 0;
  for (const call of calls) {
    if (call.pinned) continue;
    const resultChars = byResultId.get(call.tool_use_id) ?? call.resultChars;
    droppable +=
      Math.max(0, resultChars - resolved.truncateHeadChars) + call.payloadChars + call.assumedChars;
  }
  return droppable / total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must
 * stay. The whole history (results omitted, fitted into `maxStateTokens`) is
 * sent as state with every batch of questions. Throws when Jev fails or the
 * history cannot be fitted; the caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages, resolved);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = transcriptChars(messages, resolved);

  const redactor: Redactor = createRedactor({
    level: resolved.redact,
    extraRules: resolved.redactRules,
    literals: resolved.redactLiterals,
  });

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let batches: ToolCall[][] = [];
  const answers = new Map<string, CallAnswer>();
  if (candidates.length > 0) {
    const state = fitState(messages, calls, resolved, redactor);
    fitted = state;
    batches = batchCalls(candidates, state.tokens, resolved);
    const settled = await Promise.allSettled(
      batches.map((batch) => askBatch(asker, state.state, batch)),
    );
    // Let every batch finish before recording a failure and its request counts.
    for (const batch of settled) {
      if (batch.status === 'rejected') throw batch.reason;
      for (const [id, answer] of batch.value) answers.set(id, answer);
    }
  }

  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  const kept = applyDecisions(
    messages,
    decisions,
    calls,
    resolved.truncateHeadChars,
  );
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: transcriptChars(kept, resolved),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      protected: count(decisions, 'protected'),
      pinned: count(decisions, 'pinned'),
      redactions: redactor.counts,
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length,
      ms: Date.now() - started,
    },
  };
}
