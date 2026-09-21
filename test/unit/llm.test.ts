import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PRESET_CATALOG, type Credentials } from '../../src/config.js';
import { MAX_OBSERVATIONS, observerOutputJsonSchema, type ObserverInput, type ObserverOutput } from '../../src/observer/contract.js';
import { aliasObserverInput, buildSummarizerPrompt, summarizeWithProvider } from '../../src/observer/llm.js';
import { cliSpawn } from '../helpers/agent-cli.js';

const MODEL = PRESET_CATALOG.openrouter.defaultModel;
const MAX_RESPONSE_CHARS = 1024 * 1024;

const INPUT: ObserverInput = {
  repo_ref: 'repo_1234',
  checkpoint_context: { state: 'none' },
  session: {
    started_at: 1_757_000_000_000,
    turns: [{ ordinal: 1, started_at: 1_757_000_000_000, ended_at: null }],
  },
  events: [{ id: 'e1', kind: 'prompt', text: 'この不具合を直してください。' }],
  free_summaries: {},
  nearby: [],
  language_hint: 'ja',
};

function output(sourceEventId = 'e1'): ObserverOutput {
  return {
    checkpoint: { decision: 'unchanged', source_event_ids: [sourceEventId], reason: '作業の進捗に変更はありません。' },
    observations: [
      {
        type: 'bugfix',
        visibility: 'project',
        title: '不具合を修正した',
        body: '共有経路の条件を修正した。',
        concepts: ['problem-solution'],
        citations: { files_read: [], files_modified: [], commits: [] },
        source_event_ids: [sourceEventId],
        classification: { decision: 'add', target: null, reason: '新しい修正' },
      },
    ],
  };
}

const HEX_A = 'a'.repeat(63) + '1';
const HEX_B = 'b'.repeat(63) + '2';
const HEX_INPUT: ObserverInput = {
  ...INPUT,
  events: [{ id: HEX_A, kind: 'prompt', text: 'この不具合を直してください。' }, { id: HEX_B, kind: 'prompt', text: '続きです。' }],
  nearby: [{ id: 'm_stored_memory', type: 'bugfix', title: '古い修正', body: '以前の修正。', deleted: false }],
};

function apiCredentials(): Credentials {
  return {
    kind: 'api-key',
    present: true,
    source: 'test',
    values: { apiKey: 'test-key' },
  };
}

function openAiResponse(
  text: string,
  options: {
    model?: string;
    finishReason?: string;
    headers?: ConstructorParameters<typeof Headers>[0];
    inputTokens?: number;
    outputTokens?: number;
  } = {},
): Response {
  const inputTokens = options.inputTokens ?? 10;
  const outputTokens = options.outputTokens ?? 5;
  const headers = new Headers(options.headers);
  headers.set('content-type', 'application/json');
  return new Response(
    JSON.stringify({
      id: 'response-1',
      model: options.model ?? MODEL,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: options.finishReason ?? 'stop',
        },
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    }),
    {
      status: 200,
      headers,
    },
  );
}

function workersResponse(
  text: unknown,
  extraHeaders: ConstructorParameters<typeof Headers>[0] = {},
): Response {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json');
  return new Response(
    JSON.stringify({
      success: true,
      result: {
        response: text,
        usage: { prompt_tokens: 8, completion_tokens: 2 },
      },
      errors: [],
      messages: [],
    }),
    { status: 200, headers },
  );
}

