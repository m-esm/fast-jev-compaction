import { describe, expect, it, vi } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  initialAutoCompactState,
  noteCompaction,
  register,
  resolveHookConfig,
  shouldAutoCompact,
  summarize,
  toSessionMessages,
} from '../hooks/fast-jev.ts';
import { applyDecisions, collectToolCalls, decideCall, type Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

function fakeEngine(options: Record<string, unknown> = {}) {
  const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
  register(((name: string, handler: any) => { handlers[name] = handler; }) as any, {
    apiKey: 'fake', gitleaks: false, preserveRecentMessages: 1, ...options,
  });
  const $ = {
    env: { get: vi.fn(async (name: string) => name === 'HOME' ? '/fake-home' : undefined) },
    settings: { read: vi.fn(async () => ({})) },
    clock: { now: vi.fn(async () => 1789910000000), sleep: vi.fn(async () => {}) },
    fs: { write: vi.fn(async () => {}) },
    http: { fetch: vi.fn(jevFetch(() => 0)) },
    ui: { log: vi.fn(), toast: vi.fn() },
    session: {
      id: vi.fn(async () => '12345678-session'),
      usage: vi.fn(async () => ({ context: { percent: 80 } })),
      compact: vi.fn(async () => ({ messages: [] })),
    },
  };
  const next = vi.fn(async () => ({ messages: [] }));
  return { $, next, dispatch: (trigger: string, messages = transcript()) => handlers['session.compact']!($, { trigger, messages }, next),
    turn: () => handlers['turn.complete']!($, {}, vi.fn(async () => ({}))) };
}

describe('registered hook cooldown', () => {
  it.each(['manual', 'auto', 'plugin'])('resets after %s returns Jev messages', async (trigger) => {
    const engine = fakeEngine();
    await engine.dispatch(trigger);
    await engine.turn();
    await engine.turn();
    expect(engine.$.session.compact).not.toHaveBeenCalled();
    await engine.turn();
    expect(engine.$.session.compact).toHaveBeenCalledTimes(1);
  });

  it.each(['manual', 'auto'])('resets after %s built-in fallback returns messages', async (trigger) => {
    const engine = fakeEngine();
    await engine.dispatch(trigger, [message('user', 'nothing to prune')]);
    await engine.turn();
    expect(engine.$.session.compact).not.toHaveBeenCalled();
  });

  it('does not reset for precompute', async () => {
    const engine = fakeEngine();
    await engine.dispatch('precompute');
    await engine.turn();
    expect(engine.$.session.compact).toHaveBeenCalledTimes(1);
  });
});

describe('registered fallback triggers', () => {
  for (const trigger of ['manual', 'auto', 'plugin']) {
    it.each(['ceiling_below_min', 'reduction_below_min', 'no_api_key', 'jev_error'])(`${trigger}: %s`, async (reason) => {
      const engine = fakeEngine(reason === 'no_api_key' ? { apiKey: '' } : {});
      if (reason === 'reduction_below_min') engine.$.http.fetch.mockImplementation(jevFetch(() => 1));
      if (reason === 'jev_error') engine.$.http.fetch.mockRejectedValue(new Error('offline'));
      const out = await engine.dispatch(trigger, reason === 'ceiling_below_min' ? [message('user', 'text')] : transcript());
      if (trigger === 'plugin') {
        expect(out).toEqual({ skip: reason });
        expect(engine.next).not.toHaveBeenCalled();
      } else {
        expect(out).toEqual({ messages: [] });
        expect(engine.next).toHaveBeenCalledTimes(1);
      }
    });
  }

  it('feeds skipped plugin compactions into cooldown and trigger escalation', async () => {
    const engine = fakeEngine({ cooldownTurns: 0 });
    engine.$.session.compact.mockImplementation(async () => engine.dispatch('plugin', [message('user', 'text')]));
    await engine.turn();
    await engine.turn();
    expect(engine.$.session.compact).toHaveBeenCalledTimes(1);
    expect(engine.$.ui.log.mock.calls.flat().join(' ')).toContain('trigger raised to 85%');
  });
});

it.each(['success', 'ceiling', 'reduction', 'key', 'error'])('keeps precompute silent on %s', async (path) => {
  const engine = fakeEngine(path === 'key' ? { apiKey: '' } : {});
  if (path === 'reduction') engine.$.http.fetch.mockImplementation(jevFetch(() => 1));
  if (path === 'error') engine.$.http.fetch.mockRejectedValue(new Error('offline'));
  await engine.dispatch('precompute', path === 'ceiling' ? [message('user', 'text')] : transcript());
  expect(engine.$.ui.toast).not.toHaveBeenCalled();
  expect(engine.$.ui.log).toHaveBeenCalled();
  expect(engine.next).toHaveBeenCalledTimes(path === 'success' ? 0 : 1);
});

describe('persisted hook events', () => {
  it.each(['manual', 'auto', 'plugin', 'precompute'])('writes exactly one %s dispatch event', async (trigger) => {
    const engine = fakeEngine();
    await engine.dispatch(trigger);
    expect(engine.$.fs.write).toHaveBeenCalledTimes(1);
    const [path, body] = engine.$.fs.write.mock.calls[0] as unknown as [string, string];
    expect(path).toMatch(new RegExp(`^/fake-home/.claude/cache/fast-jev-compaction/events/\\d{8}T\\d{9}Z-12345678-${trigger}\\.json$`));
    expect(JSON.parse(body)).toMatchObject({ v: 1, trigger, outcome: 'jev', reasonCode: 'ok', contextPercentBefore: 80, jev: { requests: 1, retries: 0, ms: 0 } });
  });

  it.each(['success', 'ceiling', 'reduction', 'key', 'error'])('never persists sentinel contents on %s', async (path) => {
    const secret = 'SENTINEL_SECRET_9f3a'; // gitleaks:allow (test sentinel, not a credential)
    const engine = fakeEngine({ apiKey: path === 'key' ? '' : secret });
    const messages = transcript();
    messages[0]!.text = secret;
    messages[1]!.toolUses[0]!.input = { file_path: `/private/${secret}` };
    messages[2]!.toolResults![0]!.text = secret.repeat(100);
    if (path === 'reduction') engine.$.http.fetch.mockImplementation(jevFetch(() => 1));
    if (path === 'error') engine.$.http.fetch.mockResolvedValue({ status: 500, ok: false, text: secret });
    await engine.dispatch('plugin', path === 'ceiling' ? [message('user', secret)] : messages);
    expect(engine.$.fs.write).toHaveBeenCalledTimes(1);
    const record = JSON.parse((engine.$.fs.write.mock.calls[0] as unknown as [string, string])[1]);
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(JSON.stringify(record)).not.toContain('/private/');
    expect(record.outcome).toBe(path === 'success' ? 'jev' : 'skipped');
    if (path === 'error') expect(record.jev).toMatchObject({ requests: 2, retries: 1 });
  });

  it('continues compaction when event writing fails without logging the exception', async () => {
    const engine = fakeEngine();
    engine.$.fs.write.mockRejectedValue(new Error('SENTINEL_SECRET_9f3a'));
    expect(await engine.dispatch('manual')).toHaveProperty('messages');
    expect(engine.$.ui.log.mock.calls.flat().filter((s) => s.includes('event write failed'))).toHaveLength(1);
    expect(engine.$.ui.log.mock.calls.flat().join(' ')).not.toContain('SENTINEL_SECRET_9f3a');
  });

  it('honors eventsDir, avoids collisions, and supports disabling events', async () => {
    const engine = fakeEngine({ eventsDir: '/custom' });
    await Promise.all([engine.dispatch('manual'), engine.dispatch('manual')]);
    const paths = engine.$.fs.write.mock.calls.map((call) => call[0]);
    expect(new Set(paths).size).toBe(2);
    expect(paths.every((path) => String(path).startsWith('/custom/'))).toBe(true);
    const disabled = fakeEngine({ events: false });
    await disabled.dispatch('manual');
    expect(disabled.$.fs.write).not.toHaveBeenCalled();
  });

  it('writes an additional auto event with skip and escalation state', async () => {
    const engine = fakeEngine();
    engine.$.session.compact.mockImplementation(async () => engine.dispatch('plugin', [message('user', 'text')]));
    await engine.turn();
    const writes = engine.$.fs.write.mock.calls as unknown as [string, string][];
    expect(writes).toHaveLength(2);
    expect(writes[1]![0]).toMatch(/-auto.json$/);
    expect(JSON.parse(writes[1]![1])).toMatchObject({ trigger: 'plugin', outcome: 'skipped', reasonCode: 'ceiling_below_min',
      contextPercentBefore: 80, contextPercentAfter: 80, auto: { trigger: 85, compactions: 1 } });
  });

  it('records core errors and calls next only once', async () => {
    const engine = fakeEngine();
    engine.next.mockRejectedValue(new Error('core failed'));
    await expect(engine.dispatch('manual', [message('user', 'text')])).rejects.toThrow('core failed');
    expect(engine.next).toHaveBeenCalledTimes(1);
    expect(JSON.parse((engine.$.fs.write.mock.calls[0] as unknown as [string, string])[1]).reasonCode).toBe('error');
  });

  it('tolerates unavailable context usage', async () => {
    const engine = fakeEngine();
    engine.$.session.usage.mockRejectedValue(new Error('unavailable'));
    expect(await engine.dispatch('manual')).toHaveProperty('messages');
    expect(JSON.parse((engine.$.fs.write.mock.calls[0] as unknown as [string, string])[1]).contextPercentBefore).toBeUndefined();
  });
});

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({
      gitleaks: true,
      events: true,
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      cooldownTurns: 3,
      minPercentDrop: 5,
      maxAutoCompactions: 8,
      model: 'jev-latest',
    });
    expect(
      resolveHookConfig({
        apiKey: 'k',
        keepCallThreshold: 0.3,
        maxStateTokens: 1000,
        model: 'jev-x',
        goal: 'g',
        compactAtPercent: 'no',
        redact: 'strict',
        sideEffectTools: 'Bash, Deploy',
        protectErrors: false,
      }),
    ).toEqual({
      apiKey: 'k',
      gitleaks: true,
      events: true,
      keepCallThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      cooldownTurns: 3,
      minPercentDrop: 5,
      maxAutoCompactions: 8,
      redact: 'strict',
      sideEffectTools: ['Bash', 'Deploy'],
      protectErrors: false,
    });
  });

  it('ignores a redaction level it does not know', () => {
    expect(resolveHookConfig({ redact: 'maybe' }).redact).toBeUndefined();
  });

  it('only turns gitleaks off on an explicit false', () => {
    expect(resolveHookConfig({ gitleaks: false }).gitleaks).toBe(false);
    expect(resolveHookConfig({ gitleaks: true }).gitleaks).toBe(true);
    expect(resolveHookConfig({}).gitleaks).toBe(true);
  });
});

