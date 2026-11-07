// Canvas renderer + interaction for the note graph. Physics runs in sim-worker.js;
// this file only draws positions it receives and forwards drags/pins.

const TAU = Math.PI * 2;
const DRAG_THRESHOLD = 4;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const easeOutBack = (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [128, 128, 128];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export class GraphView {
  // handlers: onSelect(id), onLink(sourceId, targetId), onPin(id, pinned), onBackground()
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.handlers = handlers;
    this.nodes = []; // [{ id, title, r, g, rec }]
    this.index = new Map();
    this.links = []; // [[i, j]]
    this.neighbors = [];
    this.pos = new Float32Array(0);
    this.version = 0;
    this.cam = { x: 0, y: 0, k: 1 };
    this.camTarget = null;
    this.needsFit = true;
    this.settleFit = false;
    this.userCamera = false;
    this.selectedId = null;
    this.hoverIdx = -1;
    this.pinned = new Set();
    this.drag = null;
    this.pan = null;
    this.pinch = null;
    this.pointers = new Map();
    this.born = new Map();
    this.colorMode = 'recency';
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.dirty = true;

    this.worker = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this._onWorker(e.data);

    this._readTheme();
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
      this._readTheme();
      this.dirty = true;
    });
    new ResizeObserver(() => this._resize()).observe(canvas);
    this._resize();

    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e, false));
    canvas.addEventListener('pointercancel', (e) => this._up(e, true));
    canvas.addEventListener('pointerleave', () => {
      if (!this.drag && !this.pan && this.hoverIdx !== -1) {
        this.hoverIdx = -1;
        this.dirty = true;
      }
    });
    canvas.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    canvas.addEventListener('dblclick', (e) => this._dbl(e));

    this._frame = this._frame.bind(this);
    requestAnimationFrame(this._frame);
  }

  // ---- data -------------------------------------------------------------

  setGraph(nodes, links, reheat = 0.3) {
    const now = performance.now();
    const prevIndex = this.index;
    const prevPos = this.pos;
    const hadNodes = this.nodes.length > 0;
    this.version++;
    const pos = new Float32Array(nodes.length * 2).fill(NaN);
    nodes.forEach((n, i) => {
      const j = prevIndex.get(n.id);
      if (j !== undefined) {
        pos[2 * i] = prevPos[2 * j];
        pos[2 * i + 1] = prevPos[2 * j + 1];
      } else if (hadNodes) {
        this.born.set(n.id, now);
      }
    });
    this.nodes = nodes;
    this.pos = pos;
    this.index = new Map(nodes.map((n, i) => [n.id, i]));
    this.links = [];
    this.neighbors = nodes.map(() => new Set());
    for (const [a, b] of links) {
      const i = this.index.get(a);
      const j = this.index.get(b);
      if (i === undefined || j === undefined || i === j) continue;
      this.links.push([i, j]);
      this.neighbors[i].add(j);
      this.neighbors[j].add(i);
    }
    for (const id of this.pinned) if (!this.index.has(id)) this.pinned.delete(id);
    if (this.hoverIdx >= nodes.length) this.hoverIdx = -1;
    this.worker.postMessage({
      type: 'graph',
      version: this.version,
      nodes: nodes.map((n) => ({ id: n.id, r: n.r, g: n.g })),
      links,
      reheat,
    });
    this.dirty = true;
  }

  // Same node set, new radius / gravity / recency.
  setAttrs(nodes, reheat = 0) {
    for (const nd of nodes) {
      const i = this.index.get(nd.id);
      if (i !== undefined) Object.assign(this.nodes[i], nd);
    }
    this.worker.postMessage({
      type: 'attrs',
      nodes: nodes.map((n) => ({ id: n.id, r: n.r, g: n.g })),
      reheat,
    });
    this.dirty = true;
  }

  setParams(params) {
    this.worker.postMessage({ type: 'params', params });
  }

  setSelected(id) {
    this.selectedId = id;
    this.dirty = true;
  }

  setColorMode(mode) {
    this.colorMode = mode;
    this.dirty = true;
  }

  recencyColor(rec) {
    const [r, g, b] = this._lerpRgb(rec);
    return `rgb(${r},${g},${b})`;
  }

  fit() {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const x = this.pos[2 * i];
      const y = this.pos[2 * i + 1];
      if (x !== x) continue;
      const r = this.nodes[i].r;
      x0 = Math.min(x0, x - r);
      x1 = Math.max(x1, x + r);
      y0 = Math.min(y0, y - r);
      y1 = Math.max(y1, y + r);
    }
    if (!Number.isFinite(x0)) return;
    const pad = 48;
    const usableH = this.height - pad * 2 - 64; // room for the timeline bar
    const k = clamp(
      Math.min((this.width - pad * 2) / Math.max(1, x1 - x0), usableH / Math.max(1, y1 - y0)),
      0.12,
      1.6,
    );
    this.camTarget = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 + 32 / k, k };
  }

  focus(id) {
    const i = this.index.get(id);
    if (i === undefined) return;
    const x = this.pos[2 * i];
    if (x !== x) return;
    this.camTarget = { x, y: this.pos[2 * i + 1], k: Math.max(this.cam.k, 0.9) };
  }

  // ---- worker / frame ---------------------------------------------------

  _onWorker(m) {
    if (m.type !== 'tick' || m.version !== this.version) return;
    this.pos = m.pos;
    if (this.drag?.moved) {
      const i = this.index.get(this.drag.id);
      if (i !== undefined) {
        this.pos[2 * i] = this.drag.x;
        this.pos[2 * i + 1] = this.drag.y;
      }
    }
    this.dirty = true;
    // Fit once early so something sensible is on screen, then again when the
    // layout has settled, unless the user has taken over the camera.
    if (this.needsFit && this.nodes.length && m.alpha < 0.35) {
      this.needsFit = false;
      this.settleFit = true;
      this.fit();
    } else if (this.settleFit && m.alpha < 0.03) {
      this.settleFit = false;
      if (!this.userCamera) this.fit();
    }
  }

  // Re-frame the graph unless the user has panned/zoomed manually.
  autoFit() {
    if (!this.userCamera) this.fit();
  }

  requestFit() {
    this.needsFit = true;
    this.userCamera = false;
  }

  _frame(now) {
    requestAnimationFrame(this._frame);
    const t = this.camTarget;
    if (t) {
      const c = this.cam;
      c.x += (t.x - c.x) * 0.18;
      c.y += (t.y - c.y) * 0.18;
      c.k *= Math.pow(t.k / c.k, 0.18);
      if (Math.abs(t.x - c.x) < 0.3 && Math.abs(t.y - c.y) < 0.3 && Math.abs(Math.log(t.k / c.k)) < 0.002) {
        Object.assign(c, t);
        this.camTarget = null;
      }
      this.dirty = true;
    }
    if (this.born.size) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this._draw(now);
  }

  _readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name) => cs.getPropertyValue(name).trim();
    this.theme = {
      bg: v('--graph-bg'),
      edge: v('--edge'),
      accent: v('--accent'),
      text: v('--text'),
      node: hexToRgb(v('--node')),
      hot: hexToRgb(v('--node-hot')),
      cold: hexToRgb(v('--node-cold')),
    };
  }

  _lerpRgb(t) {
    const { cold, hot } = this.theme;
    return [0, 1, 2].map((c) => Math.round(cold[c] + (hot[c] - cold[c]) * t));
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.dirty = true;
  }

  _draw(now) {
    const { ctx, cam, theme } = this;
    const W = this.width;
    const H = this.height;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, W, H);
    const n = this.nodes.length;
    if (!n) return;

    const k = cam.k;
    const pos = this.pos;
    ctx.translate(W / 2, H / 2);
    ctx.scale(k, k);
    ctx.translate(-cam.x, -cam.y);

    const focus = this.drag ? (this.index.get(this.drag.id) ?? -1) : this.hoverIdx;
    const nb = focus >= 0 ? this.neighbors[focus] : null;
    const target = this.drag?.targetId != null ? this.index.get(this.drag.targetId) : undefined;
    const valid = (i) => pos[2 * i] === pos[2 * i];

    // links
    ctx.lineWidth = 1.1 / k;
    ctx.strokeStyle = theme.edge;
    ctx.globalAlpha = focus >= 0 ? 0.18 : 0.55;
    ctx.beginPath();
    for (const [i, j] of this.links) {
      if (!valid(i) || !valid(j) || i === focus || j === focus) continue;
      ctx.moveTo(pos[2 * i], pos[2 * i + 1]);
      ctx.lineTo(pos[2 * j], pos[2 * j + 1]);
    }
    ctx.stroke();
    if (focus >= 0) {
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1.6 / k;
      ctx.beginPath();
      for (const [i, j] of this.links) {
        if ((i !== focus && j !== focus) || !valid(i) || !valid(j)) continue;
        ctx.moveTo(pos[2 * i], pos[2 * i + 1]);
        ctx.lineTo(pos[2 * j], pos[2 * j + 1]);
      }
      ctx.stroke();
    }

    // drag-to-link preview
    if (focus >= 0 && target !== undefined && valid(target)) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 2 / k;
      ctx.setLineDash([6 / k, 5 / k]);
      ctx.beginPath();
      ctx.moveTo(pos[2 * focus], pos[2 * focus + 1]);
      ctx.lineTo(pos[2 * target], pos[2 * target + 1]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // nodes
    const scale = new Float32Array(n).fill(1);
    for (let i = 0; i < n; i++) {
      if (!valid(i)) continue;
      const nd = this.nodes[i];
      const born = this.born.get(nd.id);
      if (born !== undefined) {
        const t = (now - born) / 450;
        if (t >= 1) this.born.delete(nd.id);
        else scale[i] = Math.max(0, easeOutBack(t));
      }
      const x = pos[2 * i];
      const y = pos[2 * i + 1];
      const r = nd.r * scale[i];
      const dim = focus >= 0 && i !== focus && !nb.has(i) && i !== target;
      const [cr, cg, cb] = this.colorMode === 'recency' ? this._lerpRgb(nd.rec) : theme.node;
      ctx.globalAlpha = dim ? 0.2 : this.colorMode === 'recency' ? 0.55 + 0.45 * nd.rec : 0.95;
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
      if (this.pinned.has(nd.id)) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = theme.bg;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1.5, nd.r * 0.35) * scale[i], 0, TAU);
        ctx.fill();
      }
      if (nd.id === this.selectedId || i === target) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 2.2 / k;
        ctx.beginPath();
        ctx.arc(x, y, r + 4 / k, 0, TAU);
        ctx.stroke();
      }
    }

    // labels: constant 12px on screen
    ctx.font = `${12 / k}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3 / k;
    ctx.strokeStyle = theme.bg;
    ctx.fillStyle = theme.text;
    const zoomAlpha = clamp((k - 0.55) / 0.35, 0, 1);
    const hubAlpha = clamp((k - 0.3) / 0.3, 0, 1);
    for (let i = 0; i < n; i++) {
      if (!valid(i)) continue;
      const nd = this.nodes[i];
      const important = i === focus || nb?.has(i) || nd.id === this.selectedId || i === target;
      let a = important ? 1 : nd.r > 10 ? Math.max(zoomAlpha, hubAlpha) : zoomAlpha;
      if (focus >= 0 && !important) a *= 0.3;
      if (a <= 0.02) continue;
      ctx.globalAlpha = a * scale[i];
      const label = truncate(nd.title, 28);
      const ly = pos[2 * i + 1] + nd.r * scale[i] + 4 / k;
      ctx.strokeText(label, pos[2 * i], ly);
      ctx.fillText(label, pos[2 * i], ly);
    }
    ctx.globalAlpha = 1;
  }

  // ---- interaction ------------------------------------------------------

  _toWorld(sx, sy) {
    return {
      x: (sx - this.width / 2) / this.cam.k + this.cam.x,
      y: (sy - this.height / 2) / this.cam.k + this.cam.y,
    };
  }

  // slop: extra screen-pixel reach (used for drop targets).
  _hit(sx, sy, exclude = -1, slop = 0) {
    const w = this._toWorld(sx, sy);
    const k = this.cam.k;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      if (i === exclude) continue;
      const x = this.pos[2 * i];
      if (x !== x) continue;
      const d = Math.hypot(x - w.x, this.pos[2 * i + 1] - w.y);
      const reach = Math.max(this.nodes[i].r, 7 / k) + (3 + slop) / k;
      if (d <= reach && d < bestD) {
        best = i;
        bestD = d;
      }
    }
    return best;
  }

  _down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pointers.size === 2) {
      this._cancelDrag();
      this.pan = null;
      const [a, b] = [...this.pointers.values()];
      this.pinch = {
        d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        k: this.cam.k,
        world: this._toWorld((a.x + b.x) / 2, (a.y + b.y) / 2),
      };
      this.camTarget = null;
      return;
    }
    if (this.pointers.size > 2) return;
    const i = this._hit(e.offsetX, e.offsetY);
    if (i >= 0) {
      const w = this._toWorld(e.offsetX, e.offsetY);
      this.drag = {
        id: this.nodes[i].id,
        sx: e.offsetX,
        sy: e.offsetY,
        ox: this.pos[2 * i] - w.x,
        oy: this.pos[2 * i + 1] - w.y,
        x: this.pos[2 * i],
        y: this.pos[2 * i + 1],
        moved: false,
        targetId: null,
      };
      this.hoverIdx = i;
    } else {
      this.pan = { sx: e.offsetX, sy: e.offsetY, cx: this.cam.x, cy: this.cam.y, moved: false };
    }
    this.dirty = true;
  }

  _move(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });

    if (this.pinch) {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const k = clamp((this.pinch.k * (Math.hypot(a.x - b.x, a.y - b.y) || 1)) / this.pinch.d, 0.08, 6);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      this.cam.k = k;
      this.cam.x = this.pinch.world.x - (mx - this.width / 2) / k;
      this.cam.y = this.pinch.world.y - (my - this.height / 2) / k;
      this.userCamera = true;
      this.dirty = true;
      return;
    }

    const d = this.drag;
    if (d) {
      if (!d.moved) {
        if (Math.hypot(e.offsetX - d.sx, e.offsetY - d.sy) < DRAG_THRESHOLD) return;
        d.moved = true;
        this.worker.postMessage({ type: 'drag', on: true, id: d.id });
        this.canvas.style.cursor = 'grabbing';
      }
      const i = this.index.get(d.id);
      if (i === undefined) {
        this.drag = null;
        return;
      }
      const w = this._toWorld(e.offsetX, e.offsetY);
      d.x = w.x + d.ox;
      d.y = w.y + d.oy;
      this.pos[2 * i] = d.x;
      this.pos[2 * i + 1] = d.y;
      this.worker.postMessage({ type: 'pin', id: d.id, x: d.x, y: d.y });
      const t = this._hit(e.offsetX, e.offsetY, i, 10);
      d.targetId = t >= 0 ? this.nodes[t].id : null;
      this.dirty = true;
      return;
    }

    if (this.pan) {
      const dx = e.offsetX - this.pan.sx;
      const dy = e.offsetY - this.pan.sy;
      if (!this.pan.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      this.pan.moved = true;
      this.cam.x = this.pan.cx - dx / this.cam.k;
      this.cam.y = this.pan.cy - dy / this.cam.k;
      this.camTarget = null;
      this.userCamera = true;
      this.canvas.style.cursor = 'grabbing';
      this.dirty = true;
      return;
    }

    if (e.pointerType === 'mouse') {
      const i = this._hit(e.offsetX, e.offsetY);
      if (i !== this.hoverIdx) {
        this.hoverIdx = i;
        this.canvas.style.cursor = i >= 0 ? 'pointer' : 'default';
        this.dirty = true;
      }
    }
  }

  _up(e, cancelled) {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }
    const d = this.drag;
    if (d) {
      this.drag = null;
      this.canvas.style.cursor = 'pointer';
      if (!d.moved) {
        if (!cancelled) this.handlers.onSelect?.(d.id);
      } else {
        this.worker.postMessage({ type: 'drag', on: false });
        if (!this.pinned.has(d.id)) this.worker.postMessage({ type: 'unpin', id: d.id });
        if (d.targetId && !cancelled) this.handlers.onLink?.(d.id, d.targetId);
      }
      if (e.pointerType !== 'mouse') this.hoverIdx = -1;
      this.dirty = true;
      return;
    }
    if (this.pan) {
      const moved = this.pan.moved;
      this.pan = null;
      this.canvas.style.cursor = 'default';
      if (!moved && !cancelled) this.handlers.onBackground?.();
    }
  }

  _cancelDrag() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.moved) {
      this.worker.postMessage({ type: 'drag', on: false });
      if (!this.pinned.has(d.id)) this.worker.postMessage({ type: 'unpin', id: d.id });
    }
  }

  _dbl(e) {
    const i = this._hit(e.offsetX, e.offsetY);
    if (i < 0) return;
    const id = this.nodes[i].id;
    if (this.pinned.has(id)) {
      this.pinned.delete(id);
      this.worker.postMessage({ type: 'unpin', id });
      this.handlers.onPin?.(id, false);
    } else {
      this.pinned.add(id);
      this.worker.postMessage({ type: 'pin', id, x: this.pos[2 * i], y: this.pos[2 * i + 1] });
      this.handlers.onPin?.(id, true);
    }
    this.dirty = true;
  }

  _wheel(e) {
    e.preventDefault();
    const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    const k = clamp(this.cam.k * f, 0.08, 6);
    const w = this._toWorld(e.offsetX, e.offsetY);
    this.cam.k = k;
    this.cam.x = w.x - (e.offsetX - this.width / 2) / k;
    this.cam.y = w.y - (e.offsetY - this.height / 2) / k;
    this.camTarget = null;
    this.userCamera = true;
    this.dirty = true;
  }
}
