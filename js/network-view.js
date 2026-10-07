/** The board draws the learner's recorded ray. It never predicts or trains. */
const INK = [34, 43, 38];
const GREEN = [38, 109, 79];
const AMBER = [182, 106, 32];
const GREY = [146, 153, 146];
const MONO = '"Courier New", Courier, monospace';
const FRAME_MS = 1000 / 45;
const FALL_END = .28;
const RETURN_START = .37;
const RETURN_END = .85;
const REPLAY_START = .87;
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mix = (a, b, t) => a + (b - a) * t;
const ease = t => t * t * (3 - 2 * t);
const rgba = (rgb, a = 1) => `rgba(${rgb.join(',')},${clamp(a)})`;
const finite = Number.isFinite;
const number = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2, useGrouping: false });
const format = v => finite(v) ? number.format(v).replace('-', '−') : '—';

export class NetworkView {
  constructor(canvas) {
    if (!canvas?.getContext) throw new TypeError('NetworkView needs a canvas');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    if (!this.ctx) throw new Error('A 2D canvas context is unavailable');
    this.win = canvas.ownerDocument?.defaultView ?? globalThis;
    this.doc = canvas.ownerDocument;
    this.state = { network: null, prediction: null, example: null, reducedMotion: false };
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.visible = true;
    this.active = null;
    this.queued = null;
    this.lastSample = null;
    this.frame = null;
    this.onSample = null;
    this.destroyed = false;
    this.media = this.win.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.onResize = () => this.resize();
    this.onMotion = () => { if (this.motionReduced()) this.finishImmediately(); };
    this.onVisibility = () => this.doc?.hidden ? this.finishImmediately() : this.resize();
    this.media?.addEventListener?.('change', this.onMotion);
    this.doc?.addEventListener('visibilitychange', this.onVisibility);
    this.win.addEventListener?.('resize', this.onResize, { passive: true });
    if (this.win.ResizeObserver) {
      this.observer = new this.win.ResizeObserver(this.onResize);
      this.observer.observe(canvas);
    }
    this.resize();
  }

  setState(next = {}) {
    if (this.destroyed) return;
    if ('network' in next || 'prediction' in next || 'example' in next) {
      this.stop();
      this.lastSample = null;
    }
    this.state = { ...this.state, ...next };
    if (this.motionReduced()) this.finishImmediately();
    this.draw();
    this.updateAccessibleLabel();
  }

  animate(sample, network) {
    if (this.destroyed || !sample || !network) return;
    const item = { sample, network };
    if (this.motionReduced() || !this.visible || this.doc?.hidden) {
      this.stop();
      this.commit(item);
      this.draw();
      this.notifySample(sample, 'after');
    } else if (this.active) {
      // Keep the complete cycle currently shown. Its successor carries exact
      // before/after snapshots, even when intervening launches are condensed.
      this.queued = item;
    } else this.start(item);
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

  commit({ sample, network }) {
    this.state.network = network;
    this.state.prediction = { value: sample.after, normalizedValue: sample.trace?.finalX, trace: sample.trace };
    this.state.example = { type: sample.type, a: sample.a, b: sample.b, target: sample.target };
    this.lastSample = sample;
    this.updateAccessibleLabel();
  }

  notifySample(sample, phase) {
    this.updateAccessibleLabel(phase === 'before' ? sample.before : sample.after);
    if (typeof this.onSample === 'function') this.onSample(sample, phase);
  }

  start(item) {
    this.commit(item);
    this.active = {
      ...item, started: this.win.performance.now(), progress: 0,
      lastDraw: -Infinity, afterNotified: false,
      duration: item.sample.trained <= 25 ? 5600 : 4400,
    };
    const started = this.active;
    this.draw(0);
    this.notifySample(item.sample, 'before');
    if (this.active !== started || this.destroyed) return;
    const tick = now => {
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
        cycle.afterNotified = true;
        this.notifySample(cycle.sample, 'after');
        if (this.active !== cycle || this.destroyed) return;
        const next = this.queued;
        this.active = null;
        this.queued = null;
        this.draw();
        if (next) this.start(next);
      } else this.frame = this.win.requestAnimationFrame(tick);
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
    }
    this.draw();
  }

