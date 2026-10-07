/** A canvas view of measured network state. This module never trains or calculates answers. */
const MINT = [154, 238, 203];
const AMBER = [237, 188, 118];
const TEXT = [237, 241, 236];
const MUTED = [116, 133, 130];
const DOMAINS = { add: [0, 18], sub: [-9, 9], mul: [0, 81], div: [0, 9] };
const SYMBOLS = { add: '+', sub: '−', mul: '×', div: '÷' };
const DURATION = 900;
const FRAME_MS = 1000 / 45;
const MONO = '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace';
const number = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2, useGrouping: false });
const outputNumber = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const rgba = (color, alpha) => `rgba(${color.join(',')},${clamp(alpha)})`;
const mix = (a, b, p) => a + (b - a) * p;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const format = (value, output = false) => {
  if (!finite(value)) return '·';
  if (Math.abs(value) >= 10000) return value.toExponential(1).replace('.', ',');
  return (output ? outputNumber : number).format(value).replace('-', '−');
};

export class NetworkView {
  constructor(canvas) {
    if (!canvas?.getContext) throw new TypeError('NetworkView needs a canvas element');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    if (!this.ctx) throw new Error('A 2D canvas context is unavailable');
    this.win = canvas.ownerDocument?.defaultView ?? globalThis;
    this.doc = canvas.ownerDocument;
    this.state = { network: null, prediction: null, example: null, reducedMotion: false };
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.active = null;
    this.queued = null;
    this.lastSample = null;
    // Optional integration hook: emitted only for an example actually shown.
    this.onSample = null;
    this.frame = null;
    this.graph = null;
    this.visible = true;
    this.destroyed = false;
    this.media = this.win.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.onResize = () => this.resize();
    this.onMotion = () => { if (this.motionReduced()) this.finishImmediately(); };
    this.onVisibility = () => {
      if (this.doc?.hidden) this.finishImmediately();
      else this.resize();
    };
    this.media?.addEventListener?.('change', this.onMotion);
    this.doc?.addEventListener('visibilitychange', this.onVisibility);
    this.win.addEventListener?.('resize', this.onResize, { passive: true });
    if (this.win.ResizeObserver) {
      this.observer = new this.win.ResizeObserver(this.onResize);
      this.observer.observe(canvas);
    }
    this.resize();
  }

  /** An authoritative state change, for initial loading, selecting a task or settings. */
  setState(next = {}) {
    if (this.destroyed) return;
    const changesExample = 'network' in next || 'prediction' in next || 'example' in next;
    if (changesExample) {
      this.stop();
      this.lastSample = null;
    }
    this.state = { ...this.state, ...next };
    if (this.motionReduced()) this.finishImmediately();
    this.graph = null;
    this.draw();
    this.updateAccessibleLabel();
  }

  /** Complete the current cycle; coalesce frequent training calls into one latest next cycle. */
  animate(sample, network) {
    if (this.destroyed || !sample || !network) return;
    const item = { sample, network };
    if (this.motionReduced() || !this.visible || this.doc?.hidden) {
      this.stop();
      this.commit(item);
      this.draw();
      this.notifySample(sample, 'after');
      return;
    }
    if (this.active) this.queued = item;
    else this.start(item);
  }

  motionReduced() { return Boolean(this.state.reducedMotion || this.media?.matches); }

  stop() {
    if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.active = null;
    this.queued = null;
  }

  finishImmediately() {
    const latest = this.queued ?? this.active;
    const notify = latest && !latest.afterNotified;
    this.stop();
    if (latest) this.commit(latest);
    this.draw();
    if (notify) this.notifySample(latest.sample, 'after');
  }

  notifySample(sample, phase) {
    if (typeof this.onSample === 'function') this.onSample(sample, phase);
  }

  commit({ sample, network }) {
    this.state.network = network;
    this.state.prediction = {
      value: sample.after,
      activations: sample.activations,
      normalizedValue: sample.activations?.at(-1)?.[0],
    };
    this.state.example = { type: sample.type, a: sample.a, b: sample.b, target: sample.target };
    this.lastSample = sample;
    this.graph = null;
    this.updateAccessibleLabel();
  }

  start(item) {
    this.commit(item);
    this.active = { ...item, started: this.win.performance.now(), progress: 0, lastDraw: -Infinity, afterNotified: false };
    const startedCycle = this.active;
    this.prepareGraph();
    this.prepareSignals();
    this.draw(0);
    this.notifySample(item.sample, 'before');
    if (this.active !== startedCycle || this.destroyed) return;
    const tick = (now) => {
      this.frame = null;
      if (!this.active || this.destroyed) return;
      const cycle = this.active;
      const progress = clamp((now - cycle.started) / DURATION);
      cycle.progress = progress;
      if (now - cycle.lastDraw >= FRAME_MS || progress === 1) {
        this.draw(progress);
        cycle.lastDraw = now;
      }
      if (this.active !== cycle || this.destroyed) return;
      if (progress === 1) {
        const next = this.queued;
        this.active = null;
        this.queued = null;
        this.draw();
        if (next) this.start(next);
      } else {
        this.frame = this.win.requestAnimationFrame(tick);
      }
    };
    this.frame = this.win.requestAnimationFrame(tick);
  }

