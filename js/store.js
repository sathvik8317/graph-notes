// Notes data model, [[wikilink]] parsing, and persistence.
// Pure functions over a plain state object, so they can be tested in Node.

export const DAY = 86400000;
const KEY = 'graph-notes:v1';

export const DEFAULT_SETTINGS = {
  gravityOn: true,
  halfLifeDays: 14,
  linkDistance: 60,
  repel: 180,
};

// [[Title]], [[Title#Heading]], [[Title|alias]], [[Title#Heading|alias]]
const WIKILINK = /\[\[([^[\]|#\n]+)(?:#[^[\]|\n]*)?(?:\|[^[\]\n]*)?\]\]/g;

export function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// Links inside ``` fences or `inline code` are text, not links.
function stripCode(body) {
  return body.replace(/^```[\s\S]*?(?:^```|$(?![\s\S]))/gm, '').replace(/`[^`\n]+`/g, '');
}

export function parseLinkTitles(body) {
  const out = [];
  for (const m of stripCode(body).matchAll(WIKILINK)) {
    const t = m[1].trim();
    if (t) out.push(t);
  }
  return out;
}

export function findByTitle(state, title) {
  const t = title.trim().toLowerCase();
  for (const n of Object.values(state.notes)) if (n.title.toLowerCase() === t) return n;
  return null;
}

export function uniqueTitle(state, base) {
  if (!findByTitle(state, base)) return base;
  for (let i = 2; ; i++) if (!findByTitle(state, `${base} ${i}`)) return `${base} ${i}`;
}

export function createNote(state, { title, body = '', now = Date.now() }) {
  const note = { id: newId(), title, body, createdAt: now, updatedAt: now, openedAt: 0 };
  state.notes[note.id] = note;
  return note;
}

// Resolved links between existing notes: [{ source, target }], deduplicated, no self-links.
export function computeLinks(state) {
  const byTitle = new Map();
  for (const n of Object.values(state.notes)) {
    const k = n.title.toLowerCase();
    if (!byTitle.has(k)) byTitle.set(k, n.id);
  }
  const seen = new Set();
  const links = [];
  for (const n of Object.values(state.notes)) {
    for (const t of parseLinkTitles(n.body)) {
      const target = byTitle.get(t.toLowerCase());
      if (!target || target === n.id) continue;
      const key = `${n.id}>${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: n.id, target });
    }
  }
  return links;
}

export const linkKey = (l) => `${l.source}>${l.target}`;

// Record when each link first appeared (drives time-travel replay).
export function syncLinkTimes(state, links, now) {
  const keep = new Set();
  for (const l of links) {
    const k = linkKey(l);
    keep.add(k);
    if (!(k in state.linkTimes)) state.linkTimes[k] = now;
  }
  for (const k of Object.keys(state.linkTimes)) if (!keep.has(k)) delete state.linkTimes[k];
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Rewrite [[Old]] → [[New]] everywhere, keeping #heading and |alias suffixes.
// Returns the number of notes changed.
export function renameInBodies(state, oldTitle, newTitle, now = Date.now()) {
  const re = new RegExp(
    `\\[\\[\\s*${escapeRegExp(oldTitle)}\\s*((?:#[^\\[\\]|\\n]*)?(?:\\|[^\\[\\]\\n]*)?)\\]\\]`,
    'gi',
  );
  let changed = 0;
  for (const n of Object.values(state.notes)) {
    const next = n.body.replace(re, (_, suffix) => `[[${newTitle}${suffix}]]`);
    if (next !== n.body) {
      n.body = next;
      n.updatedAt = now;
      changed++;
    }
  }
  return changed;
}

export const touched = (n) => Math.max(n.updatedAt, n.openedAt || 0);

// 1 = touched just now, 0.5 after one half-life, approaching 0 beyond that.
export function recency(touchedAt, now, halfLifeDays) {
  const age = Math.max(0, now - touchedAt);
  return Math.pow(0.5, age / (halfLifeDays * DAY));
}

export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || !raw.notes || typeof raw.notes !== 'object') {
    throw new Error('This file is not a Graph Notes export.');
  }
  const notes = {};
  for (const n of Object.values(raw.notes)) {
    if (!n || typeof n.id !== 'string' || typeof n.title !== 'string') continue;
    const createdAt = Number.isFinite(n.createdAt) ? n.createdAt : Date.now();
    notes[n.id] = {
      id: n.id,
      title: n.title,
      body: typeof n.body === 'string' ? n.body : '',
      createdAt,
      updatedAt: Number.isFinite(n.updatedAt) ? n.updatedAt : createdAt,
      openedAt: Number.isFinite(n.openedAt) ? n.openedAt : 0,
    };
  }
  const linkTimes = {};
  if (raw.linkTimes && typeof raw.linkTimes === 'object') {
    for (const [k, v] of Object.entries(raw.linkTimes)) if (Number.isFinite(v)) linkTimes[k] = v;
  }
  const settings = { ...DEFAULT_SETTINGS };
  const rs = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  if (typeof rs.gravityOn === 'boolean') settings.gravityOn = rs.gravityOn;
  for (const k of ['halfLifeDays', 'linkDistance', 'repel']) {
    if (Number.isFinite(rs[k]) && rs[k] > 0) settings[k] = rs[k];
  }
  return { version: 1, notes, linkTimes, settings };
}

// Returns { state | null, recoveredKey? }. Unreadable data is backed up, never discarded.
export function loadState(storage = globalThis.localStorage) {
  let raw;
  try {
    raw = storage.getItem(KEY);
  } catch {
    return { state: null };
  }
  if (!raw) return { state: null };
  try {
    return { state: normalizeState(JSON.parse(raw)) };
  } catch {
    const backup = `${KEY}:unreadable-${Date.now()}`;
    try {
      storage.setItem(backup, raw);
    } catch {
      /* ignore */
    }
    return { state: null, recoveredKey: backup };
  }
}

export function saveState(state, storage = globalThis.localStorage) {
  try {
    storage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