  geometry() {
    const network = this.state.network;
    if (!network?.geometry || !this.width || !this.height) return null;
    const { rows, guides, width, height, initialFlight } = network.geometry;
    const margin = this.width < 400 ? 23 : 28;
    // One affine coordinate system for every row, both input rails and the
    // output. No per-row rescaling and no trajectory pulled toward the target.
    const worldWidth = width * 1.2;
    const toX = x => margin + (x + worldWidth) / (2 * worldWidth) * (this.width - 2 * margin);
    const top = 23;
    const bottom = this.height - 36;
    const unitY = (bottom - top) / (1 + initialFlight + rows * height);
    const railA = top;
    const railB = top + unitY;
    const rowY = Array.from({ length: rows }, (_, r) => railB + (initialFlight + r * height) * unitY);
    const positions = network.positions ?? Array.from({ length: guides }, (_, i) => -width + i * 2 * width / (guides - 1));
    return { rows, guides, width, height, initialFlight, margin, toX, railA, railB, rowY, bottom, positions, unitY };
  }

  path(trace, g) {
    if (!trace?.input || trace.rows?.length !== g.rows || !finite(trace.finalX)) return null;
    return [
      { x: g.toX(trace.input.a), y: g.railA },
      { x: g.toX(trace.input.b), y: g.railB },
      ...trace.rows.map((row, r) => ({ x: g.toX(row.x), y: g.rowY[r] })),
      { x: g.toX(trace.finalX), y: g.bottom },
    ];
  }

  draw(progress = this.active?.progress ?? 1) {
    if (!this.ctx || !this.visible || this.destroyed || !this.width || !this.height) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const g = this.geometry();
    if (!g) return;
    const active = this.active;
    const sample = active?.sample ?? this.lastSample;
    const afterTrace = this.state.prediction?.trace;
    const beforeTrace = active?.sample.beforeTrace ?? afterTrace;
    const beforePath = this.path(beforeTrace, g);
    const afterPath = this.path(afterTrace, g);
    if (!beforePath || !afterPath) return;
    const replay = active && progress >= REPLAY_START;
    const trace = replay || !active ? afterTrace : beforeTrace;
    const path = replay || !active ? afterPath : beforePath;
    const fall = active ? clamp(progress / FALL_END) : 1;
    const replayProgress = replay ? clamp((progress - REPLAY_START) / (1 - REPLAY_START)) : 0;
    const returning = active && progress >= RETURN_START && progress < RETURN_END;
    const returnPosition = active ? clamp((progress - RETURN_START) / (RETURN_END - RETURN_START)) * (g.rows + 1) : g.rows + 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Quiet context: just the path actually computed for this pair.
    this.strokePath(path, GREY, .23, 1, [2, 4]);
    this.drawRails(trace, g);
    if (active) {
      if (replay) {
        this.strokePartial(afterPath, replayProgress, GREEN, .75, 1.7);
      } else {
        this.strokePartial(beforePath, fall, GREEN, .8, 1.7);
      }
    } else this.strokePath(afterPath, GREEN, .42, 1.2);

    const update = sample?.updateGradients?.angles ?? sample?.gradients?.angles ?? [];
    const gradientMax = Math.max(1e-12, ...update.flat().filter(finite).map(Math.abs));
    for (let row = 0; row < g.rows; row++) {
      const local = trace.rows[row];
      const influence = new Map();
      local.indices.forEach((index, i) => influence.set(index, (influence.get(index) ?? 0) + local.weights[i]));
      const returnIndex = g.rows - 1 - row;
      // On each upward leg the pulse first arrives, then the dials turn.
      const correction = active ? clamp((returnPosition - returnIndex - .60) / .38) : 1;
      const rowReached = active && !replay && progress < RETURN_START
        ? clamp((fall * (path.length - 1) - (row + 2) + .3) / .3) : 1;
      const currentRow = returning && Math.floor(returnPosition) === returnIndex;
      for (let pin = 0; pin < g.guides; pin++) {
        const newAngle = this.state.network.angles[row][pin];
        const oldAngle = active?.sample.beforeAngles?.[row]?.[pin] ?? newAngle;
        const angle = mix(oldAngle, newAngle, ease(correction));
        const weight = (influence.get(pin) ?? 0) * rowReached;
        const grad = Math.sqrt(Math.abs(update[row]?.[pin] ?? 0) / gradientMax);
        this.drawDial(g.toX(g.positions[pin]), g.rowY[row], angle, {
          weight, oldAngle, correction,
          changed: Math.abs(newAngle - oldAngle) > 1e-8,
          returning: currentRow,
          gradient: grad,
        });
      }
      // The effective local deflector is derived from these four guides.
      const x = g.toX(local.x), y = g.rowY[row];
      if (x >= g.margin - 6 && x <= this.width - g.margin + 6) {
        ctx.strokeStyle = rgba(GREEN, .42 + .3 * rowReached);
        ctx.lineWidth = 1.6;
        const half = 4.5;
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(local.angle) * half, y + Math.sin(local.angle) * half);
        ctx.lineTo(x + Math.cos(local.angle) * half, y - Math.sin(local.angle) * half);
        ctx.stroke();
      }
    }

