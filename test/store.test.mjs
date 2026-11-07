import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY,
  computeLinks,
  createNote,
  linkKey,
  loadState,
  normalizeState,
  parseLinkTitles,
  recency,
  renameInBodies,
  syncLinkTimes,
} from '../js/store.js';
import { createSeedState } from '../js/seed.js';
import { renderMarkdown } from '../js/markdown.js';

const empty = () => ({ version: 1, notes: {}, linkTimes: {}, settings: {} });

test('parses plain, heading and alias wikilinks', () => {
  assert.deepEqual(parseLinkTitles('a [[One]] b [[Two#Sec]] c [[ Three |alias]] [[]]'), ['One', 'Two', 'Three']);
});

test('ignores wikilinks inside inline code and code fences', () => {
  assert.deepEqual(parseLinkTitles('`[[No]]` [[Yes]]\n```\n[[AlsoNo]]\n```\n[[Yes2]]'), ['Yes', 'Yes2']);
  assert.deepEqual(parseLinkTitles('```\n[[Unclosed]]'), []);
});

test('computeLinks resolves case-insensitively, dedupes, skips self-links and missing notes', () => {
  const s = empty();
  const a = createNote(s, { title: 'Alpha', body: '[[beta]] [[Beta]] [[Alpha]] [[Nope]]' });
  const b = createNote(s, { title: 'Beta' });
  assert.deepEqual(computeLinks(s), [{ source: a.id, target: b.id }]);
});

test('renameInBodies rewrites links and keeps heading/alias suffixes', () => {
  const s = empty();
  const a = createNote(s, { title: 'A', body: 'see [[Old]], [[old#Part]] and [[Old|that one]]; not [[Older]]' });
  const n = renameInBodies(s, 'Old', 'New');
  assert.equal(n, 1);
  assert.equal(a.body, 'see [[New]], [[New#Part]] and [[New|that one]]; not [[Older]]');
});

test('renameInBodies treats regex characters in titles literally', () => {
  const s = empty();
  const a = createNote(s, { title: 'A', body: '[[C++ (notes)]] [[Cxx (notes)]]' });
  renameInBodies(s, 'C++ (notes)', 'Cpp');
  assert.equal(a.body, '[[Cpp]] [[Cxx (notes)]]');
});

test('syncLinkTimes keeps first-seen times, adds new links, drops removed ones', () => {
  const s = empty();
  s.linkTimes = { 'a>b': 100, 'gone>x': 50 };
  syncLinkTimes(s, [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }], 999);
  assert.deepEqual(s.linkTimes, { 'a>b': 100, 'b>c': 999 });
});

test('recency halves every half-life', () => {
  assert.equal(recency(1000, 1000, 7), 1);
  assert.ok(Math.abs(recency(0, 7 * DAY, 7) - 0.5) < 1e-12);
  assert.equal(recency(5000, 1000, 7), 1, 'future timestamps clamp to 1');
});

test('normalizeState rejects junk and fills defaults', () => {
  assert.throws(() => normalizeState({ nope: true }));
  const s = normalizeState({ notes: { x: { id: 'x', title: 'X' }, bad: { title: 3 } }, settings: { repel: -5 } });
  assert.deepEqual(Object.keys(s.notes), ['x']);
  assert.equal(s.notes.x.body, '');
  assert.equal(s.settings.repel, 180);
});

test('loadState backs up unreadable data instead of discarding it', () => {
  const mem = new Map([['graph-notes:v1', '{broken']]);
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const r = loadState(storage);
  assert.equal(r.state, null);
  assert.equal(mem.get(r.recoveredKey), '{broken');
});

test('seed data: every link resolves and is born after both its notes', () => {
  const s = createSeedState(Date.now());
  const titles = new Set(Object.values(s.notes).map((n) => n.title.toLowerCase()));
  for (const n of Object.values(s.notes)) {
    assert.ok(n.updatedAt >= n.createdAt, `${n.title} updated before created`);
    for (const t of parseLinkTitles(n.body)) assert.ok(titles.has(t.toLowerCase()), `unresolved [[${t}]] in ${n.title}`);
  }
  for (const l of computeLinks(s)) {
    const t = s.linkTimes[linkKey(l)];
    assert.ok(t >= s.notes[l.source].createdAt && t >= s.notes[l.target].createdAt);
  }
});

test('markdown escapes HTML and only renders http(s) links', () => {
  const html = renderMarkdown('<script>alert(1)</script> [x](javascript:alert(1)) [ok](https://a.b)');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('href="javascript'));
  assert.ok(html.includes('href="https://a.b"'));
});

test('markdown renders wikilinks with resolution state and aliases', () => {
  const html = renderMarkdown('[[Here]] [[Missing|label]] [[A & B]]', (t) => t === 'Here' || t === 'A & B');
  assert.match(html, /class="wikilink" data-target="Here">Here</);
  assert.match(html, /class="wikilink unresolved" data-target="Missing">label</);
  assert.match(html, /class="wikilink" data-target="A &amp; B"/);
});

test('markdown block structure', () => {
  const html = renderMarkdown('# T\n\n- [x] done\n- item\n\n1. one\n\n> q\n\n```\n<b>\n```');
  assert.match(html, /<h1>T<\/h1>/);
  assert.match(html, /<li class="task"><input type="checkbox" disabled checked> done<\/li>/);
  assert.match(html, /<ol><li>one<\/li><\/ol>/);
  assert.match(html, /<blockquote>q<\/blockquote>/);
  assert.match(html, /<pre><code>&lt;b&gt;<\/code><\/pre>/);
});
