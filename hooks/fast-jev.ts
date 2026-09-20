import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, droppableRatio, reductionRatio, resolveOptions } from '../src/compact.js';
import { scanForSecrets, type GitleaksOptions, type ProcessRunner } from '../src/gitleaks.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import { JevNetworkError, withRetry, type RetryOptions } from '../src/retry.js';
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

export type HookConfig = CompactOptions & {
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
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
  };
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
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const asker = withRetry(jevAsker(fetchFn, config.apiKey, config.model), retry);
  const result = await compact(messages, asker, config);
  return { result, messages: toSessionMessages(messages, result.messages) };
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
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
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

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let auto = initialAutoCompactState(configured);
  const gitleaks: GitleaksState = {};
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    try {
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      // Local, free, and no request: if even a perfect run could not reach the
      // minimum, fall back now instead of paying Jev to tell us so.
      const ceiling = droppableRatio(event.messages, config);
      if (ceiling < config.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (at most ${percent(ceiling)} removable, below the ${percent(
            config.minReductionRatio,
          )} minimum; Jev not called)`,
        );
        return next(event);
      }
      // Wrapped rather than passed: the engine's nouns are only ever called
      // in place, never handed around as values.
      const scanned = await withScannedSecrets(
        event.messages,
        config,
        (argv, init) => $.process.run(argv, init),
        gitleaks,
      );
      if (scanned.note) $.ui.log(scanned.note);
      const { result, messages } = await compactSession(event.messages, scanned.config, async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      }, { sleep: (ms) => $.clock.sleep(ms, { signal: next.signal }) });
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages };
    } catch (error) {
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    auto = { ...auto, turnsSinceCompaction: auto.turnsSinceCompaction + 1 };
    try {
      const before = (await $.session.usage()).context.percent ?? 0;
      const verdict = shouldAutoCompact(auto, before, configured);
      if (!verdict.compact) {
        if (verdict.reason) $.ui.log(verdict.reason);
        return next(event);
      }
      compacting = true;
      await $.session.compact();
      const after = (await $.session.usage()).context.percent ?? before;
      const previous = auto;
      auto = noteCompaction(auto, before, after, configured);
      if (auto.trigger !== previous.trigger) {
        $.ui.log(
          `auto-compaction trigger raised to ${auto.trigger}% (${before}% → ${after}%, under the ${configured.minPercentDrop}-point minimum)`,
        );
      }
      if (auto.disabledReason && !previous.disabledReason) {
        notify($, `auto-compaction disabled for this session: ${auto.disabledReason}`);
      }
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
