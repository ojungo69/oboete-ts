// T024 / SC-003: the replay fixture with each recall question reworded (paraphrase-queries.json).
// The rewording rule: ask what a developer who remembers the topic but not its terms would ask, in
// the same language, keeping product and agent names and avoiding the fact sentence's own nouns.
// Only the question changes: the line that asks it and the fact tag that reports it. Every other
// line is byte-for-byte the input.
// Usage: node test/fixtures/make-paraphrase-fixture.mjs <out.jsonl>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2];
if (out === undefined) throw new Error('usage: make-paraphrase-fixture.mjs <out.jsonl>');
const paraphrase = JSON.parse(readFileSync(join(dir, 'paraphrase-queries.json'), 'utf8'));
const lines = readFileSync(join(dir, 'events-1000.jsonl'), 'utf8').split('\n').filter((line) => line !== '');
const queries = new Map();
for (const line of lines) {
  const fact = JSON.parse(line).tags?.fact;
  if (fact !== undefined) queries.set(fact.id, fact.query);
}
if (queries.size !== Object.keys(paraphrase).length || [...queries.keys()].some((id) => !(id in paraphrase))) {
  throw new Error('paraphrase-queries.json must reword exactly the facts events-1000.jsonl plants');
}
if (Object.values(paraphrase).some((query) => typeof query !== 'string' || query.trim() === '')) {
  throw new Error('every paraphrase must be a non-empty string');
}

const reword = (value, from, to) => {
  if (typeof value === 'string') return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((item) => reword(item, from, to));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reword(item, from, to)]));
  }
  return value;
};

let asked = 0;
const result = lines.map((line) => {
  const event = JSON.parse(line);
  const fact = event.tags?.fact;
  if (fact !== undefined) fact.query = paraphrase[fact.id];
  const id = event.tags?.recall;
  if (id === undefined) return fact === undefined ? line : JSON.stringify(event);
  const before = JSON.stringify(event.payload);
  event.payload = reword(event.payload, queries.get(id), paraphrase[id]);
  if (JSON.stringify(event.payload) === before) throw new Error(`recall line ${event.seq} does not quote ${id}'s question`);
  asked += 1;
  return JSON.stringify(event);
});
if (asked !== queries.size) throw new Error(`reworded ${asked} recall lines for ${queries.size} facts`);
writeFileSync(out, `${result.join('\n')}\n`);
