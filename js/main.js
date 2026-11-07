import {
  DAY,
  computeLinks,
  createNote,
  findByTitle,
  linkKey,
  loadState,
  normalizeState,
  recency,
  renameInBodies,
  saveState,
  syncLinkTimes,
  touched,
  uniqueTitle,
} from './store.js';
import { createSeedState } from './seed.js';
import { renderMarkdown } from './markdown.js';
import { GraphView } from './graph-view.js';

const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'),
  list: $('noteList'),
  search: $('search'),
  newNote: $('newNote'),
  gravityOn: $('gravityOn'),
  halfLife: $('halfLife'),
  halfLifeVal: $('halfLifeVal'),
  linkDist: $('linkDist'),
  linkDistVal: $('linkDistVal'),
  repel: $('repel'),
  repelVal: $('repelVal'),
  exportBtn: $('exportBtn'),
  importFile: $('importFile'),
  resetBtn: $('resetBtn'),
  toggleSidebar: $('toggleSidebar'),
  fitBtn: $('fitBtn'),
  playBtn: $('playBtn'),
  timeSlider: $('timeSlider'),
  timeLabel: $('timeLabel'),
  exitReplay: $('exitReplay'),
  editorEmpty: $('editorEmpty'),
  editor: $('editor'),
  title: $('titleInput'),
  modeBtn: $('modeBtn'),
  deleteBtn: $('deleteBtn'),
  closeEditor: $('closeEditor'),
  meta: $('noteMeta'),
  body: $('bodyInput'),
  preview: $('preview'),
  suggest: $('suggest'),
  backlinks: $('backlinks'),
  toast: $('toast'),
};

// ---- state ----------------------------------------------------------------

const loaded = loadState();
let state = loaded.state ?? createSeedState(Date.now());
let links = computeLinks(state);
syncLinkTimes(state, links, Date.now());
let storageWarned = false;
let currentId = null;
let mode = 'edit';
let saveTimer = null;
const replay = { active: false, playing: false, t: 0, raf: 0, key: '', lastAttrs: 0, lastFit: 0 };

function save() {
  if (!saveState(state) && !storageWarned) {
    storageWarned = true;
    toast('Browser storage is unavailable, so changes will be lost when you close this tab. Use Export to keep a copy.', 7000);
  }
}
save();
if (loaded.recoveredKey) {
  toast(`Saved data couldn't be read. It was backed up in localStorage as "${loaded.recoveredKey}".`, 8000);
}

const cur = () => (currentId ? state.notes[currentId] : null);

// ---- graph ----------------------------------------------------------------

const graph = new GraphView($('graph'), {
  onSelect: (id) => openNote(id),
  onLink: linkNotes,
  onPin: (id, pinned) => toast(`${pinned ? 'Pinned' : 'Unpinned'} “${state.notes[id]?.title ?? ''}”`),
  onBackground: () => {
    if (matchMedia('(max-width: 900px)').matches) els.app.classList.remove('sidebar-open');
  },
});
graph.setParams({ linkDistance: state.settings.linkDistance, repel: state.settings.repel });

function visibleSet() {
  const t = replay.active ? replay.t : Infinity;
  const notes = Object.values(state.notes).filter((n) => n.createdAt <= t);
  const vis = new Set(notes.map((n) => n.id));
  const ls = links.filter(
    (l) => vis.has(l.source) && vis.has(l.target) && (state.linkTimes[linkKey(l)] ?? 0) <= t,
  );
  return { notes, ls };
}

function nodeAttrs(notes, ls) {
  const deg = new Map();
  for (const l of ls) {
    deg.set(l.source, (deg.get(l.source) || 0) + 1);
    deg.set(l.target, (deg.get(l.target) || 0) + 1);
  }
  const now = replay.active ? replay.t : Date.now();
  const { gravityOn, halfLifeDays } = state.settings;
  return notes.map((n) => {
    // During replay a note counts as "touched" when it was created, so new
    // ideas start central and drift outward as the timeline moves on.
    const rec = recency(replay.active ? n.createdAt : touched(n), now, halfLifeDays);
    return {
      id: n.id,
      title: n.title,
      r: 5 + 2.4 * Math.sqrt(deg.get(n.id) || 0),
      g: gravityOn ? 0.25 + 2.75 * rec : 1,
      rec,
    };
  });
}