function errorResponse(status: number, bodyCode?: number | string, cloudflare = false): Response {
  const body =
    bodyCode === undefined
      ? { error: { message: 'failure' } }
      : cloudflare
        ? { errors: [{ code: bodyCode, message: 'failure' }] }
        : { error: { message: 'failure', code: bodyCode } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchStep = (...args: Parameters<typeof globalThis.fetch>) => Response | Promise<Response>;

function scriptedFetch(...steps: FetchStep[]): { fetch: typeof fetch; calls: () => number } {
  let count = 0;
  return {
    fetch: async (input, init) => {
      const step = steps[count];
      count += 1;
      if (step === undefined) throw new Error(`unexpected fetch ${count}`);
      return step(input, init);
    },
    calls: () => count,
  };
}

function httpHarness(
  fetch: typeof globalThis.fetch,
  overrides: Partial<Parameters<typeof summarizeWithProvider>[1]> = {},
): {
  ctx: Parameters<typeof summarizeWithProvider>[1];
  reservations: () => number;
  exhausted: string[];
} {
  let reservationCount = 0;
  const exhausted: string[] = [];
  return {
    ctx: {
      preset: 'openrouter',
      model: MODEL,
      credentials: apiCredentials(),
      consentOk: () => true,
      reserve: () => {
        reservationCount += 1;
        return { ok: true, reservationId: `reservation-${reservationCount}` };
      },
      onExhausted: (reservationId) => exhausted.push(reservationId),
      fetch,
      timeoutMs: 1000,
      ...overrides,
    },
    reservations: () => reservationCount,
    exhausted,
  };
}

test('buildSummarizerPrompt states the contract without an agent name or repository path', () => {
  const schemaPrompt = buildSummarizerPrompt(INPUT, 'schema');
  assert.equal(schemaPrompt.user, JSON.stringify(INPUT));
  assert.match(schemaPrompt.system, /bugfix/);
  assert.match(schemaPrompt.system, /security_note/);
  assert.match(schemaPrompt.system, /how-it-works/);
  assert.match(schemaPrompt.system, /source_event_ids/);
  assert.match(schemaPrompt.system, /events list only/);
  assert.match(schemaPrompt.system, /dominant language of the input/);
  assert.doesNotMatch(schemaPrompt.system, /claude|codex|grok|\bpi\b/i);
  assert.doesNotMatch(schemaPrompt.system, /\/home\/|repository path/i);

  const textJsonPrompt = buildSummarizerPrompt(INPUT, 'text-json');
  assert.match(textJsonPrompt.system, /Reply with exactly one JSON object matching this schema/);
  assert.match(textJsonPrompt.system, /"observations"/);
});

test('buildSummarizerPrompt preserves exact strings in both modes', () => {
  for (const mode of ['schema', 'text-json'] as const) {
    const prompt = buildSummarizerPrompt(INPUT, mode);
    assert.match(prompt.system, /verbatim/);
    assert.match(prompt.system, /never translate/);
    // The per-fact rule (#274) and the schema's hard observation cap.
    assert.match(prompt.system, /one observation per item/);
    assert.ok(prompt.system.includes(`at most ${MAX_OBSERVATIONS} observations`),
      'the prompt states the schema cap it is derived from');
    // The accounting sense of noop, kept distinct from the add/update/delete/noop classification.
    assert.match(prompt.system, /never accounted for by a noop observation with no target/);
  }
});

test('schema success returns validated output, model id, attempts, and header neurons', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const scripted = scriptedFetch(async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return workersResponse(output('e1'), { 'cf-aig-neurons': '45.25' });
  });
  const harness = httpHarness(scripted.fetch, {
    preset: 'workers-ai',
    model: PRESET_CATALOG['workers-ai'].defaultModel,
    credentials: {
      kind: 'cloudflare',
      present: true,
      source: 'test',
      values: { accountId: 'account-123', token: 'test-token' },
    },
  });
  // A 64-hex id as stored: the model answers with its alias and gets the stored id back (#329).
  const result = await summarizeWithProvider(HEX_INPUT, harness.ctx);
  assert.deepEqual(result, {
    ok: true,
    output: output(HEX_A),
    resolvedModel: PRESET_CATALOG['workers-ai'].defaultModel,
    neurons: 45.25,
    attempts: 1,
  });
  assert.equal(scripted.calls(), 1);
  assert.equal(harness.reservations(), 1);
  const responseFormat = requestBody?.response_format as Record<string, unknown> | undefined;
  assert.equal(responseFormat?.type, 'json_schema');
  assert.equal(typeof responseFormat?.json_schema, 'object');
  assert.deepEqual(requestBody?.chat_template_kwargs, { enable_thinking: false }, 'thinking is off for the observer call');
});

