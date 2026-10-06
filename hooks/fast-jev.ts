import type {
  On,
  CoreEngineInterface,
  PluginOptions,
  Register,
  SessionMessage,
  SessionCompactResult,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, droppableRatio, reductionRatio, resolveOptions } from '../src/compact.js';
import { GATE_DEFAULTS, clampGateTail, evaluateGate, type GateConfig } from '../src/gate.js';
import { scanForSecrets, type GitleaksOptions, type ProcessRunner } from '../src/gitleaks.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import { JevNetworkError, withRetry, type RetryOptions } from '../src/retry.js';
import { buildCompactionEvent, eventReason, gateEvent, type GateEvent, type CompactionEvent, type EventInput, type ReasonCode } from '../src/events.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  /** Turns to let pass after a compaction before auto-compacting again. */
  cooldownTurns: 3,
  /**
   * Context points a compaction must win back for auto-compaction to stay at
   * the same trigger. Below it, the trigger is raised above the level that did
   * not pay off, so the next attempt only comes when the context has really
   * grown. This is what stops a session from compacting every single turn.
   */
  minPercentDrop: 5,
  /** Hard stop on auto-compactions in one session. */
  maxAutoCompactions: 8,
  model: DEFAULT_MODEL,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & GateConfig & {
  apiKey?: string;
  /**
   * Scan the state with gitleaks before sending it. On by default and skipped
   * when the binary is not installed; set it to false to never try.
   */
  gitleaks: boolean;
  gitleaksBinary?: string;
  gitleaksConfig?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  cooldownTurns: number;
  minPercentDrop: number;
  maxAutoCompactions: number;
  model: string;
  events: boolean;
  eventsDir?: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Record<string, number> = {};
  for (const key of [
    'keepThreshold',
    'keepResultThreshold',
    'keepCallThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...GATE_DEFAULTS,
    ...(numbers as Partial<CompactOptions>),
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    cooldownTurns: Math.max(
      0,
      optionNumber(options, 'cooldownTurns', HOOK_DEFAULTS.cooldownTurns),
    ),
    minPercentDrop: Math.max(
      0,
      optionNumber(options, 'minPercentDrop', HOOK_DEFAULTS.minPercentDrop),
    ),
    maxAutoCompactions: Math.max(
      0,
      optionNumber(options, 'maxAutoCompactions', HOOK_DEFAULTS.maxAutoCompactions),
    ),
    gitleaks: options['gitleaks'] !== false,
    events: options['events'] !== false,
    ...(optionString(options, 'eventsDir') ? { eventsDir: optionString(options, 'eventsDir') } : {}),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
  };
  config.gate = options['gate'] !== false;
  for (const key of ['gateFloorPercent', 'hardCeilingPercent', 'boundaryThreshold', 'needsRecentThreshold', 'cutConfidence', 'gateWindowMessages', 'gateMaxTail', 'gateMaxStateTokens'] as const) {
    config[key] = optionNumber(options, key, GATE_DEFAULTS[key]);
  }
  const gitleaksBinary = optionString(options, 'gitleaksBinary');
  if (gitleaksBinary) config.gitleaksBinary = gitleaksBinary;
  const gitleaksConfig = optionString(options, 'gitleaksConfig');
  if (gitleaksConfig) config.gitleaksConfig = gitleaksConfig;
  const redact = optionString(options, 'redact');
  if (redact === 'off' || redact === 'standard' || redact === 'strict') config.redact = redact;
  const sideEffectTools = optionString(options, 'sideEffectTools');
  if (sideEffectTools) {
    config.sideEffectTools = sideEffectTools
      .split(',')
      .map((tool) => tool.trim())
      .filter(Boolean);
  }
  if (typeof options['protectErrors'] === 'boolean') {
    config.protectErrors = options['protectErrors'];
  }
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      let response: HookFetchResponse;
      try {
        response = await fetchFn(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new JevNetworkError(error);
      }
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/**
 * Remembers, for the session, that the binary is not there. A missing gitleaks
 * will not appear between two compactions, so asking again every time would
 * only cost a failed spawn and repeat the same line in the log.
 */
export interface GitleaksState {
  available?: boolean;
  warned?: boolean;
}

/**
 * Asks gitleaks for the secrets in what is about to be sent, so the redactor
 * can mask values no pattern of ours would recognise. Enabled by default and
 * never required: with no binary installed the built-in rules still run, the
 * reason is logged once, and later compactions do not try again.
 */
export async function withScannedSecrets(
  messages: readonly SessionMessage[],
  config: HookConfig,
  run: ProcessRunner | undefined,
  state: GitleaksState = {},
): Promise<{ config: HookConfig; note?: string }> {
  if (!config.gitleaks || !run || state.available === false) return { config };
  const options: GitleaksOptions = {};
  if (config.gitleaksBinary) options.binary = config.gitleaksBinary;
  if (config.gitleaksConfig) options.config = config.gitleaksConfig;
  const scan = await scanForSecrets(messages, run, options);
  if (scan.unavailable) {
    state.available = false;
    // Said once, then never again for this session.
    if (state.warned) return { config };
    state.warned = true;
    return { config, note: scan.skipped };
  }
  state.available = true;
  if (scan.skipped) return { config, note: scan.skipped };
  if (scan.secrets.length === 0) return { config };
  return {
    config: {
      ...config,
      redactLiterals: [...(config.redactLiterals ?? []), ...scan.secrets],
    },
    note: `gitleaks masked ${scan.secrets.length} secret(s)`,
  };
}

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
  retry: RetryOptions = { sleep: async () => {} },
  metrics?: { requests: number; retries: number },
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const asker = withRetry(jevAsker(fetchFn, config.apiKey, config.model), retry);
  try {
    const result = await compact(messages, asker, config);
    return { result, messages: toSessionMessages(messages, result.messages) };
  } finally {
    if (metrics) Object.assign(metrics, asker.stats);
  }
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** `3 email, 1 secret`, or '' when nothing was masked. */
export function redactionSummary(result: CompactResult): string {
  return Object.entries(result.stats.redactions)
    .map(([name, n]) => `${n} ${name}`)
    .join(', ');
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const masked = redactionSummary(result);
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.protected > 0 ? `${stats.protected} protected` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)${
    masked ? `; masked ${masked}` : ''
  }`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
  silent = false,
): void {
  $.ui.log(text);
  if (!silent) $.ui.toast(text, { timeoutMs: 15_000 });
}

/**
 * Everything that keeps auto-compaction from firing turn after turn. Held per
 * session in the closure: a cooldown, a trigger that climbs when a compaction
 * did not win context back, and a hard cap.
 */
export interface AutoCompactState {
  turnsSinceCompaction: number;
  compactions: number;
  /** Trigger in force, raised above a context level that did not pay off. */
  trigger: number;
  /** Context percent right after the last compaction, or undefined. */
  lastPercentAfter?: number;
  /** Set once the guards give up on this session. */
  disabledReason?: string;
}

export function initialAutoCompactState(config: HookConfig): AutoCompactState {
  return { turnsSinceCompaction: Number.POSITIVE_INFINITY, compactions: 0, trigger: config.compactAtPercent };
}

export type AutoCompactVerdict =
  | { compact: true }
  | { compact: false; reason?: string };

/** Decides whether this turn should ask for a compaction. Pure, so it is testable. */
export function shouldAutoCompact(
  state: AutoCompactState,
  percent: number,
  config: HookConfig,
): AutoCompactVerdict {
  if (state.disabledReason) return { compact: false };
  if (state.compactions >= config.maxAutoCompactions) {
    return {
      compact: false,
      reason: `auto-compaction off for this session (${config.maxAutoCompactions} compactions already)`,
    };
  }
  if (state.turnsSinceCompaction < config.cooldownTurns) return { compact: false };
  if (percent < state.trigger) return { compact: false };
  return { compact: true };
}

/**
 * Records what a compaction actually won back. A compaction that did not free
 * `minPercentDrop` points pushes the trigger above where the context now sits,
 * so the next one waits for real growth instead of firing on the next turn.
 */
export function noteCompaction(
  state: AutoCompactState,
  percentBefore: number,
  percentAfter: number,
  config: HookConfig,
): AutoCompactState {
  const next: AutoCompactState = {
    ...state,
    compactions: state.compactions + 1,
    turnsSinceCompaction: 0,
    lastPercentAfter: percentAfter,
  };
  if (percentBefore - percentAfter < config.minPercentDrop) {
    next.trigger = Math.min(95, Math.max(state.trigger, percentAfter + config.minPercentDrop));
    if (next.trigger >= 95) {
      next.disabledReason = 'compaction stopped freeing context';
    }
  }
  return next;
}

type EventState = {
  configured: HookConfig;
  lastEventMs: number;
  pluginEvent: CompactionEvent | undefined;
};

async function now($: CoreEngineInterface) {
  try { return await $.clock.now(); } catch { return 0; }
}

async function usage($: CoreEngineInterface) {
  try { return (await $.session.usage()).context.percent ?? undefined; } catch { return undefined; }
}

async function persist($: CoreEngineInterface, state: EventState, input: Omit<EventInput, 'ts' | 'sessionId'> | CompactionEvent, suffix?: string) {
  const { configured } = state;
  if (!configured.events) return;
  try {
    // Reserve a distinct millisecond even when two dispatches finish together.
    state.lastEventMs = Math.max(await $.clock.now(), state.lastEventMs + 1);
    const ts = new Date(state.lastEventMs).toISOString();
    const sessionId = await $.session.id();
    const record = 'v' in input ? { ...input, ts, sessionId } : buildCompactionEvent({ ...input, ts, sessionId });
    if (!suffix && record.trigger === 'plugin') state.pluginEvent = record;
    const home = configured.eventsDir ? undefined : await $.env.get('HOME');
    const dir = configured.eventsDir ?? (home ? `${home}/.claude/cache/fast-jev-compaction/events` : undefined);
    if (!dir) throw new Error('HOME unavailable');
    const stamp = ts.replace(/[-:.]/g, '');
    const session8 = sessionId.slice(0, 8).replace(/[^a-zA-Z0-9_-]/g, '_');
    await $.fs.write(`${dir}/${stamp}-${session8}-${suffix ?? record.trigger}.json`, JSON.stringify(record));
  } catch {
    $.ui.log('fast-jev-compaction: event write failed');
  }
}

type PendingGate = { tail?: number; lengthAtDecision: number; gate?: GateEvent };
type HookState = {
  auto: AutoCompactState;
  compacting: boolean;
  pending?: PendingGate;
  gitleaks: GitleaksState;
  events: EventState;
};

async function autoCompact($: CoreEngineInterface, state: HookState): Promise<void> {
  const configured = state.events.configured;
  let before: number | undefined;
  let after: number | undefined;
  let started = 0;
  let attempted = false;
  let evaluated = false;
  let failure: unknown;
  let gate: GateEvent | undefined;
  let messages: SessionMessage[] = [];
  try {
    before = await usage($);
    if (before === undefined) return;
    const guard = shouldAutoCompact(state.auto, before, configured);
    if (!guard.compact) {
      if (guard.reason) $.ui.log(guard.reason);
      return;
    }
    evaluated = true;
    started = await now($);
    state.events.pluginEvent = undefined;
    let tail: number | undefined;
    if (configured.gate) {
      let verdict;
      try {
        messages = await $.session.messages();
        const config = { ...configured, apiKey: await getApiKey($, configured) };
        const scanned = await withScannedSecrets(messages, config, (argv, init) => $.process.run(argv, init), state.gitleaks);
        if (scanned.note) $.ui.log(scanned.note);
        verdict = await evaluateGate(messages, before, scanned.config, config.apiKey ? jevAsker(async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        }, config.apiKey, config.model) : undefined);
      } catch {
        verdict = await evaluateGate(messages, before, configured);
      }
      gate = gateEvent({ ...verdict.scores, tail: verdict.tail, reason: verdict.reason,
        model: verdict.model ?? configured.model, ms: Math.max(0, await now($) - started) });
      tail = verdict.tail;
      if (verdict.reason === 'jev_unavailable') {
        $.ui.log('auto-compaction gate unavailable; using numeric fallback');
        const fallback = shouldAutoCompact({ ...state.auto, trigger: Math.max(state.auto.trigger, configured.compactAtPercent) }, before, configured);
        if (!fallback.compact && before < configured.hardCeilingPercent) return;
      } else if (!verdict.compact) return;
    }
    state.pending = { tail, lengthAtDecision: messages.length, gate };
    attempted = true;
    await $.command.run({ command: 'compact' });
    const recorded = state.events.pluginEvent as CompactionEvent | undefined;
    after = recorded?.outcome === 'skipped' ? before : await usage($) ?? before;
    const previous = state.auto;
    state.auto = noteCompaction(state.auto, before, after, configured);
    if (state.auto.trigger !== previous.trigger) {
      $.ui.log(`auto-compaction trigger raised to ${state.auto.trigger}% (${before}% → ${after}%, under the ${configured.minPercentDrop}-point minimum)`);
    }
    if (state.auto.disabledReason && !previous.disabledReason) {
      notify($, `auto-compaction disabled for this session: ${state.auto.disabledReason}`, true);
    }
  } catch (error) {
    failure = error;
    if (attempted && before !== undefined) state.auto = noteCompaction(state.auto, before, before, configured);
    $.ui.log('auto-compact skipped (compaction failed)');
  } finally {
    try {
      if (evaluated) {
        const totalMs = Math.max(0, await now($) - started);
        const base = state.events.pluginEvent ?? buildCompactionEvent({ ts: '', sessionId: '', trigger: 'plugin', model: configured.model,
          outcome: attempted && !failure ? 'fallback' : 'skipped', reasonCode: failure ? 'error' : attempted ? 'ok' : 'gate_wait',
          ceilingRatio: 0, minReductionRatio: configured.minReductionRatio, options: configured, messages, totalMs });
        await persist($, state.events, { ...base, ...(failure ? { outcome: 'skipped' as const, reasonCode: 'error' as const, reason: eventReason('error') } : {}),
          ...(gate ? { gate } : {}), contextPercentBefore: before, contextPercentAfter: after ?? before, totalMs,
          auto: { trigger: state.auto.trigger, compactions: state.auto.compactions, ...(state.auto.disabledReason ? { disabledReason: state.auto.disabledReason } : {}) } }, 'auto');
      }
    } finally {
      state.pending = undefined;
      state.compacting = false;
    }
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  const gitleaks: GitleaksState = {};
  const eventState: EventState = { configured, lastEventMs: 0, pluginEvent: undefined };
  const state: HookState = { auto: { ...initialAutoCompactState(configured), trigger: configured.gate ? configured.gateFloorPercent : configured.compactAtPercent },
    compacting: false, gitleaks, events: eventState };

  on('session.compact', async ($, event, next) => {
    const pending = event.trigger === 'manual' ? state.pending : undefined;
    if (pending) state.pending = undefined;
    const plugin = event.trigger === 'plugin' || pending !== undefined;
    const runConfig = pending?.tail === undefined ? configured : { ...configured,
      preserveRecentMessages: clampGateTail(pending.tail + event.messages.length - pending.lengthAtDecision, configured) };
    const started = await now($);
    const contextPercentBefore = await usage($);
    const metrics = { requests: 0, retries: 0, ms: 0 };
    let ceiling = 0;
    let result: CompactResult | undefined;
    let reasonCode: ReasonCode = 'error';
    let failure: unknown;
    let outcome: CompactionEvent['outcome'] = plugin ? 'skipped' : 'fallback';
    const finish = (result: SessionCompactResult) => {
      if (result.messages && event.trigger !== 'precompute') state.auto.turnsSinceCompaction = 0;
      return result;
    };
    const fallbackLabel = plugin ? 'compaction skipped' : 'fallback to built-in summary';
    try {
      try {
        ceiling = droppableRatio(event.messages, runConfig);
        if (ceiling < configured.minReductionRatio) reasonCode = 'ceiling_below_min';
        else {
          const config = { ...runConfig, apiKey: await getApiKey($, runConfig) };
          if (!config.apiKey) reasonCode = 'no_api_key';
          else {
            const scanned = await withScannedSecrets(event.messages, config,
              (argv, init) => $.process.run(argv, init), gitleaks);
            if (scanned.note) $.ui.log(scanned.note);
            const jevStarted = await now($);
            try {
              const compacted = await compactSession(event.messages, scanned.config, async (url, init) => {
                const response = await $.http.fetch(url, init);
                return { status: response.status, ok: response.ok, text: response.text };
              }, { sleep: (ms) => $.clock.sleep(ms, { signal: next.signal }) }, metrics);
              result = compacted.result;
              reasonCode = reductionRatio(result) < config.minReductionRatio ? 'reduction_below_min' : 'ok';
              for (const line of decisionLogLines(result)) $.ui.log(line);
              if (reasonCode === 'ok') {
                outcome = 'jev';
                notify($, `kept ${compacted.messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`, event.trigger === 'precompute' || plugin);
                return finish({ messages: compacted.messages });
              }
            } catch (error) {
              reasonCode = 'jev_error';
              failure = error;
            } finally {
              metrics.ms = Math.max(0, await now($) - jevStarted);
            }
          }
        }
      } catch (error) {
        reasonCode = 'error';
        failure = error;
      }
      // A plugin-triggered skip is something nobody asked for: log it, do not toast.
      notify($, `${fallbackLabel} (${eventReason(reasonCode, failure)}${result ? `; ${summarize(result)}` : ''})`,
        event.trigger === 'precompute' || plugin);
      if (plugin) return { skip: reasonCode };
      // Delegate once, outside the Jev catch: a core failure is not a Jev retry.
      try {
        const fallback = await next(event);
        if (fallback.skip !== undefined) outcome = 'skipped';
        return finish(fallback);
      } catch (error) {
        reasonCode = 'error';
        failure = error;
        throw error;
      }
    } finally {
      if (state.pending === pending) state.pending = undefined;
      const record = buildCompactionEvent({ ts: '', sessionId: '', trigger: plugin ? 'plugin' : event.trigger, agentId: event.agentId, model: configured.model,
        outcome, reasonCode, error: failure, ceilingRatio: ceiling,
        minReductionRatio: configured.minReductionRatio, options: runConfig, messages: event.messages, gate: pending?.gate,
        result, contextPercentBefore, jev: metrics, totalMs: Math.max(0, await now($) - started) });
      if (plugin) eventState.pluginEvent = record;
      await persist($, eventState, record);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    const result = await next(event);
    if (state.compacting || event.agentId) return result;
    state.auto = { ...state.auto, turnsSinceCompaction: state.auto.turnsSinceCompaction + 1 };
    state.compacting = true;
    void autoCompact($, state);
    return result;
  });
};

export { resolveOptions };