  resize() {
    if (this.destroyed) return;
    const rect = this.canvas.getBoundingClientRect();
    this.visible = rect.width > 0 && rect.height > 0;
    if (!this.visible) { this.finishImmediately(); return; }
    const dpr = Math.max(1, Math.min(3, this.win.devicePixelRatio || 1));
    if (this.width !== rect.width || this.height !== rect.height || this.dpr !== dpr) {
      this.width = rect.width;
      this.height = rect.height;
      this.dpr = dpr;
      this.canvas.width = Math.round(rect.width * dpr);
      this.canvas.height = Math.round(rect.height * dpr);
      this.graph = null;
    }
    this.draw(this.active?.progress);
  }

  prepareGraph() {
    const network = this.state.network;
    if (!network || this.graph?.network === network) return;
    const sizes = network.sizes;
    if (!Array.isArray(sizes) || sizes.length !== 4) return;
    const top = Math.max(34, this.height * 0.115);
    const bottom = this.height - 94;
    const left = this.width * 0.08;
    const right = this.width * 0.92;
    const nodes = sizes.map((count, layer) => Array.from({ length: count }, (_, index) => {
      const y = mix(top, bottom, layer / (sizes.length - 1));
      const x = layer === 0 ? this.width * (index === 0 ? 0.33 : 0.67)
        : count === 1 ? this.width / 2 : mix(left, right, index / (count - 1));
      return { x, y, layer, index };
    }));
    let maxWeight = 0;
    const layers = network.weights.map((matrix, layer) => {
      const edges = [];
      matrix.forEach((row, destination) => row.forEach((weight, source) => {
        if (!finite(weight) || !nodes[layer]?.[source] || !nodes[layer + 1]?.[destination]) return;
        maxWeight = Math.max(maxWeight, Math.abs(weight));
        edges.push({ layer, source, destination, weight, from: nodes[layer][source], to: nodes[layer + 1][destination] });
      }));
      return edges;
    });
    for (const layer of layers) for (const edge of layer) {
      edge.strength = maxWeight ? Math.sqrt(Math.abs(edge.weight) / maxWeight) : 0;
    }
    this.graph = { network, nodes, layers };
    if (this.active) this.prepareSignals();
  }

  prepareSignals() {
    if (!this.active || !this.graph) return;
    const sample = this.active.sample;
    const activations = sample.beforeActivations ?? sample.activations ?? [];
    const allGradients = sample.gradients?.weights?.flat(2).filter(finite) ?? [];
    const gradientMax = Math.max(0, ...allGradients.map(Math.abs));
    const gradientLevel = Math.min(1, Math.sqrt(gradientMax) * 3);
    this.active.forward = this.graph.layers.map((edges, layer) => {
      const selected = [];
      for (let destination = 0; destination < this.graph.nodes[layer + 1].length; destination++) {
        const incoming = edges.filter(edge => edge.destination === destination).map(edge => ({
          ...edge,
          signal: Math.abs(edge.weight * (activations[layer]?.[edge.source] ?? 0)),
        })).filter(edge => edge.signal > 1e-8).sort((a, b) => b.signal - a.signal);
        selected.push(...incoming.slice(0, layer === 2 ? 6 : 2));
      }
      return selected;
    });
    this.active.backward = this.graph.layers.map((edges) => edges.map(edge => {
      const gradient = sample.gradients?.weights?.[edge.layer]?.[edge.destination]?.[edge.source] ?? 0;
      return { ...edge, signal: gradientMax ? Math.sqrt(Math.abs(gradient) / gradientMax) * gradientLevel : 0 };
    }).filter(edge => edge.signal > 0.005).sort((a, b) => b.signal - a.signal).slice(0, 24));
    const deltas = sample.gradients?.deltas?.flat().filter(finite) ?? [];
    this.active.maxDelta = Math.max(0, ...deltas.map(Math.abs));
    this.active.gradientLevel = gradientLevel;
  }