// `json_object` guarantees valid JSON, not the observer's JSON, so the schema has to travel in the
// prompt. Without it a local model answered with keys of its own and every call failed validation.
test('a json_object preset sends the observer schema in its system prompt', async (t) => {
  const schema = JSON.stringify(observerOutputJsonSchema);
  const cases = [
    { preset: 'openrouter', credentials: apiCredentials(), schemaInPrompt: true },
    // Ollama constrains decoding to the schema it receives in response_format.
    { preset: 'ollama', credentials: { kind: 'none', present: true, source: 'none', values: {} }, schemaInPrompt: false },
    {
      preset: 'workers-ai',
      credentials: { kind: 'cloudflare', present: true, source: 'test', values: { accountId: 'account-123', token: 'test-token' } },
      // The schema is in response_format, where the API enforces it.
      schemaInPrompt: false,
    },
  ] as const;
  for (const { preset, credentials, schemaInPrompt } of cases) {
    await t.test(preset, async () => {
      let requestBody: Record<string, unknown> | undefined;
      const scripted = scriptedFetch(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return preset === 'workers-ai' ? workersResponse(output(), {}) : openAiResponse(JSON.stringify(output()));
      });
      const result = await summarizeWithProvider(INPUT, httpHarness(scripted.fetch, { preset, credentials }).ctx);
      assert.equal(result.ok, true);
      const messages = requestBody?.messages as { role: string; content: string }[] | undefined;
      const system = messages?.find((message) => message.role === 'system')?.content ?? '';
      assert.equal(system.includes(schema), schemaInPrompt);
      if (preset === 'ollama') {
        assert.equal(requestBody?.reasoning_effort, 'none', 'thinking is off for the observer call');
        assert.equal((requestBody?.response_format as { type?: string } | undefined)?.type, 'json_schema');
      }
    });
  }
});

test('neurons fall back to separate input and output token rates', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const scripted = scriptedFetch(async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return openAiResponse(JSON.stringify(output()), { inputTokens: 100, outputTokens: 20 });
  });
  const result = await summarizeWithProvider(INPUT, httpHarness(scripted.fetch).ctx);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.neurons, (100 * 5500 + 20 * 36_400) / 1_000_000);
  }
  assert.deepEqual(requestBody?.response_format, { type: 'json_object' });
});

test('HTTP status and body code classification is table-driven and code-sensitive', async (t) => {
  const cases: Array<{
    name: string;
    status: number;
    code?: number | string;
    cloudflare?: boolean;
    reason: Exclude<Awaited<ReturnType<typeof summarizeWithProvider>>, { ok: true }>['reason'];
    attempts: number;
  }> = [
    { name: '429 code 3036', status: 429, code: 3036, cloudflare: true, reason: 'provider_exhausted', attempts: 1 },
    { name: '429 code 3040', status: 429, code: 3040, reason: 'provider_exhausted', attempts: 2 },
    { name: '429 without code', status: 429, reason: 'provider_exhausted', attempts: 1 },
    { name: '403 code 5035', status: 403, code: 5035, reason: 'provider_paid', attempts: 1 },
    { name: '403 without code', status: 403, reason: 'auth_failed', attempts: 1 },
    { name: '401', status: 401, reason: 'auth_failed', attempts: 1 },
    { name: '408', status: 408, reason: 'unreachable', attempts: 2 },
    { name: 'body code 3007', status: 500, code: 3007, reason: 'unreachable', attempts: 2 },
    { name: 'permission body code', status: 400, code: 'permission_denied', reason: 'auth_failed', attempts: 1 },
  ];

  for (const row of cases) {
    await t.test(row.name, async () => {
      const steps = Array.from({ length: row.attempts }, () => async () =>
        errorResponse(row.status, row.code, row.cloudflare),
      );
      const scripted = scriptedFetch(...steps);
      const harness = httpHarness(scripted.fetch);
      const result = await summarizeWithProvider(INPUT, harness.ctx);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, row.reason);
      assert.equal(result.attempts, row.attempts);
      assert.equal(scripted.calls(), row.attempts);
      assert.equal(harness.reservations(), row.attempts);
      assert.deepEqual(
        harness.exhausted,
        row.status === 429 && row.code === 3036 ? ['reservation-1'] : [],
      );
    });
  }
});