    const value = active && !replay ? sample.before : this.state.prediction.value;
    this.drawOutput(g, value, sample, !active || progress >= FALL_END);
    if (returning) {
      this.drawReturn(beforePath, returnPosition, g);
    } else if (active && progress < RETURN_START) {
      const point = this.pointAlong(beforePath, fall);
      this.ball(point.x, point.y, 4.3, INK);
    } else if (replay) {
      const point = this.pointAlong(afterPath, replayProgress);
      this.ball(point.x, point.y, 4.3, GREEN);
    } else if (!active) {
      const point = this.state.network.trained ? afterPath.at(-1) : afterPath[0];
      this.ball(point.x, point.y, 4.3, INK);
    }
    if (active && sample.revisionSize > 1) {
      ctx.fillStyle = rgba(GREY, 1);
      ctx.font = `11px ${MONO}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`↻ ${sample.revisionSize}`, this.width - 8, (g.railA + g.railB) / 2);
    }
    this.drawOverflow(path, g);
  }

  drawRails(trace, g) {
    const ctx = this.ctx;
    [g.railA, g.railB].forEach((y, index) => {
      const x = g.toX(index ? trace.input.b : trace.input.a);
      ctx.strokeStyle = rgba(GREY, .58);
      ctx.lineWidth = .8;
      ctx.beginPath(); ctx.moveTo(g.toX(-1), y); ctx.lineTo(g.toX(1), y); ctx.stroke();
      ctx.font = `10px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      for (let digit = 0; digit <= 9; digit++) {
        const tick = g.toX(digit / 4.5 - 1);
        ctx.beginPath(); ctx.moveTo(tick, y - 3); ctx.lineTo(tick, y + 3); ctx.stroke();
        ctx.fillStyle = rgba(INK, .65);
        ctx.fillText(String(digit), tick, y - 6);
      }
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.font = `bold 11px ${MONO}`;
      ctx.fillStyle = rgba(INK, .85);
      ctx.fillText(index ? 'B' : 'A', g.toX(-1) - 17, y);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = rgba(GREEN, 1);
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(x, y, 4.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
    this.arrow({ x: g.toX(trace.input.a), y: g.railA }, { x: g.toX(trace.input.b), y: g.railB }, GREEN, .8, .75, 4.3);
  }

  drawDial(x, y, angle, state) {
    const ctx = this.ctx;
    const activity = Math.sqrt(clamp(state.weight));
    const radius = (this.width < 400 ? 3.5 : 4.4) + activity * 2.5;
    const pointer = -Math.PI / 2 + angle;
    if (activity > .002) {
      ctx.fillStyle = rgba(GREEN, .035 + activity * .11);
      ctx.beginPath(); ctx.arc(x, y, radius + 3.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = rgba(activity ? GREEN : GREY, activity ? .35 + activity * .6 : .40);
    ctx.lineWidth = activity > .1 ? 1.2 : .8;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (state.changed && state.correction > 0 && this.active) {
      const old = -Math.PI / 2 + state.oldAngle;
      ctx.strokeStyle = rgba(GREY, .45);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(old) * radius * .8, y + Math.sin(old) * radius * .8); ctx.stroke();
      ctx.strokeStyle = rgba(AMBER, state.returning ? 1 : .55);
      ctx.lineWidth = state.returning ? 2.5 : 1.5;
      ctx.beginPath(); ctx.arc(x, y, radius + 2.8, old, pointer, pointer < old); ctx.stroke();
    }
    ctx.strokeStyle = rgba(activity ? INK : GREY, activity ? .95 : .7);
    ctx.lineWidth = activity ? 1.5 : 1;
    ctx.beginPath(); ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(pointer) * radius * .82, y + Math.sin(pointer) * radius * .82); ctx.stroke();
    if (state.returning && state.gradient > .002) {
      ctx.strokeStyle = rgba(AMBER, .25 + state.gradient * .65);
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(x, y, radius + 5, 0, Math.PI * 2); ctx.stroke();
    }
  }

  drawOutput(g, value, sample, showError) {
    const ctx = this.ctx;
    const { offset, scale } = this.state.network;
    const target = this.state.example.target;
    const x = g.toX((value - offset) / scale);
    const targetX = g.toX((target - offset) / scale);
    ctx.strokeStyle = rgba(GREY, .7);
    ctx.lineWidth = .8;
    ctx.beginPath(); ctx.moveTo(g.toX(-g.width), g.bottom); ctx.lineTo(g.toX(g.width), g.bottom); ctx.stroke();
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const normalized of [-1, -.5, 0, .5, 1]) {
      const tick = g.toX(normalized);
      ctx.beginPath(); ctx.moveTo(tick, g.bottom - 3); ctx.lineTo(tick, g.bottom + 3); ctx.stroke();
      ctx.fillStyle = rgba(INK, .7);
      ctx.fillText(format(offset + normalized * scale), tick, g.bottom + 15);
    }
    // The teacher is a separate marker. It does not enter path() or geometry().
    ctx.strokeStyle = rgba(GREEN, .9);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(targetX, g.bottom - 9); ctx.lineTo(targetX, g.bottom + 6); ctx.stroke();
    if (showError && finite(x)) {
      ctx.strokeStyle = rgba(AMBER, .8);
      ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(x, g.bottom + 9); ctx.lineTo(targetX, g.bottom + 9); ctx.stroke();
      if (Math.abs(x - targetX) > 4) {
        this.arrow({ x, y: g.bottom + 9 }, { x: targetX, y: g.bottom + 9 }, AMBER, .9, 1, 3.5);
      }
      if (this.active && this.active.progress < REPLAY_START) this.ball(x, g.bottom, 2.6, INK, .6);
    }
  }

