import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../js/sim-core.js';

function settle(sim, max = 3000) {
  let t = 0;
  while (sim.running && t < max) {
    sim.tick();
    t++;
  }
  return t;
}

const dist = (s, a, b) => {
  const i = s.index.get(a);
  const j = s.index.get(b);
  return Math.hypot(s.x[i] - s.x[j], s.y[i] - s.y[j]);
};

function twoClusters() {
  const nodes = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}` }));
  const links = [];
  for (let i = 1; i < 10; i++) links.push(['n0', `n${i}`]);
  for (let i = 11; i < 20; i++) links.push(['n10', `n${i}`]);
  return { nodes, links };
}

test('settles without NaN and stops ticking', () => {
  const s = new Simulation();
  const { nodes, links } = twoClusters();
  s.setGraph(nodes, links);
  const ticks = settle(s);
  assert.ok(ticks < 3000, 'cools down');
  assert.equal(s.running, false);
  assert.ok(![...s.x, ...s.y].some(Number.isNaN));
});

test('linked nodes end up closer than unlinked ones', () => {
  const s = new Simulation();
  const { nodes, links } = twoClusters();
  s.setGraph(nodes, links);
  settle(s);
  const linked = links.map(([a, b]) => dist(s, a, b));
  const meanLinked = linked.reduce((a, b) => a + b) / linked.length;
  assert.ok(dist(s, 'n1', 'n15') > meanLinked * 2, 'separate clusters stay apart');
});

test('recency gravity: high-g nodes sit nearer the centre than low-g nodes', () => {
  const s = new Simulation();
  const nodes = Array.from({ length: 30 }, (_, i) => ({ id: i, g: i < 5 ? 3 : i >= 25 ? 0.25 : 1 }));
  s.setGraph(nodes, []);
  settle(s);
  const r = (i) => Math.hypot(s.x[i], s.y[i]);
  const fresh = [0, 1, 2, 3, 4].map(r);
  const stale = [25, 26, 27, 28, 29].map(r);
  assert.ok(Math.max(...fresh) < Math.min(...stale), `fresh ${fresh} vs stale ${stale}`);
});

test('pinned nodes stay put; unpinned nodes move again', () => {
  const s = new Simulation();
  const { nodes, links } = twoClusters();
  s.setGraph(nodes, links);
  s.pin('n3', 500, -200);
  settle(s);
  const i = s.index.get('n3');
  assert.equal(s.x[i], 500);
  assert.equal(s.y[i], -200);
  s.unpin('n3');
  s.reheat(0.5);
  settle(s);
  assert.notEqual(s.x[i], 500);
});

test('setGraph keeps existing positions and spawns new nodes near a neighbour', () => {
  const s = new Simulation();
  const { nodes, links } = twoClusters();
  s.setGraph(nodes, links);
  settle(s);
  const before = { x: s.x[s.index.get('n10')], y: s.y[s.index.get('n10')] };
  s.setGraph([...nodes, { id: 'new' }], [...links, ['new', 'n10']]);
  const j = s.index.get('n10');
  assert.equal(s.x[j], before.x);
  assert.equal(s.y[j], before.y);
  assert.ok(dist(s, 'new', 'n10') < s.params.linkDistance, 'spawned beside its neighbour');
});

test('a ghost (dragged) node does not push its drop target away', () => {
  const run = (ghost) => {
    const s = new Simulation({ centerStrength: 0 });
    s.setGraph([{ id: 'held' }, { id: 'target' }], []);
    s.pin('target', 0, 0);
    s.unpin('target');
    s.pin('held', 8, 0);
    s.setGhost(ghost ? 'held' : null);
    s.alphaTarget = 0.3;
    s.tick(30);
    return Math.hypot(s.x[1], s.y[1]);
  };
  assert.ok(run(true) < 0.01, 'target stays put while the held node is a ghost');
  assert.ok(run(false) > 5, 'without ghosting the target is pushed away');
});

test('ignores self-links, duplicates and links to unknown ids', () => {
  const s = new Simulation();
  s.setGraph([{ id: 'a' }, { id: 'b' }], [['a', 'a'], ['a', 'b'], ['b', 'a'], ['a', 'zzz']]);
  assert.equal(s.ls.length, 1);
  settle(s);
  assert.ok(![...s.x, ...s.y].some(Number.isNaN));
});

test('handles empty and single-node graphs', () => {
  const s = new Simulation();
  s.setGraph([], []);
  s.tick(5);
  s.setGraph([{ id: 'solo' }], []);
  settle(s);
  assert.ok(Number.isFinite(s.x[0]));
});