test('a network failure without a status is unreachable', async () => {
  const scripted = scriptedFetch(async () => {
    throw new TypeError('offline');
  });
  const result = await summarizeWithProvider(INPUT, httpHarness(scripted.fetch).ctx);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'unreachable');
  assert.equal(result.attempts, 1);
});

test('an aborted provider request is timeout', async () => {
  const scripted = scriptedFetch(
    async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === null || signal === undefined) assert.fail('missing abort signal');
        const keepAlive = setTimeout(() => {}, 1000);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(keepAlive);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  );
  const harness = httpHarness(scripted.fetch, { timeoutMs: 10 });
  const result = await summarizeWithProvider(INPUT, harness.ctx);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'timeout');
  assert.equal(result.attempts, 1);
});

test('length finish reason retries once then returns unusable_output', async () => {
  const scripted = scriptedFetch(
    async () => openAiResponse(JSON.stringify(output()), { finishReason: 'length' }),
    async () => openAiResponse(JSON.stringify(output()), { finishReason: 'length' }),
  );
  const harness = httpHarness(scripted.fetch);
  const result = await summarizeWithProvider(INPUT, harness.ctx);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'unusable_output');
  assert.equal(result.attempts, 2);
  assert.equal(harness.reservations(), 2);
});

test('invalid JSON retries once then returns unusable_output', async () => {
  const scripted = scriptedFetch(
    async () => openAiResponse('not json'),
    async () => openAiResponse('still not json'),
  );
  const harness = httpHarness(scripted.fetch);
  const result = await summarizeWithProvider(INPUT, harness.ctx);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'unusable_output');
  assert.equal(result.attempts, 2);
  assert.equal(harness.reservations(), 2);
});

test('foreign source_event_ids retry once then return unusable_output', async () => {
  const scripted = scriptedFetch(
    async () => openAiResponse(JSON.stringify(output('foreign'))),
    async () => openAiResponse(JSON.stringify(output('foreign'))),
  );
  const result = await summarizeWithProvider(INPUT, httpHarness(scripted.fetch).ctx);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'unusable_output');
    assert.match(result.detail, /source_event_ids/);
  }
  assert.equal(result.attempts, 2);
});

test('a response above 1 MB is refused without parsing or retrying', async () => {
  const scripted = scriptedFetch(async () => openAiResponse('x'.repeat(MAX_RESPONSE_CHARS + 1)));
  const harness = httpHarness(scripted.fetch);
  const result = await summarizeWithProvider(INPUT, harness.ctx);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'unusable_output');
  assert.equal(result.attempts, 1);
  assert.equal(harness.reservations(), 1);
});

test('an HTTP envelope above 1 MB is stopped before the SDK parses it', async () => {
  const scripted = scriptedFetch(
    async () =>
      new Response('x'.repeat(MAX_RESPONSE_CHARS + 1), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const harness = httpHarness(scripted.fetch);
  const result = await summarizeWithProvider(INPUT, harness.ctx);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'unusable_output');
  assert.equal(result.attempts, 1);
  assert.equal(harness.reservations(), 1);
});

test('a declared content-length above 1 MB cancels the live body', async () => {
  let cancelled = false;
  const scripted = scriptedFetch(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([120]));
          },
          cancel() {
            cancelled = true;
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': '2097152',
          },
        },
      ),
  );
  const harness = httpHarness(scripted.fetch);
  const result = await summarizeWithProvider(INPUT, harness.ctx);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'unusable_output');
    assert.equal(result.detail, 'provider response exceeded 1 MB');
  }
  assert.equal(result.attempts, 1);
  assert.equal(harness.reservations(), 1);
  assert.equal(cancelled, true);
});

