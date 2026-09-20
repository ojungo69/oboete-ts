import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  observerOutputJsonSchema,
  observerOutputSchema,
  shortenDisplayPath,
  trimObservation,
  validateObserverOutput,
  type Observation,
  type ObserverInput,
} from '../../src/observer/contract.js';

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    type: 'change',
    visibility: 'project',
    title: 'edited src/cli.ts',
    body: 'write src/cli.ts (+12/-3)',
    concepts: ['what-changed'],
    citations: {
      files_read: [],
      files_modified: ['src/cli.ts'],
      commits: [],
    },
    source_event_ids: ['e1'],
    classification: { decision: 'add', target: null, reason: 'new' },
    ...overrides,
  };
}

function output(observations: Observation[] = [observation()]) {
  return { observations, checkpoint: { decision: 'unchanged', source_event_ids: ['e1'], reason: 'No progress changed.' } };
}

const events: ObserverInput['events'] = [
  { id: 'e1', kind: 'prompt', text: 'fix the parser' },
  { id: 'e2', kind: 'tool_result', output: 'ok', tool_name: 'edit' },
];

const nearby: ObserverInput['nearby'] = [
  {
    id: 'm1',
    type: 'decision',
    title: 'keep zod',
    body: 'one schema both paths',
    deleted: false,
  },
];

test('valid output parses', () => {
  const parsed = observerOutputSchema.safeParse(output());
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.observations.length, 1);
    assert.equal(parsed.data.observations[0]?.title, 'edited src/cli.ts');
  }
});

test('21 observations are rejected', () => {
  const parsed = observerOutputSchema.safeParse(
    output(Array.from({ length: 21 }, () => observation())),
  );
  assert.equal(parsed.success, false);
});

test('unknown key is rejected', () => {
  const parsed = observerOutputSchema.safeParse({
    observations: [observation()],
    extra: true,
  });
  assert.equal(parsed.success, false);
});

test('title of 121 characters is rejected', () => {
  const parsed = observerOutputSchema.safeParse(
    output([observation({ title: 't'.repeat(121) })]),
  );
  assert.equal(parsed.success, false);
});

test('empty source_event_ids is rejected', () => {
  const parsed = observerOutputSchema.safeParse(
    output([observation({ source_event_ids: [] })]),
  );
  assert.equal(parsed.success, false);
});

test('validateObserverOutput rejects a foreign source id as unusable_output', () => {
  const result = validateObserverOutput(
    output([observation({ source_event_ids: ['foreign-id'] })]),
    { events, nearby },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'unusable_output');
    assert.match(result.detail, /foreign-id/);
  }
});

test('validateObserverOutput rewrites a missing nearby target to add/null', () => {
  const result = validateObserverOutput(
    output([
      observation({
        classification: {
          decision: 'update',
          target: 'm-missing',
          reason: 'looked similar',
        },
      }),
    ]),
    { events, nearby },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.output.observations[0]?.classification.decision, 'add');
    assert.equal(result.output.observations[0]?.classification.target, null);
  }
});

test('validateObserverOutput turns delete with empty reason into noop', () => {
  const result = validateObserverOutput(
    output([
      observation({
        classification: { decision: 'delete', target: 'm1', reason: '' },
      }),
    ]),
    { events, nearby },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.output.observations[0]?.classification.decision, 'noop');
    assert.equal(result.output.observations[0]?.classification.target, 'm1');
  }
});

test('validateObserverOutput returns ok with the same observations', () => {
  const raw = output([
    observation({
      classification: { decision: 'update', target: 'm1', reason: 'same fact' },
    }),
  ]);
  const result = validateObserverOutput(raw, { events, nearby });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.output.observations, raw.observations);
  }
});

test('trimObservation shortens a 60-line body and keeps 20 paths', () => {
  const line = 'b'.repeat(100);
  const body = Array.from({ length: 60 }, () => line).join('\n');
  const paths = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
  const trimmed = trimObservation(
    observation({
      body,
      citations: {
        files_read: paths,
        files_modified: paths,
        commits: [],
      },
    }),
  );
  assert.ok(trimmed.body.length <= 2000);
  assert.match(trimmed.body, /\.\.\. \(\+\d+ omitted\)$/);
  assert.ok(trimmed.body.startsWith(line));
  assert.equal(trimmed.citations.files_read.length, 20);
  assert.equal(trimmed.citations.files_modified.length, 20);
  assert.deepEqual(trimmed.citations.files_read, paths.slice(0, 20));
});

