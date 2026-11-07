// Force-directed layout engine, written from scratch in the style of d3-force.
//
// Forces per tick:
//   - link springs (strength 1/min(degree), biased toward the less-connected end)
//   - many-body repulsion, approximated with a Barnes–Hut quadtree
//   - per-node gravity toward the origin (drives "recency gravity")
//   - collision, using a uniform spatial grid
// Integration: velocity damping, then position += velocity. Pinned nodes hold
// their fixed position.
//
// Pure module with no DOM access, so it runs in a Web Worker and in Node tests.

const TAU = Math.PI * 2;

export const DEFAULT_PARAMS = {
  linkDistance: 60,
  linkStrength: 1,
  repel: 180, // many-body strength magnitude; charge = -repel
  centerStrength: 0.04, // base gravity, multiplied by each node's g
  collidePadding: 3,
  collideStrength: 0.7,
  velocityDecay: 0.4,
  theta: 0.9,
  distanceMin: 4,
  distanceMax: Infinity,
  alphaMin: 0.001,
  alphaDecay: 1 - Math.pow(0.001, 1 / 300),
};

export class Simulation {
  constructor(params = {}) {
    this.params = { ...DEFAULT_PARAMS, ...params };
    this.alpha = 1;
    this.alphaTarget = 0;
    this.n = 0;
    this.ids = [];
    this.index = new Map();
    this.x = new Float64Array(0);
    this.y = new Float64Array(0);
    this.vx = new Float64Array(0);
    this.vy = new Float64Array(0);
    this.fx = new Float64Array(0);
    this.fy = new Float64Array(0);
    this.r = new Float64Array(0);
    this.g = new Float64Array(0);
    this.deg = new Float64Array(0);
    this.ls = new Int32Array(0);
    this.lt = new Int32Array(0);
    this.lbias = new Float64Array(0);
    this.lstr = new Float64Array(0);
    this._seed = 1;
  }

  // Deterministic LCG so layouts are reproducible.
  _rand() {
    this._seed = (1664525 * this._seed + 1013904223) % 4294967296;
    return this._seed / 4294967296;
  }

  _jiggle() {
    return (this._rand() - 0.5) * 1e-6;
  }

  get running() {
    return this.alpha >= this.params.alphaMin;
  }

  reheat(alpha) {
    if (alpha > this.alpha) this.alpha = alpha;
  }

  setParams(params) {
    Object.assign(this.params, params);
    this._recomputeLinkStrength();
  }

  // nodes: [{ id, r?, g? }]   links: [[sourceId, targetId], ...]
  // Existing ids keep their position and velocity. New nodes spawn beside an
  // already-placed neighbour, or on a phyllotaxis spiral if they have none.
  setGraph(nodes, links) {
    const old = {
      index: this.index, x: this.x, y: this.y, vx: this.vx, vy: this.vy, fx: this.fx, fy: this.fy,
    };
    const n = nodes.length;
    this.n = n;
    this.ids = nodes.map((d) => d.id);
    this.index = new Map(this.ids.map((id, i) => [id, i]));
    const x = (this.x = new Float64Array(n));
    const y = (this.y = new Float64Array(n));
    const vx = (this.vx = new Float64Array(n));
    const vy = (this.vy = new Float64Array(n));
    const fx = (this.fx = new Float64Array(n).fill(NaN));
    const fy = (this.fy = new Float64Array(n).fill(NaN));
    this.r = new Float64Array(n);
    this.g = new Float64Array(n);
    const deg = (this.deg = new Float64Array(n));
    for (let i = 0; i < n; i++) {
      this.r[i] = nodes[i].r ?? 6;
      this.g[i] = nodes[i].g ?? 1;
    }

    const seen = new Set();
    const src = [];
    const tgt = [];
    for (const [a, b] of links) {
      const i = this.index.get(a);
      const j = this.index.get(b);
      if (i === undefined || j === undefined || i === j) continue;
      const key = i < j ? i * n + j : j * n + i;
      if (seen.has(key)) continue;
      seen.add(key);
      src.push(i);
      tgt.push(j);
      deg[i]++;
      deg[j]++;
    }
    this.ls = Int32Array.from(src);
    this.lt = Int32Array.from(tgt);
    this._recomputeLinkStrength();

    const placed = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = old.index.get(this.ids[i]);
      if (o === undefined) continue;
      x[i] = old.x[o];
      y[i] = old.y[o];
      vx[i] = old.vx[o];
      vy[i] = old.vy[o];
      fx[i] = old.fx[o];
      fy[i] = old.fy[o];
      placed[i] = 1;
    }