describe('session message mapping', () => {
  it('returns the engine objects for untouched messages and handle-less copies for rebuilt ones', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]).toBe(messages[3]);
    expect(out[4]).toBe(messages[4]);
  });

  it('preserves short dropped-result messages and their handles', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'y'.repeat(100);
    messages[2]!.toolResults![0]!.text = 'y'.repeat(100);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
  });
});

describe('compactSession', () => {
  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', model: 'jev-x' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('jev-x');
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', undefined, 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(summarize(output)).toMatch(/^\d+% reduction; 1 kept, 1 call_dropped; state ~\d+ tokens \(full\) in 1 request\(s\)$/);
    expect(decisionLog(output)).toBe('t1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const { result: output } = await compactSession(transcript(), config, jevFetch(() => 0.1));
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:drop_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:drop_result/call=0.10/result=0.10',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws on a missing key and on failed requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k' }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });
});

describe('auto-compaction guards', () => {
  const config = resolveHookConfig({});

  it('waits for the cooldown, the trigger, and the session cap', () => {
    const fresh = initialAutoCompactState(config);
    expect(shouldAutoCompact(fresh, 59, config).compact).toBe(false);
    expect(shouldAutoCompact(fresh, 61, config).compact).toBe(true);
    // Just compacted: three turns of quiet before asking again.
    expect(shouldAutoCompact({ ...fresh, turnsSinceCompaction: 1 }, 99, config).compact).toBe(false);
    expect(shouldAutoCompact({ ...fresh, turnsSinceCompaction: 3 }, 99, config).compact).toBe(true);
    const capped = { ...fresh, compactions: config.maxAutoCompactions };
    expect(shouldAutoCompact(capped, 99, config)).toMatchObject({ compact: false });
    expect(shouldAutoCompact(capped, 99, config).compact).toBe(false);
  });

  it('leaves the trigger alone when a compaction actually frees context', () => {
    const after = noteCompaction(initialAutoCompactState(config), 80, 40, config);
    expect(after.trigger).toBe(60);
    expect(after.compactions).toBe(1);
    expect(after.turnsSinceCompaction).toBe(0);
    expect(after.disabledReason).toBeUndefined();
  });

  it('raises the trigger above a context level that compaction could not bring down', () => {
    // 82% in, 80% out: two points is not worth doing again at 60%.
    const after = noteCompaction(initialAutoCompactState(config), 82, 80, config);
    expect(after.trigger).toBe(85);
    expect(shouldAutoCompact({ ...after, turnsSinceCompaction: 9 }, 81, config).compact).toBe(false);
    expect(shouldAutoCompact({ ...after, turnsSinceCompaction: 9 }, 86, config).compact).toBe(true);
  });

  it('gives up on the session once the trigger has climbed to the ceiling', () => {
    let state = initialAutoCompactState(config);
    for (let i = 0; i < 6; i += 1) {
      const percent = Math.min(94, state.trigger + 1);
      state = noteCompaction(state, percent, percent, config);
    }
    expect(state.trigger).toBe(95);
    expect(state.disabledReason).toBe('compaction stopped freeing context');
    expect(shouldAutoCompact(state, 99, config).compact).toBe(false);
  });
});