  drawReturn(path, position, g) {
    const ctx = this.ctx;
    const leg = Math.floor(position);
    const fraction = position - leg;
    // Stop briefly at each row, giving its rotation a separate, visible beat.
    const travel = ease(clamp(fraction / .60));
    const fromIndex = path.length - 1 - leg;
    const toIndex = Math.max(1, fromIndex - 1);
    const from = path[fromIndex], to = path[toIndex];
    if (!from || !to) return;
    const current = { x: mix(from.x, to.x, travel), y: mix(from.y, to.y, travel) };
    const visited = path.slice(fromIndex).reverse();
    visited.push(current);
    this.strokePath(visited, AMBER, .67, 2.1);
    this.arrow(from, to, AMBER, 1, travel, 7);
    this.ball(current.x, current.y, 4, AMBER);
    // A second directional cue stays vertical; it is a progress indicator,
    // separate from the ray, which still follows its exact recorded path.
    const cueX = 9;
    ctx.strokeStyle = rgba(AMBER, .18);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cueX, g.bottom); ctx.lineTo(cueX, g.railB); ctx.stroke();
    ctx.strokeStyle = rgba(AMBER, .9);
    ctx.beginPath(); ctx.moveTo(cueX, g.bottom); ctx.lineTo(cueX, current.y); ctx.stroke();
    this.arrow({ x: cueX, y: g.bottom }, { x: cueX, y: current.y - 1 }, AMBER, 1, 1, 5);
  }

  pointAlong(path, fraction) {
    const scaled = clamp(fraction) * (path.length - 1);
    const index = Math.min(path.length - 2, Math.floor(scaled));
    const t = scaled - index;
    return { x: mix(path[index].x, path[index + 1].x, t), y: mix(path[index].y, path[index + 1].y, t) };
  }

  strokePartial(path, fraction, color, opacity, width) {
    const stop = clamp(fraction) * (path.length - 1);
    const count = Math.floor(stop);
    const points = path.slice(0, count + 1);
    if (count < path.length - 1) points.push(this.pointAlong(path, fraction));
    this.strokePath(points, color, opacity, width);
  }

  strokePath(path, color, opacity, width, dash = []) {
    if (path.length < 2) return;
    const ctx = this.ctx;
    ctx.strokeStyle = rgba(color, opacity); ctx.lineWidth = width; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
    ctx.stroke(); ctx.setLineDash([]);
  }

  arrow(from, to, color, opacity, progress = 1, size = 5) {
    if (Math.hypot(to.x - from.x, to.y - from.y) < .1) return;
    const ctx = this.ctx;
    const x = mix(from.x, to.x, progress), y = mix(from.y, to.y, progress);
    const a = Math.atan2(to.y - from.y, to.x - from.x);
    ctx.fillStyle = rgba(color, opacity);
    ctx.beginPath(); ctx.moveTo(x, y);
    ctx.lineTo(x - size * Math.cos(a - .52), y - size * Math.sin(a - .52));
    ctx.lineTo(x - size * Math.cos(a + .52), y - size * Math.sin(a + .52));
    ctx.closePath(); ctx.fill();
  }

  ball(x, y, radius, color, opacity = 1) {
    if (!finite(x) || !finite(y)) return;
    const ctx = this.ctx;
    ctx.fillStyle = rgba(color, opacity);
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${opacity * .82})`;
    ctx.beginPath(); ctx.arc(x - radius * .24, y - radius * .29, radius * .22, 0, Math.PI * 2); ctx.fill();
  }

  drawOverflow(path, g) {
    const ctx = this.ctx;
    for (const point of path) {
      if (point.x >= 1 && point.x <= this.width - 1) continue;
      const x = point.x < 1 ? 3 : this.width - 3;
      ctx.fillStyle = rgba(AMBER, .9);
      ctx.beginPath(); ctx.moveTo(x, point.y);
      ctx.lineTo(x + (point.x < 1 ? 5 : -5), point.y - 3);
      ctx.lineTo(x + (point.x < 1 ? 5 : -5), point.y + 3);
      ctx.closePath(); ctx.fill();
    }
  }

  updateAccessibleLabel(value = this.state.prediction?.value) {
    const example = this.state.example;
    if (!example) return;
    const symbols = { add: '+', sub: '−', mul: '×', div: '÷' };
    this.canvas.setAttribute('aria-label', `${example.a} ${symbols[example.type] ?? ''} ${example.b}. Réponse ${format(value)}. Cible ${format(example.target)}. Plateau à huit rangées de potards.`);
  }

  destroy() {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
    this.observer?.disconnect();
    this.media?.removeEventListener?.('change', this.onMotion);
    this.doc?.removeEventListener('visibilitychange', this.onVisibility);
    this.win.removeEventListener?.('resize', this.onResize);
  }
}