test('a returned model id alias is rejected', async () => {
  const scripted = scriptedFetch(async () =>
    openAiResponse(JSON.stringify(output()), { model: `${MODEL}-2026-09-04` }),
  );
  const result = await summarizeWithProvider(INPUT, httpHarness(scripted.fetch).ctx);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'model_alias');
  assert.equal(result.attempts, 1);
});

test('known runtime-id decorations are normalized before the model comparison', async () => {
  const scripted = scriptedFetch(async () =>
    openAiResponse(JSON.stringify(output()), { model: 'claude-opus-5[1m]' }),
  );
  const harness = httpHarness(scripted.fetch, { model: 'claude-opus-5' });
  const result = await summarizeWithProvider(INPUT, harness.ctx);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.resolvedModel, 'claude-opus-5[1m]');
});

test('changed consent prevents both reservation and fetch', async () => {
  const scripted = scriptedFetch(async () => assert.fail('fetch must not run'));
  const harness = httpHarness(scripted.fetch, { consentOk: () => false });
  const result = await summarizeWithProvider(INPUT, harness.ctx);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'consent_changed');
  assert.equal(result.attempts, 0);
  assert.equal(harness.reservations(), 0);
  assert.equal(scripted.calls(), 0);
});

test('a refused reservation returns its reason without a fetch', async (t) => {
  for (const reason of ['daily_cap', 'provider_exhausted'] as const) {
    await t.test(reason, async () => {
      const scripted = scriptedFetch(async () => assert.fail('fetch must not run'));
      const harness = httpHarness(scripted.fetch, { reserve: () => ({ ok: false, reason }) });
      const result = await summarizeWithProvider(INPUT, harness.ctx);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, reason);
      assert.equal(result.attempts, 0);
      assert.equal(scripted.calls(), 0);
    });
  }
});

test('missing credentials return no_provider without reserving or fetching', async () => {
  const scripted = scriptedFetch(async () => assert.fail('fetch must not run'));
  const harness = httpHarness(scripted.fetch, {
    credentials: { kind: 'api-key', present: false, source: 'test', values: {} },
  });
  const result = await summarizeWithProvider(INPUT, harness.ctx);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'no_provider');
  assert.equal(result.attempts, 0);
  assert.equal(harness.reservations(), 0);
});

test('3036 persists exactly the reservation that observed exhaustion', async () => {
  const scripted = scriptedFetch(async () => errorResponse(429, 3036, true));
  const harness = httpHarness(scripted.fetch);
  const result = await summarizeWithProvider(INPUT, harness.ctx);
  assert.equal(result.ok, false);
  assert.deepEqual(harness.exhausted, ['reservation-1']);
});

/**
 * The agent-cli half of `httpHarness`: an uncapped target still takes a reservation, because the
 * reservation is what puts the batch in `running` and fences a dead worker's in-flight child
 * process (contracts/provider-fallback.md "For each target").
 */
function cliHarness(
  cli: ReturnType<typeof cliSpawn>,
  overrides: Partial<Parameters<typeof summarizeWithProvider>[1]> = {},
): { ctx: Parameters<typeof summarizeWithProvider>[1]; reservations: () => number } {
  let reservationCount = 0;
  return {
    ctx: {
      preset: 'agent-cli',
      model: 'agent-model',
      agentCli: 'claude',
      credentials: { kind: 'agent-login', present: true, source: 'test', values: {} },
      consentOk: () => true,
      reserve: () => {
        reservationCount += 1;
        return { ok: true, reservationId: `reservation-${reservationCount}` };
      },
      onExhausted: () => assert.fail('agent-cli cannot persist provider exhaustion'),
      spawn: cli.spawn,
      timeoutMs: 1000,
      ...overrides,
    },
    reservations: () => reservationCount,
  };
}