    const adj = Array.from({ length: n }, () => []);
    for (let l = 0; l < src.length; l++) {
      adj[src[l]].push(tgt[l]);
      adj[tgt[l]].push(src[l]);
    }
    const spawn = this.params.linkDistance * 0.6;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < n; i++) {
        if (placed[i]) continue;
        const j = adj[i].find((k) => placed[k]);
        if (j === undefined) continue;
        const a = this._rand() * TAU;
        x[i] = x[j] + Math.cos(a) * spawn;
        y[i] = y[j] + Math.sin(a) * spawn;
        placed[i] = 1;
      }
    }
    let ring = 0;
    for (let i = 0; i < n; i++) {
      if (placed[i]) continue;
      const rad = 12 * Math.sqrt(0.5 + ring);
      const ang = ring * Math.PI * (3 - Math.sqrt(5));
      ring++;
      x[i] = rad * Math.cos(ang);
      y[i] = rad * Math.sin(ang);
    }
  }

  // Update radius / gravity without touching topology or positions.
  setAttrs(nodes) {
    for (const nd of nodes) {
      const i = this.index.get(nd.id);
      if (i === undefined) continue;
      if (nd.r != null) this.r[i] = nd.r;
      if (nd.g != null) this.g[i] = nd.g;
    }
  }

  pin(id, px, py) {
    const i = this.index.get(id);
    if (i === undefined) return;
    this.fx[i] = this.x[i] = px;
    this.fy[i] = this.y[i] = py;
    this.vx[i] = this.vy[i] = 0;
  }

  unpin(id) {
    const i = this.index.get(id);
    if (i === undefined) return;
    this.fx[i] = NaN;
    this.fy[i] = NaN;
  }

  // A held node is a "ghost": it doesn't repel or collide with others, so
  // drop targets don't flee from it while you drag.
  setGhost(id) {
    this.ghostId = id ?? null;
  }

  _ghostIndex() {
    return this.ghostId == null ? -1 : (this.index.get(this.ghostId) ?? -1);
  }

  _recomputeLinkStrength() {
    const m = this.ls.length;
    this.lbias = new Float64Array(m);
    this.lstr = new Float64Array(m);
    for (let l = 0; l < m; l++) {
      const a = this.deg[this.ls[l]];
      const b = this.deg[this.lt[l]];
      this.lbias[l] = a / (a + b);
      this.lstr[l] = this.params.linkStrength / Math.min(a, b);
    }
  }

  tick(iterations = 1) {
    const { alphaDecay, velocityDecay } = this.params;
    const keep = 1 - velocityDecay;
    for (let it = 0; it < iterations; it++) {
      this.alpha += (this.alphaTarget - this.alpha) * alphaDecay;
      const alpha = this.alpha;
      this._forceLink(alpha);
      this._forceCharge(alpha);
      this._forceGravity(alpha);
      this._forceCollide();
      const { n, x, y, vx, vy, fx, fy } = this;
      for (let i = 0; i < n; i++) {
        if (fx[i] === fx[i]) {
          x[i] = fx[i];
          vx[i] = 0;
        } else {
          vx[i] *= keep;
          x[i] += vx[i];
        }
        if (fy[i] === fy[i]) {
          y[i] = fy[i];
          vy[i] = 0;
        } else {
          vy[i] *= keep;
          y[i] += vy[i];
        }
      }
    }
  }

  _forceLink(alpha) {
    const { x, y, vx, vy, ls, lt, lbias, lstr } = this;
    const dist = this.params.linkDistance;
    for (let l = 0; l < ls.length; l++) {
      const s = ls[l];
      const t = lt[l];
      let dx = x[t] + vx[t] - x[s] - vx[s] || this._jiggle();
      let dy = y[t] + vy[t] - y[s] - vy[s] || this._jiggle();
      let len = Math.sqrt(dx * dx + dy * dy);
      len = ((len - dist) / len) * alpha * lstr[l];
      dx *= len;
      dy *= len;
      const b = lbias[l];
      vx[t] -= dx * b;
      vy[t] -= dy * b;
      vx[s] += dx * (1 - b);
      vy[s] += dy * (1 - b);
    }
  }

  // Barnes–Hut quadtree, rebuilt every tick. Internal nodes store their
  // centre of mass and total charge.
  _buildQuad(idx, x0, y0, w, depth) {
    const { x, y } = this;
    const charge = -this.params.repel;
    const node = { x0, y0, w, cx: 0, cy: 0, q: 0, kids: null, pts: null };
    if (idx.length <= 1 || depth > 30) {
      let sx = 0;
      let sy = 0;
      for (const i of idx) {
        sx += x[i];
        sy += y[i];
      }
      node.pts = idx;
      node.cx = sx / idx.length;
      node.cy = sy / idx.length;
      node.q = charge * idx.length;
      return node;
    }
    const h = w / 2;
    const mx = x0 + h;
    const my = y0 + h;
    const parts = [[], [], [], []];
    for (const i of idx) parts[(y[i] >= my ? 2 : 0) | (x[i] >= mx ? 1 : 0)].push(i);
    node.kids = [];
    let sx = 0;
    let sy = 0;
    for (let k = 0; k < 4; k++) {
      if (!parts[k].length) continue;
      const kid = this._buildQuad(parts[k], x0 + (k & 1) * h, y0 + (k >> 1) * h, h, depth + 1);
      node.kids.push(kid);
      sx += kid.cx * parts[k].length;
      sy += kid.cy * parts[k].length;
    }
    node.cx = sx / idx.length;
    node.cy = sy / idx.length;
    node.q = charge * idx.length;
    return node;
  }

  _forceCharge(alpha) {
    const { n, x, y } = this;
    if (n < 2 || !this.params.repel) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      if (x[i] < x0) x0 = x[i];
      if (y[i] < y0) y0 = y[i];
      if (x[i] > x1) x1 = x[i];
      if (y[i] > y1) y1 = y[i];
    }
    const w = (Math.max(x1 - x0, y1 - y0) || 1) * 1.0001;
    const ghost = this._ghostIndex();
    const idx = [];
    for (let i = 0; i < n; i++) if (i !== ghost) idx.push(i);
    if (!idx.length) return;
    const root = this._buildQuad(idx, x0, y0, w, 0);
    const { theta, distanceMin, distanceMax } = this.params;
    const ctx = {
      alpha,
      theta2: theta * theta,
      dmin2: distanceMin * distanceMin,
      dmax2: distanceMax * distanceMax,
      charge: -this.params.repel,
    };
    for (let i = 0; i < n; i++) this._applyQuad(root, i, ctx);
  }

  _applyQuad(node, i, c) {
    const { x, y, vx, vy } = this;
    let dx = node.cx - x[i];
    let dy = node.cy - y[i];
    let l = dx * dx + dy * dy;
    if (node.kids) {
      if ((node.w * node.w) / c.theta2 < l) {
        // Far enough away: treat the whole cell as one body.
        if (l < c.dmax2) {
          if (l < c.dmin2) l = Math.sqrt(c.dmin2 * l);
          vx[i] += (dx * node.q * c.alpha) / l;
          vy[i] += (dy * node.q * c.alpha) / l;
        }
        return;
      }
      for (const kid of node.kids) this._applyQuad(kid, i, c);
      return;
    }
    for (const j of node.pts) {
      if (j === i) continue;
      dx = x[j] - x[i];
      dy = y[j] - y[i];
      if (dx === 0) dx = this._jiggle();
      if (dy === 0) dy = this._jiggle();
      l = dx * dx + dy * dy;
      if (l >= c.dmax2) continue;
      if (l < c.dmin2) l = Math.sqrt(c.dmin2 * l);
      vx[i] += (dx * c.charge * c.alpha) / l;
      vy[i] += (dy * c.charge * c.alpha) / l;
    }
  }

  _forceGravity(alpha) {
    const { n, x, y, vx, vy, g } = this;
    const s = this.params.centerStrength * alpha;
    for (let i = 0; i < n; i++) {
      vx[i] -= x[i] * g[i] * s;
      vy[i] -= y[i] * g[i] * s;
    }
  }

  _forceCollide() {
    const { n, x, y, vx, vy, r } = this;
    const { collidePadding: pad, collideStrength: str } = this.params;
    if (n < 2 || str <= 0) return;
    let maxR = 0;
    for (let i = 0; i < n; i++) if (r[i] + pad > maxR) maxR = r[i] + pad;
    const cell = maxR * 2;
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    const gx = new Int32Array(n);
    const gy = new Int32Array(n);
    const grid = new Map();
    const key = (a, b) => a * 100003 + b;
    const ghost = this._ghostIndex();
    for (let i = 0; i < n; i++) {
      if (i === ghost) continue;
      px[i] = x[i] + vx[i];
      py[i] = y[i] + vy[i];
      gx[i] = Math.floor(px[i] / cell);
      gy[i] = Math.floor(py[i] / cell);
      const k = key(gx[i], gy[i]);
      const bucket = grid.get(k);
      if (bucket) bucket.push(i);
      else grid.set(k, [i]);
    }
    for (let i = 0; i < n; i++) {
      if (i === ghost) continue;
      const ri = r[i] + pad;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const bucket = grid.get(key(gx[i] + ox, gy[i] + oy));
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const rj = r[j] + pad;
            const rr = ri + rj;
            let dx = px[i] - px[j];
            let dy = py[i] - py[j];
            let l = dx * dx + dy * dy;
            if (l >= rr * rr) continue;
            if (dx === 0) {
              dx = this._jiggle();
              l += dx * dx;
            }
            if (dy === 0) {
              dy = this._jiggle();
              l += dy * dy;
            }
            l = Math.sqrt(l);
            const k = ((rr - l) / l) * str;
            dx *= k;
            dy *= k;
            const w = (rj * rj) / (ri * ri + rj * rj);
            vx[i] += dx * w;
            vy[i] += dy * w;
            vx[j] -= dx * (1 - w);
            vy[j] -= dy * (1 - w);
          }
        }
      }
    }
  }

  writePositions(out) {
    for (let i = 0; i < this.n; i++) {
      out[2 * i] = this.x[i];
      out[2 * i + 1] = this.y[i];
    }
    return out;
  }
}