  draw(progress = this.active?.progress) {
    if (!this.ctx || !this.width || !this.height || !this.visible || this.destroyed) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    this.prepareGraph();
    if (!this.graph) return;
    const active = this.active;
    const after = !active || progress >= 0.88;
    const prediction = active && !after
      ? { value: active.sample.before, activations: active.sample.beforeActivations }
      : this.state.prediction;
    const activations = prediction?.activations ?? [];
    ctx.lineCap = 'round';
    for (const edges of this.graph.layers) for (const edge of edges) {
      if (edge.strength < 1e-6) continue;
      ctx.strokeStyle = rgba(edge.weight >= 0 ? MINT : AMBER, 0.023 + edge.strength * 0.17);
      ctx.lineWidth = 0.45 + edge.strength * 0.6;
      ctx.beginPath();
      ctx.moveTo(edge.from.x, edge.from.y);
      ctx.lineTo(edge.to.x, edge.to.y);
      ctx.stroke();
    }
    if (active) this.drawFlow(progress);
    for (const layer of this.graph.nodes) for (const node of layer) {
      const activation = activations[node.layer]?.[node.index] ?? 0;
      let pulse = 0;
      let correction = 0;
      if (active) {
        const arrival = node.layer / 3 * 0.46;
        pulse = Math.max(0, 1 - Math.abs(progress - arrival) / 0.095) * Math.min(1, Math.abs(activation));
        const returnArrival = 0.58 + (3 - node.layer) / 3 * 0.32;
        const delta = active.sample.gradients?.deltas?.[node.layer - 1]?.[node.index] ?? 0;
        correction = Math.max(0, 1 - Math.abs(progress - returnArrival) / 0.085)
          * (active.maxDelta ? Math.sqrt(Math.abs(delta) / active.maxDelta) : 0) * active.gradientLevel;
      }
      const label = node.layer === 0 ? format(node.index === 0 ? this.state.example?.a : this.state.example?.b)
        : node.layer === 3 ? format(prediction?.value, true) : null;
      this.drawNode(node, activation, label, pulse, correction);
    }
    this.drawAxis(prediction?.value, after ? this.lastSample : null);
    if (active && after && !active.afterNotified) {
      active.afterNotified = true;
      this.notifySample(active.sample, 'after');
    }
  }