test('agent-cli is uncapped, consented, reserves its attempt and validates the CLI text as observer JSON', async () => {
  const cli = cliSpawn([JSON.stringify(output())]);
  const harness = cliHarness(cli);
  const result = await summarizeWithProvider(INPUT, harness.ctx);
  assert.deepEqual(result, {
    ok: true,
    output: output(),
    resolvedModel: null,
    neurons: null,
    attempts: 1,
  });
  assert.equal(cli.calls(), 1);
  assert.equal(harness.reservations(), 1);
});

test('agent-cli retries one non-JSON model reply then returns unusable_output', async () => {
  const cli = cliSpawn(['not json', 'still not json']);
  const harness = cliHarness(cli);
  const result = await summarizeWithProvider(INPUT, harness.ctx);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'unusable_output');
  assert.equal(result.attempts, 2);
  assert.equal(cli.calls(), 2);
  assert.equal(harness.reservations(), 2);
});

test('a refused reservation stops agent-cli before the paid child process runs', async () => {
  const cli = cliSpawn([JSON.stringify(output())]);
  const harness = cliHarness(cli, {
    reserve: () => ({ ok: false, reason: 'provider_exhausted' }),
  });
  const result = await summarizeWithProvider(INPUT, harness.ctx);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'provider_exhausted');
  assert.equal(result.attempts, 0);
  assert.equal(cli.calls(), 0);
});

test('a consent change after the agent-cli reservation stops the chain before the child process', async () => {
  const cli = cliSpawn([JSON.stringify(output())]);
  let reservations = 0;
  const result = await summarizeWithProvider(INPUT, cliHarness(cli, {
    reserve: () => {
      reservations += 1;
      return { ok: true, reservationId: 'reservation-1' };
    },
    consentOk: () => reservations === 0,
  }).ctx);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'consent_changed');
  assert.equal(cli.calls(), 0);
});

/**
 * The stub is handed to the product through slots typed `typeof spawn` (`deps.spawn` in
 * `src/worker/observe.ts`, `src/doctor.ts` and `src/setup/probe.ts`), and that type permits
 * `spawn(command, args)`. A stub that read `options.signal` unconditionally would fail such a call
 * with a `TypeError` in the tests while the same call worked in production.
 */
test('the agent CLI stub answers a spawn call that omits options, as `typeof spawn` allows', () => {
  const cli = cliSpawn([]);
  assert.doesNotThrow(() => cli.spawn('claude', ['--version']));
});