function refreshGraph(reheat = 0.3) {
  const { notes, ls } = visibleSet();
  replay.key = `${notes.length}:${ls.length}`;
  graph.setGraph(
    nodeAttrs(notes, ls),
    ls.map((l) => [l.source, l.target]),
    reheat,
  );
}

function refreshAttrs(reheat = 0.15) {
  const { notes, ls } = visibleSet();
  graph.setAttrs(nodeAttrs(notes, ls), reheat);
}

function relinkAndSave(reheat = 0.3) {
  const before = links.map(linkKey).join('|');
  links = computeLinks(state);
  syncLinkTimes(state, links, Date.now());
  save();
  if (links.map(linkKey).join('|') !== before) refreshGraph(reheat);
  else refreshAttrs();
}

// ---- sidebar list -----------------------------------------------------------

function relTime(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 45) return `${d}d ago`;
  return `${Math.round(d / 30)}mo ago`;
}

function renderList() {
  const q = els.search.value.trim().toLowerCase();
  const now = Date.now();
  const notes = Object.values(state.notes)
    .filter((n) => !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q))
    .sort((a, b) => touched(b) - touched(a));
  if (!notes.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = q ? 'No matching notes' : 'No notes yet';
    els.list.replaceChildren(li);
    return;
  }
  els.list.replaceChildren(
    ...notes.map((n) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = `note-item${n.id === currentId ? ' active' : ''}`;
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = state.settings.gravityOn
        ? graph.recencyColor(recency(touched(n), now, state.settings.halfLifeDays))
        : 'var(--node)';
      const title = document.createElement('span');
      title.className = 'note-title';
      title.textContent = n.title;
      const time = document.createElement('span');
      time.className = 'note-time';
      time.textContent = relTime(now - touched(n));
      b.append(dot, title, time);
      b.addEventListener('click', () => {
        openNote(n.id);
        graph.focus(n.id);
        els.app.classList.remove('sidebar-open');
      });
      li.append(b);
      return li;
    }),
  );
}

// ---- editor -----------------------------------------------------------------

function openNote(id) {
  flushSave();
  const n = state.notes[id];
  if (!n) return;
  currentId = id;
  if (!replay.active) {
    n.openedAt = Date.now();
    save();
    refreshAttrs(0.1);
  }
  els.editorEmpty.hidden = true;
  els.editor.hidden = false;
  els.title.value = n.title;
  els.body.value = n.body;
  closeSuggest();
  renderEditorExtras();
  setMode(mode);
  graph.setSelected(id);
  els.app.classList.add('editor-open');
  renderList();
}

function closeEditor() {
  flushSave();
  currentId = null;
  els.editor.hidden = true;
  els.editorEmpty.hidden = false;
  graph.setSelected(null);
  els.app.classList.remove('editor-open');
  renderList();
}

function setMode(m) {
  mode = m;
  const preview = m === 'preview';
  els.preview.hidden = !preview;
  els.body.hidden = preview;
  els.modeBtn.textContent = preview ? 'Edit' : 'Preview';
  if (preview) {
    const n = cur();
    els.preview.innerHTML = n ? renderMarkdown(n.body, (t) => !!findByTitle(state, t)) : '';
  }
}

function renderEditorExtras() {
  const n = cur();
  if (!n) return;
  const out = links.filter((l) => l.source === n.id).length;
  const fmt = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  els.meta.textContent = `Created ${fmt(n.createdAt)} · edited ${relTime(Date.now() - n.updatedAt)} · ${out} outgoing link${out === 1 ? '' : 's'}`;
  const back = links.filter((l) => l.target === n.id).map((l) => state.notes[l.source]);
  if (!back.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No notes link here yet';
    els.backlinks.replaceChildren(li);
  } else {
    els.backlinks.replaceChildren(
      ...back.map((s) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.className = 'linkish';
        b.textContent = s.title;
        b.addEventListener('click', () => {
          openNote(s.id);
          graph.focus(s.id);
        });
        li.append(b);
        return li;
      }),
    );
  }
}

function commitBody() {
  saveTimer = null;
  relinkAndSave(0.3);
  renderList();
  renderEditorExtras();
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    commitBody();
  }
}

els.body.addEventListener('input', () => {
  const n = cur();
  if (!n || replay.active) return;
  n.body = els.body.value;
  n.updatedAt = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(commitBody, 350);
  updateSuggest();
});
els.body.addEventListener('click', updateSuggest);
els.body.addEventListener('blur', () => setTimeout(closeSuggest, 120));