  glow(x, y, radius, color, strength) {
    if (strength <= 0) return;
    const gradient = this.ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, rgba(color, strength));
    gradient.addColorStop(0.4, rgba(color, strength * 0.28));
    gradient.addColorStop(1, rgba(color, 0));
    this.ctx.fillStyle = gradient;
    this.ctx.beginPath();
    this.ctx.arc(x, y, radius, 0, Math.PI * 2);
    this.ctx.fill();
  }

  drawNode(node, activation, label, pulse, correction) {
    const ctx = this.ctx;
    const major = label !== null;
    const radius = major ? (node.layer === 3 ? 21 : 17) : Math.max(3.2, Math.min(4.2, this.width / 95));
    const activity = clamp(Math.abs(activation));
    const color = !major && activation < 0 ? AMBER : MINT;
    this.glow(node.x, node.y, radius * (major ? 2.3 : 4), color, (major ? 0.055 : 0.04) + activity * 0.13 + pulse * 0.2);
    if (correction > 0) this.glow(node.x, node.y, radius * 4, AMBER, correction * 0.42);
    const gradient = ctx.createRadialGradient(node.x - radius * 0.3, node.y - radius * 0.4, 0, node.x, node.y, radius);
    gradient.addColorStop(0, rgba(color, major ? 0.16 + activity * 0.13 : 0.45 + activity * 0.4));
    gradient.addColorStop(1, major ? '#142620' : rgba(color, 0.15 + activity * 0.45));
    ctx.fillStyle = gradient;
    ctx.strokeStyle = rgba(correction > 0.2 ? AMBER : color, 0.25 + activity * 0.35 + pulse * 0.3);
    ctx.lineWidth = major ? 1 : 0.7;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (major) {
      ctx.fillStyle = rgba(TEXT, 0.96);
      const fontSize = node.layer === 0 ? 15 : Math.min(13, radius * 1.95 / Math.max(1, label.length * 0.64));
      ctx.font = `400 ${fontSize}px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, node.x, node.y + 0.5);
    } else {
      ctx.fillStyle = rgba(TEXT, 0.18 + activity * 0.5 + pulse * 0.2);
      ctx.beginPath();
      ctx.arc(node.x, node.y, 0.9 + activity * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawFlow(progress) {
    const active = this.active;
    if (!active) return;
    const backwards = progress >= 0.58 && progress <= 0.92;
    const forwards = progress <= 0.46;
    if (!backwards && !forwards) return;
    const global = backwards ? (progress - 0.58) / 0.34 * 3 : progress / 0.46 * 3;
    const segment = Math.min(2, Math.floor(global));
    const layer = backwards ? 2 - segment : segment;
    const position = clamp(global - segment);
    const edges = (backwards ? active.backward : active.forward)?.[layer] ?? [];
    for (const edge of edges) {
      const strength = backwards ? edge.signal : Math.min(1, Math.sqrt(edge.signal) * 2.3);
      if (strength < 0.01) continue;
      const t = backwards ? 1 - position : position;
      const x = mix(edge.from.x, edge.to.x, t);
      const y = mix(edge.from.y, edge.to.y, t);
      const color = backwards ? AMBER : edge.weight >= 0 ? MINT : AMBER;
      const tail = clamp(t + (backwards ? 0.11 : -0.11));
      this.ctx.strokeStyle = rgba(color, strength * 0.55);
      this.ctx.lineWidth = 0.7 + strength;
      this.ctx.beginPath();
      this.ctx.moveTo(mix(edge.from.x, edge.to.x, tail), mix(edge.from.y, edge.to.y, tail));
      this.ctx.lineTo(x, y);
      this.ctx.stroke();
      this.glow(x, y, 8, color, strength * 0.33);
      this.ctx.fillStyle = rgba(color, 0.25 + strength * 0.7);
      this.ctx.beginPath();
      this.ctx.arc(x, y, 1 + strength * 1.1, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }

  drawAxis(value, sample) {
    if (!finite(value)) return;
    const ctx = this.ctx;
    const example = this.state.example ?? {};
    const target = example.target;
    const domain = DOMAINS[example.type] ?? [0, 18];
    // Domain bounds give context; real outlying predictions extend the axis.
    const values = [value, target, sample?.before, sample?.after].filter(finite);
    let minimum = Math.min(domain[0], ...values);
    let maximum = Math.max(domain[1], ...values);
    const padding = (maximum - minimum || 1) * 0.04;
    if (minimum < domain[0]) minimum -= padding;
    if (maximum > domain[1]) maximum += padding;
    const left = Math.max(30, this.width * 0.115);
    const right = this.width - left;
    const y = this.height - 47;
    const xOf = n => mix(left, right, (n - minimum) / (maximum - minimum || 1));
    const px = xOf(value);
    const output = this.graph.nodes.at(-1)[0];
    ctx.strokeStyle = rgba(MINT, 0.1);
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(output.x, output.y + 23);
    ctx.bezierCurveTo(output.x, y - 12, px, y - 14, px, y);
    ctx.stroke();
    ctx.strokeStyle = rgba(MUTED, 0.3);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    for (const x of [left, right]) {
      ctx.beginPath(); ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3); ctx.stroke();
    }
    ctx.font = `400 9px ${MONO}`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = rgba(MUTED, 0.75);
    ctx.textAlign = 'left'; ctx.fillText(format(minimum), left, y + 9);
    ctx.textAlign = 'right'; ctx.fillText(format(maximum), right, y + 9);
    if (sample && finite(sample.before) && Math.abs(xOf(sample.before) - px) > 2) {
      const beforeX = xOf(sample.before);
      ctx.strokeStyle = rgba(MINT, 0.35);
      ctx.lineWidth = 0.8;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(beforeX, y - 5); ctx.lineTo(px, y - 5); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = rgba(MUTED, 0.7);
      ctx.beginPath(); ctx.arc(beforeX, y, 3, 0, Math.PI * 2); ctx.stroke();
    }
    if (finite(target)) {
      const tx = xOf(target);
      ctx.strokeStyle = rgba(AMBER, 0.38);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(tx, y); ctx.lineTo(px, y); ctx.stroke();
      ctx.strokeStyle = rgba(AMBER, 0.9);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(tx, y - 6); ctx.lineTo(tx, y + 6); ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = rgba(AMBER, 0.86);
      const labelX = clamp(tx, left + 18, right - 18);
      ctx.fillText(`cible ${format(target)}`, labelX, y - 10);
    }
    this.glow(px, y, 10, MINT, 0.18);
    ctx.fillStyle = rgba(MINT, 1);
    ctx.beginPath(); ctx.arc(px, y, 3.2, 0, Math.PI * 2); ctx.fill();
  }

  updateAccessibleLabel() {
    const example = this.state.example;
    const value = this.state.prediction?.value;
    if (!example || !finite(value)) return;
    this.canvas.setAttribute('aria-label',
      `Réseau neuronal, ${format(example.a)} ${SYMBOLS[example.type] ?? ''} ${format(example.b)}. `
      + `Proposition ${format(value, true)}${finite(example.target) ? `, cible ${format(example.target)}` : ''}. `
      + 'Les liens représentent les poids appris.');
  }

  destroy() {
    this.stop();
    this.destroyed = true;
    this.observer?.disconnect();
    this.media?.removeEventListener?.('change', this.onMotion);
    this.doc?.removeEventListener('visibilitychange', this.onVisibility);
    this.win.removeEventListener?.('resize', this.onResize);
  }
}