test('aliasObserverInput names events e1.. and nearby records m1.. and restores only through its own tables', () => {
  const paged = { ...HEX_INPUT, events: [...HEX_INPUT.events, { id: HEX_A, kind: 'prompt' as const, text: '同じ出来事の続き' }] };
  const { sent, restore } = aliasObserverInput(paged);
  assert.deepEqual(sent.events.map((event) => event.id), ['e1', 'e2', 'e1'], 'pages of one event share its alias');
  assert.deepEqual(sent.nearby.map((row) => row.id), ['m1']);
  const withoutIds = (value: ObserverInput) => ({ ...value, events: value.events.map((event) => ({ ...event, id: '' })),
    nearby: value.nearby.map((row) => ({ ...row, id: '' })) });
  assert.deepEqual(withoutIds(sent), withoutIds(paged), 'nothing but the ids changes');
  assert.equal(JSON.stringify(sent).includes(HEX_A), false);
  const answer = output('e2');
  answer.observations[0].source_event_ids = ['e1', 'e2', 'e9', 'm1', HEX_B];
  answer.observations[0].classification = { decision: 'update', target: 'm1', reason: '更新' };
  const restored = restore(answer) as ObserverOutput;
  assert.deepEqual(restored.observations[0].source_event_ids, [HEX_A, HEX_B, 'e9', 'm1', HEX_B],
    'an unknown alias and an m alias cited as a source stay for validation to reject; a copied id stays');
  assert.equal(restored.observations[0].classification.target, 'm_stored_memory');
  assert.deepEqual(restored.checkpoint.source_event_ids, [HEX_B]);
  assert.deepEqual(answer.observations[0].source_event_ids, ['e1', 'e2', 'e9', 'm1', HEX_B], 'the parsed answer is not mutated');

  // A second request with the same ids in reverse order has its own tables.
  const reversed = aliasObserverInput({ ...HEX_INPUT, events: [...HEX_INPUT.events].reverse() });
  assert.deepEqual((reversed.restore(output('e1')) as ObserverOutput).observations[0].source_event_ids, [HEX_B]);
  assert.deepEqual((restore(output('e1')) as ObserverOutput).observations[0].source_event_ids, [HEX_A]);

  for (const malformed of [null, 'text', [], {}, { observations: null, checkpoint: 3 }, { observations: [null, { source_event_ids: 'e1', classification: null }] }]) {
    assert.doesNotThrow(() => restore(malformed));
  }
  assert.deepEqual(restore({ observations: [{ source_event_ids: 'e1' }] }), { observations: [{ source_event_ids: 'e1' }] }, 'a malformed answer reaches validation as it came');
});

test('the provider sees aliases, and an aliased answer, a retried one and a copied id all come back as stored ids', async () => {
  const bodies: string[] = [];
  const aliased = output('e1');
  aliased.observations[0].classification = { decision: 'update', target: 'm1', reason: '更新' };
  const scripted = scriptedFetch(
    async (_input, init) => { bodies.push(String(init?.body)); return openAiResponse('{"observations": null}'); },
    async (_input, init) => { bodies.push(String(init?.body)); return openAiResponse(JSON.stringify(aliased)); },
  );
  const result = await summarizeWithProvider(HEX_INPUT, httpHarness(scripted.fetch).ctx);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.output.observations[0].source_event_ids, [HEX_A]);
    assert.equal(result.output.observations[0].classification.target, 'm_stored_memory');
    assert.deepEqual(result.output.checkpoint.source_event_ids, [HEX_A]);
  }
  assert.equal(result.attempts, 2);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1], 'the retry sends the same aliases');
  assert.equal(bodies[0].includes(HEX_A) || bodies[0].includes('m_stored_memory'), false);
  assert.match(bodies[0], /\\"id\\":\\"e1\\"/);

  const copied = scriptedFetch(async () => openAiResponse(JSON.stringify(output(HEX_A))));
  const direct = await summarizeWithProvider(HEX_INPUT, httpHarness(copied.fetch).ctx);
  assert.equal(direct.ok && direct.output.observations[0].source_event_ids[0], HEX_A, 'a correctly copied stored id still validates');

  const nearbyAsSource = scriptedFetch(
    async () => openAiResponse(JSON.stringify(output('m1'))),
    async () => openAiResponse(JSON.stringify(output('m1'))),
  );
  const refused = await summarizeWithProvider(HEX_INPUT, httpHarness(nearbyAsSource.fetch).ctx);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, 'unusable_output');
  assert.equal(refused.attempts, 2);
});

test('the agent CLI path sends aliases and restores an aliased answer too', async () => {
  const cli = cliSpawn([JSON.stringify(output('e2'))]);
  const result = await summarizeWithProvider(HEX_INPUT, cliHarness(cli).ctx);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.output.observations[0].source_event_ids, [HEX_B]);
  assert.equal(cli.prompts.length, 1);
  assert.match(cli.prompts[0], /"id":"e2"/);
  assert.equal(cli.prompts[0].includes(HEX_B), false);
});