function commitTitle() {
  const n = cur();
  if (!n || replay.active) return;
  const v = els.title.value.trim();
  if (v === n.title) return;
  if (!v || /[[\]|#]/.test(v)) {
    toast('Titles can’t be empty or contain [ ] | #');
    els.title.value = n.title;
    return;
  }
  const clash = findByTitle(state, v);
  if (clash && clash.id !== n.id) {
    toast(`A note called “${clash.title}” already exists`);
    els.title.value = n.title;
    return;
  }
  flushSave();
  const changed = renameInBodies(state, n.title, v);
  n.title = v;
  n.updatedAt = Date.now();
  if (currentId === n.id) els.body.value = n.body;
  relinkAndSave(0.2);
  refreshGraph(0.1); // labels changed
  renderList();
  renderEditorExtras();
  if (changed) toast(`Updated links in ${changed} note${changed === 1 ? '' : 's'}`);
}
els.title.addEventListener('blur', commitTitle);
els.title.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    els.title.blur();
    els.body.focus();
  } else if (e.key === 'Escape') {
    els.title.value = cur()?.title ?? '';
    els.title.blur();
  }
});

els.modeBtn.addEventListener('click', () => setMode(mode === 'edit' ? 'preview' : 'edit'));
els.closeEditor.addEventListener('click', closeEditor);
els.deleteBtn.addEventListener('click', () => {
  const n = cur();
  if (!n || replay.active) return;
  if (!confirm(`Delete “${n.title}”? Links to it will stay in other notes as unresolved text.`)) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  delete state.notes[n.id];
  closeEditor();
  relinkAndSave(0.4);
  refreshGraph(0.4);
  renderList();
  toast(`Deleted “${n.title}”`);
});

els.preview.addEventListener('click', (e) => {
  const a = e.target.closest('a.wikilink');
  if (!a) return;
  e.preventDefault();
  openOrCreate(a.dataset.target);
});

function openOrCreate(title) {
  const existing = findByTitle(state, title);
  if (existing) {
    openNote(existing.id);
    graph.focus(existing.id);
    return;
  }
  if (replay.active) return toast('Exit replay to create notes');
  const n = createNote(state, { title: title.trim() });
  relinkAndSave(0.4);
  refreshGraph(0.4);
  openNote(n.id);
  setMode('edit');
  els.body.focus();
}

function newNote() {
  if (replay.active) return toast('Exit replay to create notes');
  const n = createNote(state, { title: uniqueTitle(state, 'Untitled') });
  save();
  refreshGraph(0.4);
  openNote(n.id);
  setMode('edit');
  els.title.focus();
  els.title.select();
}
els.newNote.addEventListener('click', newNote);

// ---- [[ autocomplete ---------------------------------------------------------

const sug = { open: false, items: [], sel: 0, start: 0 };

