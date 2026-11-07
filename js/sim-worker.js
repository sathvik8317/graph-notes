// Runs the physics off the main thread. Ticks at ~60 fps while the
// simulation is warm, then goes idle until a message reheats it.
import { Simulation } from './sim-core.js';

const sim = new Simulation();
const FRAME_MS = 1000 / 60;
let version = 0;
let timer = null;

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'graph':
      version = m.version;
      sim.setGraph(m.nodes, m.links);
      if (m.reheat) sim.reheat(m.reheat);
      post();
      break;
    case 'attrs':
      sim.setAttrs(m.nodes);
      if (m.reheat) sim.reheat(m.reheat);
      break;
    case 'params':
      sim.setParams(m.params);
      sim.reheat(0.5);
      break;
    case 'pin':
      sim.pin(m.id, m.x, m.y);
      sim.reheat(0.1);
      break;
    case 'unpin':
      sim.unpin(m.id);
      sim.reheat(0.1);
      break;
    case 'drag':
      sim.alphaTarget = m.on ? 0.3 : 0;
      sim.setGhost(m.on ? m.id : null);
      if (m.on) sim.reheat(0.3);
      break;
  }
  schedule();
};

function schedule() {
  if (timer === null && sim.running) timer = setTimeout(step, FRAME_MS);
}

function step() {
  timer = null;
  sim.tick();
  post();
  schedule();
}

function post() {
  const pos = sim.writePositions(new Float32Array(sim.n * 2));
  self.postMessage({ type: 'tick', version, pos, alpha: sim.alpha }, [pos.buffer]);
}
