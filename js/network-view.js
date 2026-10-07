/** A canvas view of measured network state. This module never trains or calculates answers. */
const MINT = [40, 104, 79];
const AMBER = [156, 99, 27];
const TEXT = [34, 34, 34];
const MUTED = [135, 135, 127];
const DOMAINS = { add: [0, 18], sub: [-9, 9], mul: [0, 81], div: [0, 9] };
const SYMBOLS = { add: '+', sub: '−', mul: '×', div: '÷' };
const FRAME_MS = 1000 / 45;
const AFTER_PHASE = 0.94;
const FORWARD_WINDOWS = [[0.19, 0.39], [0.39, 0.56], [0.56, 0.68]];
const biasAngle = value => -Math.PI / 2 + Math.atan(value * 8);
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
    this.lastReceivedNetwork = null;
    this.lastReceivedType = null;
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
    if (changesExample) {
      this.lastReceivedNetwork = this.state.network;
      this.lastReceivedType = this.state.example?.type;
    }
    if (this.motionReduced()) this.finishImmediately();
    this.graph = null;
    this.draw();
    this.updateAccessibleLabel();
  }

  /** Complete the current cycle; coalesce frequent training calls into one latest next cycle. */
  animate(sample, network) {
    if (this.destroyed || !sample || !network) return;
    const beforeNetwork = this.lastReceivedType === sample.type ? this.lastReceivedNetwork : null;
    const item = { sample, network, beforeNetwork };
    this.lastReceivedNetwork = network;
    this.lastReceivedType = sample.type;
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
    this.updateAccessibleLabel(phase === 'before' ? sample.before : sample.after);
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
    this.active = {
      ...item, started: this.win.performance.now(), progress: 0, lastDraw: -Infinity,
      afterNotified: false, duration: item.sample.trained <= 25 ? 1500 : 1100,
    };
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
      const progress = clamp((now - cycle.started) / cycle.duration);
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
    const left = Math.max(31, this.width * 0.075);
    const right = this.width - Math.max(24, this.width * 0.065);
    const railA = this.height * 0.1;
    const railB = this.height * 0.235;
    const example = this.state.example ?? {};
    const a = finite(example.a) ? example.a : 0;
    const b = finite(example.b) ? example.b : 0;
    const inputMin = Math.min(0, a, b);
    const inputMax = Math.max(9, a, b);
    const inputX = value => mix(left, right, (value - inputMin) / (inputMax - inputMin));
    const rows = [railA, this.height * 0.435, this.height * 0.645, this.height * 0.82];
    const nodes = sizes.map((count, layer) => Array.from({ length: count }, (_, index) => {
      const y = layer === 0 ? (index === 0 ? railA : railB) : rows[layer];
      const x = layer === 0 ? inputX(index === 0 ? a : b)
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
    this.graph = { network, nodes, layers, maxWeight, left, right, railA, railB, inputX };
    if (this.active) this.prepareSignals();
  }

  prepareSignals() {
    if (!this.active || !this.graph) return;
    const sample = this.active.sample;
    const activations = sample.beforeActivations ?? sample.activations ?? [];
    const exactBefore = this.active.beforeNetwork?.trained === sample.trained - 1;
    const beforeWeights = exactBefore ? this.active.beforeNetwork.weights : null;
    const allGradients = sample.gradients?.weights?.flat(2).filter(finite) ?? [];
    const gradientMax = Math.max(0, ...allGradients.map(Math.abs));
    const gradientLevel = Math.min(1, Math.sqrt(gradientMax) * 3);
    this.active.forward = this.graph.layers.map((edges, layer) => {
      const selected = [];
      for (let destination = 0; destination < this.graph.nodes[layer + 1].length; destination++) {
        const incoming = edges.filter(edge => edge.destination === destination).map(edge => ({
          ...edge,
          signalWeight: beforeWeights?.[layer]?.[edge.destination]?.[edge.source] ?? edge.weight,
          // A pre-update contribution is known only with the matching snapshot.
          // For coalesced batches, display the actual source activation instead
          // of manufacturing a contribution from mismatched parameter states.
          signal: beforeWeights
            ? Math.abs(beforeWeights[layer][edge.destination][edge.source] * (activations[layer]?.[edge.source] ?? 0))
            : Math.abs(activations[layer]?.[edge.source] ?? 0),
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
    const after = !active || progress >= AFTER_PHASE;
    const prediction = active && !after
      ? { value: active.sample.before, activations: active.sample.beforeActivations }
      : this.state.prediction;
    const activations = prediction?.activations ?? [];
    const beforeWeights = active && progress < 0.74 && active.beforeNetwork?.trained === active.sample.trained - 1
      ? active.beforeNetwork.weights : null;
    ctx.lineCap = 'round';
    for (const edges of this.graph.layers) for (const edge of edges) {
      const weight = beforeWeights?.[edge.layer]?.[edge.destination]?.[edge.source] ?? edge.weight;
      const strength = this.graph.maxWeight ? clamp(Math.sqrt(Math.abs(weight) / this.graph.maxWeight)) : 0;
      if (strength < 1e-6) continue;
      ctx.strokeStyle = rgba(weight >= 0 ? MINT : AMBER, 0.045 + strength * 0.19);
      ctx.lineWidth = 0.45 + strength * 0.45;
      ctx.beginPath();
      ctx.moveTo(edge.from.x, edge.from.y);
      ctx.lineTo(edge.to.x, edge.to.y);
      ctx.stroke();
    }
    this.drawRails(progress);
    if (active) this.drawFlow(progress);
    for (const layer of this.graph.nodes) for (const node of layer) {
      if (node.layer === 0) continue;
      const activation = activations[node.layer]?.[node.index] ?? 0;
      let pulse = 0;
      let correction = 0;
      if (active) {
        const arrival = FORWARD_WINDOWS[node.layer - 1][1];
        pulse = Math.max(0, 1 - Math.abs(progress - arrival) / 0.075) * Math.min(1, Math.abs(activation));
        const returnArrival = 0.74 + (3 - node.layer) / 3 * 0.2;
        const delta = active.sample.gradients?.deltas?.[node.layer - 1]?.[node.index] ?? 0;
        correction = Math.max(0, 1 - Math.abs(progress - returnArrival) / 0.085)
          * (active.maxDelta ? Math.sqrt(Math.abs(delta) / active.maxDelta) : 0) * active.gradientLevel;
      }
      const label = node.layer === 3 ? format(prediction?.value, true) : null;
      this.drawNode(node, activation, label, pulse, correction, progress);
    }
    this.drawAxis(prediction?.value, after ? this.lastSample : null);
    if (active && after && !active.afterNotified) {
      active.afterNotified = true;
      this.notifySample(active.sample, 'after');
    }
  }

  drawRails(progress) {
    const ctx = this.ctx;
    const { left, right, railA, railB, inputX, nodes } = this.graph;
    const [pointA, pointB] = nodes[0];
    // The two positions encode A and B. The connecting segment makes their
    // difference visible; it is not a claim of classical mechanical inference.
    ctx.strokeStyle = rgba(MUTED, 0.38);
    ctx.lineWidth = 0.8;
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(pointA.x, railA); ctx.lineTo(pointA.x, railB); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = rgba(MINT, 0.86);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(pointA.x, railA); ctx.lineTo(pointB.x, railB); ctx.stroke();
    const angle = Math.atan2(railB - railA, pointB.x - pointA.x);
    ctx.fillStyle = rgba(MINT, 0.9);
    ctx.beginPath();
    ctx.moveTo(pointB.x, railB);
    ctx.lineTo(pointB.x - 7 * Math.cos(angle - 0.4), railB - 7 * Math.sin(angle - 0.4));
    ctx.lineTo(pointB.x - 7 * Math.cos(angle + 0.4), railB - 7 * Math.sin(angle + 0.4));
    ctx.closePath(); ctx.fill();
    [railA, railB].forEach((y, index) => {
      ctx.strokeStyle = rgba(TEXT, 0.38);
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.font = `400 9px ${MONO}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (let digit = 0; digit <= 9; digit++) {
        const x = inputX(digit);
        ctx.beginPath(); ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3); ctx.stroke();
        ctx.fillStyle = rgba(TEXT, 0.72);
        ctx.fillText(String(digit), x, y + 8);
      }
      ctx.font = `600 11px ${MONO}`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = rgba(TEXT, 0.9);
      ctx.fillText(index === 0 ? 'A' : 'B', 9, y);
      const point = nodes[0][index];
      ctx.fillStyle = '#fff'; ctx.strokeStyle = rgba(MINT, 1); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(point.x, point.y, 5.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
    if (this.active && progress <= 0.19) {
      const t = clamp(progress / 0.19);
      this.drawBall(mix(pointA.x, pointB.x, t), mix(railA, railB, t), 4.2, TEXT, 1);
    }
  }

  drawBall(x, y, radius, color, opacity = 1) {
    const ctx = this.ctx;
    ctx.fillStyle = rgba(color, opacity);
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${opacity * 0.8})`;
    ctx.beginPath(); ctx.arc(x - radius * 0.27, y - radius * 0.32, radius * 0.24, 0, Math.PI * 2); ctx.fill();
  }

  drawNode(node, activation, label, pulse, correction, progress) {
    const ctx = this.ctx;
    const major = node.layer === 3;
    const radius = major ? 12 : Math.max(7, Math.min(10, this.width / 48));
    const activity = clamp(Math.abs(activation));
    const color = activation < 0 ? AMBER : MINT;
    const bias = this.state.network.biases?.[node.layer - 1]?.[node.index] ?? 0;
    const oldBias = this.active?.beforeNetwork?.biases?.[node.layer - 1]?.[node.index];
    const newAngle = biasAngle(bias);
    const oldAngle = finite(oldBias) ? biasAngle(oldBias) : newAngle;
    const correctionProgress = this.active ? clamp((progress - 0.74) / 0.2) : 1;
    const angle = mix(oldAngle, newAngle, correctionProgress);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = rgba(TEXT, 0.6);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = rgba(color, 0.04 + activity * 0.14 + pulse * 0.08);
    ctx.beginPath(); ctx.arc(node.x, node.y, radius - 1, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = rgba(color, 0.55 + pulse * 0.3);
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(node.x, node.y, radius + 2, -Math.PI / 2, -Math.PI / 2 + activity * Math.PI * 2); ctx.stroke();
    // Every dial has the same fixed, monotonic scale: atan(8 × actual bias).
    // The ghost pointer and correction arc use a real earlier snapshot only.
    if (finite(oldBias) && Math.abs(newAngle - oldAngle) > 0.0001 && correctionProgress > 0) {
      ctx.strokeStyle = rgba(MUTED, 0.6); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(node.x, node.y);
      ctx.lineTo(node.x + Math.cos(oldAngle) * radius * 0.75, node.y + Math.sin(oldAngle) * radius * 0.75); ctx.stroke();
      ctx.strokeStyle = rgba(AMBER, 0.9); ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.arc(node.x, node.y, radius + 4, oldAngle, angle, angle < oldAngle); ctx.stroke();
      this.drawBall(node.x + Math.cos(angle) * (radius + 4), node.y + Math.sin(angle) * (radius + 4), 1.5, AMBER, 0.9);
    }
    ctx.strokeStyle = rgba(TEXT, 0.95); ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(node.x, node.y);
    ctx.lineTo(node.x + Math.cos(angle) * radius * 0.75, node.y + Math.sin(angle) * radius * 0.75); ctx.stroke();
    ctx.fillStyle = rgba(TEXT, 0.95);
    ctx.beginPath(); ctx.arc(node.x, node.y, 1.7, 0, Math.PI * 2); ctx.fill();
    if (pulse > 0.02) this.drawBall(node.x, node.y - radius - 4 - pulse * 5, 1.6 + activity * 1.6, color, 0.75);
    if (correction > 0.01) {
      ctx.strokeStyle = rgba(AMBER, correction * 0.9); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(node.x, node.y, radius + 5 + correction * 3, 0, Math.PI * 2); ctx.stroke();
    }
    if (major) {
      ctx.fillStyle = rgba(TEXT, 0.98); ctx.font = `400 12px ${MONO}`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(`≈ ${label}`, node.x + 23, node.y);
    }
  }

  drawFlow(progress) {
    const active = this.active;
    if (!active) return;
    const backwards = progress >= 0.74 && progress <= 0.94;
    const forwards = progress >= 0.19 && progress <= 0.68;
    if (!backwards && !forwards) return;
    const global = backwards ? (progress - 0.74) / 0.2 * 3 : 0;
    const segment = backwards ? Math.min(2, Math.floor(global))
      : Math.max(0, FORWARD_WINDOWS.findIndex(([start, end]) => progress >= start && progress <= end));
    const layer = backwards ? 2 - segment : segment;
    const [start, end] = FORWARD_WINDOWS[layer];
    const position = backwards ? clamp(global - segment) : clamp((progress - start) / (end - start));
    const edges = (backwards ? active.backward : active.forward)?.[layer] ?? [];
    for (const edge of edges) {
      const strength = backwards ? edge.signal : Math.min(1, Math.sqrt(edge.signal) * 2.3);
      if (strength < 0.01) continue;
      const t = backwards ? 1 - position : position;
      const x = mix(edge.from.x, edge.to.x, t);
      const y = mix(edge.from.y, edge.to.y, t);
      const color = backwards ? AMBER : (edge.signalWeight ?? edge.weight) >= 0 ? MINT : AMBER;
      const tail = clamp(t + (backwards ? 0.11 : -0.11));
      this.ctx.strokeStyle = rgba(color, strength * 0.55);
      this.ctx.lineWidth = 0.7 + strength;
      this.ctx.beginPath();
      this.ctx.moveTo(mix(edge.from.x, edge.to.x, tail), mix(edge.from.y, edge.to.y, tail));
      this.ctx.lineTo(x, y);
      this.ctx.stroke();
      this.drawBall(x, y, 1.2 + strength * 1.6, color, 0.25 + strength * 0.7);
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
    const left = Math.max(30, this.width * 0.16);
    const right = this.width - left;
    const y = this.height - 24;
    const xOf = n => mix(left, right, (n - minimum) / (maximum - minimum || 1));
    const px = xOf(value);
    const output = this.graph.nodes.at(-1)[0];
    ctx.strokeStyle = rgba(MINT, 0.1);
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(output.x, output.y + 15);
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
      ctx.strokeStyle = rgba(MINT, 0.9);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(tx, y - 6); ctx.lineTo(tx, y + 6); ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = rgba(MINT, 0.92);
      const labelX = clamp(tx, left + 18, right - 18);
      ctx.fillText(`cible ${format(target)}`, labelX, y - 10);
    }
    ctx.fillStyle = rgba(TEXT, 1);
    ctx.beginPath(); ctx.arc(px, y, 3.2, 0, Math.PI * 2); ctx.fill();
  }

  updateAccessibleLabel(value = this.state.prediction?.value) {
    const example = this.state.example;
    if (!example || !finite(value)) return;
    this.canvas.setAttribute('aria-label',
      `Entrée A ${format(example.a)}, entrée B ${format(example.b)}, opération ${SYMBOLS[example.type] ?? ''}. `
      + `Proposition ${format(value, true)}${finite(example.target) ? `, cible ${format(example.target)}` : ''}. `
      + 'Deux rails gradués représentent les entrées. Les potards montrent les biais appris et les impulsions les signaux réels.');
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