function updateSuggest() {
  const ta = els.body;
  if (ta.readOnly) return closeSuggest();
  const before = ta.value.slice(0, ta.selectionStart);
  const m = /\[\[([^[\]\n|#]*)$/.exec(before);
  if (!m) return closeSuggest();
  const q = m[1].trim().toLowerCase();
  sug.start = ta.selectionStart - m[1].length;
  const items = Object.values(state.notes)
    .filter((n) => n.id !== currentId && n.title.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        (a.title.toLowerCase().startsWith(q) ? 0 : 1) - (b.title.toLowerCase().startsWith(q) ? 0 : 1) ||
        touched(b) - touched(a),
    )
    .slice(0, 6)
    .map((n) => ({ title: n.title }));
  if (q && !findByTitle(state, m[1])) items.push({ title: m[1].trim(), create: true });
  if (!items.length) return closeSuggest();
  sug.items = items;
  sug.sel = 0;
  sug.open = true;
  renderSuggest();
}

function renderSuggest() {
  els.suggest.hidden = false;
  els.suggest.replaceChildren(
    ...sug.items.map((it, i) => {
      const li = document.createElement('li');
      li.className = i === sug.sel ? 'sel' : '';
      li.textContent = it.create ? `Create “${it.title}”` : it.title;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pickSuggest(i);
      });
      return li;
    }),
  );
}

function closeSuggest() {
  sug.open = false;
  els.suggest.hidden = true;
}

function pickSuggest(i) {
  const it = sug.items[i];
  if (!it) return;
  if (it.create && !findByTitle(state, it.title)) createNote(state, { title: it.title });
  const ta = els.body;
  const pos = ta.selectionStart;
  const after = ta.value.slice(pos);
  const closing = after.startsWith(']]') ? '' : ']]';
  ta.value = ta.value.slice(0, sug.start) + it.title + closing + after;
  const caret = sug.start + it.title.length + 2;
  ta.setSelectionRange(caret, caret);
  closeSuggest();
  ta.dispatchEvent(new Event('input'));
  if (it.create) refreshGraph(0.3);
}

els.body.addEventListener('keydown', (e) => {
  if (!sug.open) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const d = e.key === 'ArrowDown' ? 1 : -1;
    sug.sel = (sug.sel + d + sug.items.length) % sug.items.length;
    renderSuggest();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    pickSuggest(sug.sel);
  } else if (e.key === 'Escape') {
    closeSuggest();
  }
});

// ---- drag-to-link -------------------------------------------------------------

function linkNotes(aId, bId) {
  if (replay.active) return toast('Exit replay to edit');
  const a = state.notes[aId];
  const b = state.notes[bId];
  if (!a || !b) return;
  if (links.some((l) => (l.source === aId && l.target === bId) || (l.source === bId && l.target === aId))) {
    return toast(`“${a.title}” and “${b.title}” are already linked`);
  }
  if (currentId === aId) flushSave();
  const ref = `[[${b.title}]]`;
  if (!a.body.trim()) {
    a.body = `Related: ${ref}\n`;
  } else {
    const lines = a.body.replace(/\s+$/, '').split('\n');
    const last = lines[lines.length - 1];
    if (/^Related:/.test(last)) lines[lines.length - 1] = `${last} ${ref}`;
    else lines.push('', `Related: ${ref}`);
    a.body = `${lines.join('\n')}\n`;
  }
  a.updatedAt = Date.now();
  if (currentId === aId) {
    els.body.value = a.body;
    if (mode === 'preview') setMode('preview');
  }
  relinkAndSave(0.4);
  renderList();
  renderEditorExtras();
  toast(`Linked “${a.title}” → “${b.title}”`);
}

// ---- time travel ------------------------------------------------------------

function timeBounds() {
  const t1 = Date.now();
  let t0 = t1;
  for (const n of Object.values(state.notes)) t0 = Math.min(t0, n.createdAt);
  if (t0 >= t1) t0 = t1 - DAY;
  return [t0 - (t1 - t0) * 0.01, t1];
}

function setReplayFraction(f) {
  const [t0, t1] = timeBounds();
  replay.t = t0 + f * (t1 - t0);
  els.timeLabel.textContent =
    f >= 1
      ? 'Now'
      : new Date(replay.t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const { notes, ls } = visibleSet();
  const key = `${notes.length}:${ls.length}`;
  const now = performance.now();
  if (key !== replay.key) {
    refreshGraph(0.35);
  } else if (now - replay.lastAttrs > 150) {
    replay.lastAttrs = now;
    refreshAttrs(0.06);
  }
  // Follow the growing graph with the camera, after new nodes have spread out a little.
  if (now - replay.lastFit > 500) {
    replay.lastFit = now;
    setTimeout(() => graph.autoFit(), 150);
  }
}

function setReadOnly(ro) {
  els.body.readOnly = ro;
  els.title.readOnly = ro;
  els.deleteBtn.disabled = ro;
  els.newNote.disabled = ro;
}

function enterReplay() {
  if (replay.active) return;
  flushSave();
  replay.active = true;
  els.app.classList.add('replaying');
  els.exitReplay.hidden = false;
  setReadOnly(true);
  closeSuggest();
}

function exitReplay() {
  stopPlay();
  replay.active = false;
  els.app.classList.remove('replaying');
  els.exitReplay.hidden = true;
  els.timeSlider.value = 1000;
  els.timeLabel.textContent = 'Now';
  setReadOnly(false);
  refreshGraph(0.3);
  setTimeout(() => graph.autoFit(), 600);
}

function stopPlay() {
  replay.playing = false;
  cancelAnimationFrame(replay.raf);
  els.playBtn.textContent = '▶ Replay';
}

function togglePlay() {
  if (replay.playing) return stopPlay();
  enterReplay();
  if (+els.timeSlider.value >= 1000) {
    els.timeSlider.value = 0;
    setReplayFraction(0);
  }
  replay.playing = true;
  els.playBtn.textContent = '❚❚ Pause';
  const DURATION = 15000;
  let last = performance.now();
  const step = (now) => {
    if (!replay.playing) return;
    let v = +els.timeSlider.value + ((now - last) / DURATION) * 1000;
    last = now;
    if (v >= 1000) {
      v = 1000;
      els.timeSlider.value = v;
      setReplayFraction(1);
      stopPlay();
      return;
    }
    els.timeSlider.value = v;
    setReplayFraction(v / 1000);
    replay.raf = requestAnimationFrame(step);
  };
  replay.raf = requestAnimationFrame(step);
}

els.playBtn.addEventListener('click', togglePlay);
els.exitReplay.addEventListener('click', exitReplay);
els.timeSlider.addEventListener('input', () => {
  stopPlay();
  enterReplay();
  setReplayFraction(+els.timeSlider.value / 1000);
});

// ---- settings, import/export ----------------------------------------------------

function syncSettingsUI() {
  const s = state.settings;
  els.gravityOn.checked = s.gravityOn;
  els.halfLife.value = s.halfLifeDays;
  els.halfLifeVal.textContent = `${s.halfLifeDays}d`;
  els.linkDist.value = s.linkDistance;
  els.linkDistVal.textContent = s.linkDistance;
  els.repel.value = s.repel;
  els.repelVal.textContent = s.repel;
  graph.setColorMode(s.gravityOn ? 'recency' : 'flat');
}

els.gravityOn.addEventListener('change', () => {
  state.settings.gravityOn = els.gravityOn.checked;
  save();
  syncSettingsUI();
  refreshAttrs(0.6);
  renderList();
});
els.halfLife.addEventListener('input', () => {
  state.settings.halfLifeDays = +els.halfLife.value;
  save();
  syncSettingsUI();
  refreshAttrs(0.4);
  renderList();
});
for (const [input, key] of [
  [els.linkDist, 'linkDistance'],
  [els.repel, 'repel'],
]) {
  input.addEventListener('input', () => {
    state.settings[key] = +input.value;
    save();
    syncSettingsUI();
    graph.setParams({ [key]: state.settings[key] });
  });
}

els.fitBtn.addEventListener('click', () => graph.fit());
els.toggleSidebar.addEventListener('click', () => els.app.classList.toggle('sidebar-open'));
els.search.addEventListener('input', renderList);

els.exportBtn.addEventListener('click', () => {
  flushSave();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `graph-notes-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

els.importFile.addEventListener('change', async () => {
  const file = els.importFile.files[0];
  els.importFile.value = '';
  if (!file) return;
  try {
    const next = normalizeState(JSON.parse(await file.text()));
    const count = Object.keys(next.notes).length;
    if (!confirm(`Replace your current notes with ${count} imported note${count === 1 ? '' : 's'}?`)) return;
    replaceState(next);
    toast(`Imported ${count} notes`);
  } catch (err) {
    toast(`Import failed: ${err.message}`);
  }
});

els.resetBtn.addEventListener('click', () => {
  if (!confirm('Replace all notes with the demo notes? Export first if you want to keep yours.')) return;
  replaceState(createSeedState(Date.now()));
});

function replaceState(next) {
  if (replay.active) exitReplay();
  clearTimeout(saveTimer);
  saveTimer = null;
  state = next;
  links = computeLinks(state);
  syncLinkTimes(state, links, Date.now());
  save();
  closeEditor();
  syncSettingsUI();
  graph.setParams({ linkDistance: state.settings.linkDistance, repel: state.settings.repel });
  graph.requestFit();
  refreshGraph(1);
  renderList();
}

// ---- toast ------------------------------------------------------------------------

let toastTimer = null;
function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

// ---- boot -------------------------------------------------------------------------

syncSettingsUI();
refreshGraph(1);
renderList();
if (matchMedia('(min-width: 901px)').matches) {
  const welcome = findByTitle(state, 'Welcome');
  if (welcome) {
    openNote(welcome.id);
    setMode('preview');
  }
}
// Handle for poking at the app from DevTools.
window.graphNotes = { graph, get state() { return state; }, get links() { return links; } };

// Recency keeps decaying while the app is open.
setInterval(() => {
  if (replay.active) return;
  refreshAttrs(0.05);
  renderList();
}, 60000);