test('shortenDisplayPath of a 200-character path is 61 characters', () => {
  const path = 'p'.repeat(200);
  const short = shortenDisplayPath(path);
  assert.equal(short.length, 61);
  assert.equal(short.startsWith('…'), true);
  assert.ok(short.endsWith(path.slice(-60)));
});


test('observerOutputJsonSchema serializes and contains observations', () => {
  const encoded = JSON.stringify(observerOutputJsonSchema);
  assert.ok(encoded.length > 0);
  const parsed = JSON.parse(encoded) as {
    properties?: { observations?: unknown };
  };
  assert.ok(parsed.properties?.observations);
});

test('trimObservation keeps as much of a single long line as the budget allows', () => {
  const trimmed = trimObservation(observation({ body: 'z'.repeat(2_500) }));
  assert.equal(trimmed.body.length, 2000);
  assert.match(trimmed.body, /\n\.\.\. \(\+1 omitted\)$/);
  assert.ok(trimmed.body.startsWith('z'.repeat(1_983)));
});

test('trimObservation keeps content when the body opens with blank lines', () => {
  // Cutting at the first line boundary would leave `\n... (+1 omitted)` — the marker as the whole
  // body, with every character of content dropped. `classify.ts` also reads a field that is only
  // the marker as the provider's own words, which only holds while the worker never writes one.
  for (const prefix of ['\n', '  \n', '\n\n', ' \t \n', ' '.repeat(2_000) + '\n']) {
    const trimmed = trimObservation(observation({ body: `${prefix}${'\u3042'.repeat(2_500)}` }));
    assert.match(trimmed.body, /\n\.\.\. \(\+\d+ omitted\)$/, JSON.stringify(prefix.slice(0, 8)));
    assert.ok(trimmed.body.includes('\u3042'), `content survives ${JSON.stringify(prefix.slice(0, 8))}`);
    assert.ok(trimmed.body.length <= 2000, JSON.stringify(prefix.slice(0, 8)));
  }
});

test('trimObservation returns nothing for a body that is blank all the way through', () => {
  // The alternative is a marker that omits nothing, which `classify.ts` then scores as the
  // provider's own English and sends a whole valid batch to the fallback.
  assert.equal(trimObservation(observation({ body: ' '.repeat(2_500) })).body, '');
  assert.equal(trimObservation(observation({ body: '\n'.repeat(2_500) })).body, '');
});

test('validateObserverOutput trims an oversized body and title instead of refusing the batch', () => {
  const result = validateObserverOutput(
    output([observation({ title: 't'.repeat(200), body: 'b'.repeat(2_100) })]),
    { events, nearby },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const observed = result.output.observations[0];
  assert.equal(observed?.title.length, 120);
  assert.ok((observed?.body.length ?? 0) <= 2000);
  assert.match(observed?.body ?? '', /\n\.\.\. \(\+1 omitted\)$/);
});

test('validateObserverOutput cuts the citation lists and normalizes the commit ids', () => {
  const paths = Array.from({ length: 25 }, (_, index) => `src/f${index}.ts`);
  const result = validateObserverOutput(
    output([
      observation({
        citations: { files_read: paths, files_modified: paths, commits: ['ABCDEF1', 'HEAD'] },
      }),
    ]),
    { events, nearby },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const cited = result.output.observations[0]?.citations;
  assert.equal(cited?.files_read.length, 20);
  assert.equal(cited?.files_modified.length, 20);
  // A symbolic reference is dropped, not a reason to lose the whole batch.
  assert.deepEqual(cited?.commits, ['abcdef1']);
});

test('validateObserverOutput still refuses a structurally broken output', () => {
  const missingField = validateObserverOutput({ observations: [{ type: 'change' }] }, { events, nearby });
  assert.equal(missingField.ok, false);
  const unknownKey = validateObserverOutput(
    { observations: [{ ...observation(), extra: true }] },
    { events, nearby },
  );
  assert.equal(unknownKey.ok, false);
  const tooMany = validateObserverOutput(
    output(Array.from({ length: 21 }, () => observation())),
    { events, nearby },
  );
  assert.equal(tooMany.ok, false);
  const empty = validateObserverOutput(
    output([observation({ source_event_ids: [] })]),
    { events, nearby },
  );
  assert.equal(empty.ok, false);
});






test('validateObserverOutput trims a long classification reason instead of refusing the batch', () => {
  const result = validateObserverOutput(
    output([
      observation({
        classification: { decision: 'update', target: 'm1', reason: 'r'.repeat(250) },
      }),
    ]),
    { events, nearby },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.output.observations[0]?.classification.reason.length, 200);
});
