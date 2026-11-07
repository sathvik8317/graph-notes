// Demo notes for first launch. Timestamps are spread over ~4 months so that
// recency gravity and time-travel replay have something to show.
import { DAY, DEFAULT_SETTINGS, computeLinks, linkKey, newId } from './store.js';

// [title, createdDaysAgo, updatedDaysAgo, body]
const NOTES = [
  ['Welcome', 120, 0, `# Welcome to Graph Notes
Your notes live inside a physics simulation. Three things make it different:

- **[[Recency gravity]]**: notes you touch drift to the centre; forgotten ones float to the edge.
- **[[Drag to link]]**: drop one note onto another in the graph to connect them.
- **[[Time travel]]**: press Replay to watch your graph grow.

Write in [[Markdown basics]] and link anything with double square brackets.`],
  ['Recency gravity', 118, 1, `Every note feels a pull toward the centre. The pull is strongest for notes you edited or opened recently, and it halves every *half-life* (adjust it in Graph settings).

Stale notes still repel their neighbours, so they drift outward. The edge of the graph is your [[Forgetting curve]] made visible. Warm colours mean recent, cool colours mean stale.

Built on a [[Force-directed layouts|force-directed layout]].`],
  ['Drag to link', 118, 2, `Grab a note in the graph and drop it onto another one. A dashed line previews the link, and on release a \`[[link]]\` is appended to the dragged note.

Double-click a note to pin it in place. Pinned notes show a hollow centre.`],
  ['Time travel', 117, 3, `Press **Replay** at the bottom of the graph, or scrub the slider. Notes appear on the day they were created, and links snap in when they were first written.

Each link's first appearance is recorded when you save, so replay works for your own notes too. See [[Recency gravity]].`],
  ['Markdown basics', 117, 40, `## Formatting
**bold**, *italic*, ~~strike~~, \`inline code\`

- Lists
- [ ] Tasks
- [x] Done tasks

> Quotes

Links: [[Welcome]], [[Welcome|with an alias]], and external [links](https://example.com).`],
  ['Force-directed layouts', 90, 10, `Nodes repel like charges, links pull like springs, and the system cools until it settles.

Key ingredients: [[Spring physics]] for links, [[Barnes–Hut approximation]] for repulsion, and a [[Quadtrees|quadtree]] to make it fast.`],
  ['Barnes–Hut approximation', 88, 12, `Treat a distant cluster of bodies as a single body at its centre of mass. That turns an O(n²) many-body problem into roughly O(n log n).

The cell-size-to-distance ratio θ trades accuracy for speed. This app uses θ = 0.9. Built on [[Quadtrees]].`],
  ['Quadtrees', 87, 30, `Recursively split 2D space into four quadrants until each cell holds one point. Each internal cell stores aggregate data (mass, centre) for [[Barnes–Hut approximation|Barnes–Hut]].`],
  ['Spring physics', 85, 25, `Hooke's law: force is proportional to displacement from the rest length. In the graph, every link is a spring with rest length = link distance.

Integrated with damped velocity steps, a cousin of [[Verlet integration]].`],
  ['Verlet integration', 80, 60, `A numerical integrator that is stable for physics simulations because it implicitly tracks velocity from positions. Popular in games and cloth simulation.`],
  ['Zettelkasten', 70, 4, `Niklas Luhmann's slip-box: small atomic notes, densely linked. Value comes from the connections, not the individual notes.

Related: [[Evergreen notes]], [[Spaced repetition]]`],
  ['Evergreen notes', 68, 5, `Notes written to evolve and accumulate over time, across projects. Concept-oriented, densely linked, written for yourself. See [[Zettelkasten]].`],
  ['Spaced repetition', 60, 6, `Review material at increasing intervals, just before you'd forget it. It fights the [[Forgetting curve]].`],
  ['Forgetting curve', 58, 8, `Ebbinghaus (1885): memory retention decays roughly exponentially without review. That is the same shape as the decay in [[Recency gravity]].`],
  ['Sourdough starter', 100, 95, `Flour + water, fed daily. Wild yeast and lactobacilli do the work. A good example of [[Fermentation]].

- [x] Day 1–5: feed every 24h
- [ ] Try a rye starter`],
  ['Fermentation', 99, 94, `Microbes converting sugars into acids, gases or alcohol. Examples: [[Kimchi]], [[Sourdough starter]].`],
  ['Kimchi', 97, 96, `Napa cabbage, gochugaru, garlic, ginger, fish sauce. Salt, rinse, pack, wait 2–5 days.`],
  ['Maillard reaction', 96, 93, `Amino acids + reducing sugars + heat produce browning and flavour. Why seared food tastes good. Needs a dry, hot surface: see [[Cast iron care]].`],
  ['Cast iron care', 95, 92, `Dry immediately, thin coat of oil, heat to polymerise. Avoid long soaks.`],
  ['Weekend projects', 40, 2, `- [[Bird feeder camera]]
- [[Balcony herb garden]]
- Build a graph view, now done (see [[Force-directed layouts]])`],
  ['Bird feeder camera', 38, 2, `Raspberry Pi + camera module + motion detection. Upload clips and tag species automatically?`],
  ['Balcony herb garden', 35, 14, `Basil, mint, chives, coriander. Chives and coriander go into [[Kimchi]] experiments.`],
  ['Reading list', 30, 1, `- [[How to Take Smart Notes]]
- Thinking in Systems
- The Art of Doing Science and Engineering`],
  ['How to Take Smart Notes', 28, 1, `Sönke Ahrens' book on the [[Zettelkasten]] method. Main idea: writing is the thinking, and notes are the building blocks. Pairs well with [[Evergreen notes]].`],
  ['Ideas inbox', 5, 0, `Unsorted thoughts go here first.

- Graph view that shows what I'm actively thinking about → [[Recency gravity]]
- More [[Weekend projects]]
- Finish the [[Reading list]]`],
  ['Unlinked thought', 20, 18, `A note with no links yet. Try dragging it onto another note in the graph.`],
];

export function createSeedState(now = Date.now()) {
  const state = { version: 1, notes: {}, linkTimes: {}, settings: { ...DEFAULT_SETTINGS } };
  for (const [title, created, updated, body] of NOTES) {
    const id = newId();
    state.notes[id] = {
      id,
      title,
      body,
      createdAt: now - created * DAY,
      updatedAt: now - updated * DAY,
      openedAt: 0,
    };
  }
  // A link is "born" shortly after the later of its two notes.
  for (const l of computeLinks(state)) {
    const a = state.notes[l.source].createdAt;
    const b = state.notes[l.target].createdAt;
    state.linkTimes[linkKey(l)] = Math.max(a, b) + DAY * 0.1;
  }
  return state;
}
