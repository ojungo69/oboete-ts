import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertCoverage } from '../fixtures/fixture-coverage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the committed fixture satisfies the generator coverage contract', () => {
  const body = fs.readFileSync(path.join(ROOT, 'test/fixtures/events-1000.jsonl'), 'utf8');
  const events = body.trimEnd().split('\n').map((line) => JSON.parse(line));
  const readJsonl = (name) => fs.readFileSync(path.join(ROOT, 'test/corpus', name), 'utf8')
    .trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const report = assertCoverage(events, readJsonl('secrets.jsonl'), readJsonl('directives.jsonl'), body);
  assert.equal(report.total, 1051);
  assert.deepEqual(report.byAgent, { claude: 255, codex: 271, grok: 263, pi: 262 });
});

test('the bulk generator adds filler only and is deterministic', async () => {
  const { generate } = await import('../fixtures/generate-1000-events.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oboete-bulk-'));
  try {
    const first = generate({ target: 2000, out: path.join(dir, 'a.jsonl') });
    generate({ target: 2000, out: path.join(dir, 'b.jsonl') });
    const body = fs.readFileSync(first.path, 'utf8');
    assert.equal(body, fs.readFileSync(path.join(dir, 'b.jsonl'), 'utf8'));
    assert.ok(first.report.total >= 2000, `${first.report.total} events`);
    for (const n of Object.values(first.report.byAgent)) assert.ok(n >= 500, `an agent has ${n} events`);
    const events = body.trimEnd().split('\n').map((line) => JSON.parse(line));
    const tagged = (key) => events.filter((event) => event.tags?.[key] !== undefined).length;
    assert.deepEqual([tagged('fact'), tagged('recall'), tagged('size')], [40, 40, 4]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
