/**
 * A pair enters Fakir as a position and a slope. Each row reads only four local
 * angular guides. The only learned quantities are these guides. The final
 * position is read on a fixed scale. Targets never enter geometric inference.
 */
import { LBFGS, ObservedExamples } from './optimizer.js?v=3.0.0';

export const OPERATIONS = Object.freeze(['add', 'sub', 'mul', 'div']);
export const RAY_GEOMETRY = Object.freeze({
  rows: 8, guides: 17, width: 2, height: .7, rho: -1,
  initialFlight: .25, angleLimit: 1.05, offboardPenalty: .1,
  interpolation: 'cubic', support: 4,
});
const STATE_VERSION = 2;
const DEFAULT_SEED = 0xFA41C;
const UINT_MAX = 0xFFFFFFFF;
const SIZE = RAY_GEOMETRY.rows * RAY_GEOMETRY.guides;
const SPACING = 2 * RAY_GEOMETRY.width / (RAY_GEOMETRY.guides - 1);
const FIRST_STEP_LIMIT = .004;
const CONFIG = Object.freeze({
  add: Object.freeze({ offset: 9, scale: 9, tolerance: .5, salt: 0xA1D1 }),
  sub: Object.freeze({ offset: 0, scale: 9, tolerance: .5, salt: 0x5AB1 }),
  mul: Object.freeze({ offset: 40.5, scale: 40.5, tolerance: .5, salt: 0xAA17 }),
  div: Object.freeze({ offset: 4.5, scale: 4.5, tolerance: .15, salt: 0xD171 }),
});

function assertOperation(type) {
  if (!OPERATIONS.includes(type)) throw new RangeError(`Unknown operation: ${type}`);
}
function assertFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
}
function counter(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new TypeError(`Invalid ${label}`);
}
function assertTrainingInputs(type, a, b) {
  assertFinite(a, 'a'); assertFinite(b, 'b');
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || a > 9 || b < 0 || b > 9) throw new RangeError('Training examples must be integer digits from 0 to 9');
  if (type === 'div' && b === 0) throw new RangeError('Division by zero is not a training example');
}

// Teacher, deliberately outside the inference graph.
function answerKey(type, a, b) {
  if (type === 'add') return a + b;
  if (type === 'sub') return a - b;
  if (type === 'mul') return a * b;
  return a / b;
}

function random(model) {
  model.rngState = (model.rngState + 0x6D2B79F5) >>> 0;
  let t = model.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function createModel(seed) {
  const model = { rngState: seed >>> 0, trained: 0, revisions: 0 };
  const parameters = new Float64Array(SIZE);
  // Small random angles, never an arithmetic-specific solution or checkpoint.
  for (let i = 0; i < SIZE; i++) {
    const normal = Math.sqrt(-2 * Math.log(Math.max(Number.MIN_VALUE, random(model)))) * Math.cos(2 * Math.PI * random(model));
    parameters[i] = Math.atanh(.02 * normal / RAY_GEOMETRY.angleLimit);
  }
  model.optimizer = new LBFGS(parameters, { memorySize: 20, maxLineSearch: 40 });
  model.observed = new ObservedExamples();
  return model;
}
function matrix(vector) {
  return Array.from({ length: RAY_GEOMETRY.rows }, (_, row) => Array.from(vector.slice(row * RAY_GEOMETRY.guides, (row + 1) * RAY_GEOMETRY.guides)));
}
function effectiveAngles(parameters) {
  return Float64Array.from(parameters, p => RAY_GEOMETRY.angleLimit * Math.tanh(p));
}
function workspace() {
  return {
    xs: new Float64Array(RAY_GEOMETRY.rows + 1), vs: new Float64Array(RAY_GEOMETRY.rows + 1),
    ids: new Uint32Array(RAY_GEOMETRY.rows * 4), weights: new Float64Array(RAY_GEOMETRY.rows * 4),
    slopes: new Float64Array(RAY_GEOMETRY.rows), kicks: new Float64Array(RAY_GEOMETRY.rows),
    angles: new Float64Array(RAY_GEOMETRY.rows),
  };
}

/**
 * Inference has no operation or target argument. Lookup uses the outer guides
 * outside the board; x, v and the answer remain unbounded. Support is local.
 */
function walk(angles, a, b, work) {
  const A = a / 4.5 - 1;
  const B = b / 4.5 - 1;
  let v = B - A;
  let x = B + RAY_GEOMETRY.initialFlight * v;
  work.xs[0] = x; work.vs[0] = v;
  for (let row = 0; row < RAY_GEOMETRY.rows; row++) {
    const raw = (x + RAY_GEOMETRY.width) / SPACING;
    const u = Math.max(0, Math.min(RAY_GEOMETRY.guides - 1, raw));
    const k = Math.floor(u);
    const s = u - k, s2 = s * s, s3 = s2 * s, t = 1 - s;
    const factor = raw > 0 && raw < RAY_GEOMETRY.guides - 1 ? 1 / SPACING : 0;
    const base = row * 4;
    let angle = 0, slope = 0;
    for (let j = 0; j < 4; j++) {
      const index = Math.max(0, Math.min(RAY_GEOMETRY.guides - 1, k - 1 + j));
      let w, dw;
      if (j === 0) { w = t * t * t / 6; dw = -.5 * t * t; }
      else if (j === 1) { w = (3 * s3 - 6 * s2 + 4) / 6; dw = 1.5 * s2 - 2 * s; }
      else if (j === 2) { w = (-3 * s3 + 3 * s2 + 3 * s + 1) / 6; dw = -1.5 * s2 + s + .5; }
      else { w = s3 / 6; dw = .5 * s2; }
      work.ids[base + j] = index; work.weights[base + j] = w;
      const value = angles[row * RAY_GEOMETRY.guides + index];
      angle += w * value; slope += dw * factor * value;
    }
    const kick = Math.tan(angle);
    v = RAY_GEOMETRY.rho * v + kick;
    x += RAY_GEOMETRY.height * v;
    work.angles[row] = angle; work.slopes[row] = slope; work.kicks[row] = kick;
    work.xs[row + 1] = x; work.vs[row + 1] = v;
  }
  return x;
}
function traceFromWork(a, b, work) {
  return {
    input: { a: a / 4.5 - 1, b: b / 4.5 - 1, v: work.vs[0] },
    rows: Array.from({ length: RAY_GEOMETRY.rows }, (_, row) => ({
      x: work.xs[row], v: work.vs[row], angle: work.angles[row],
      indices: Array.from(work.ids.slice(row * 4, row * 4 + 4)),
      weights: Array.from(work.weights.slice(row * 4, row * 4 + 4)),
      nextX: work.xs[row + 1], nextV: work.vs[row + 1],
    })),
    finalX: work.xs[RAY_GEOMETRY.rows],
  };
}

/** Pure geometric inference, also exported for independent mathematical checks. */
export function localRayForward(parameters, a, b) {
  if (parameters.length !== SIZE) throw new TypeError('Invalid guide count');
  assertFinite(a, 'a'); assertFinite(b, 'b');
  const work = workspace();
  const normalizedValue = walk(effectiveAngles(parameters), a, b, work);
  assertFinite(normalizedValue, 'ray output');
  return { normalizedValue, trace: traceFromWork(a, b, work) };
}

/**
 * Reverse differentiation through the real trajectory. Entries come from
 * observation memory: this function cannot generate labels. A soft edge loss
 * guides training but never clamps the ray or the prediction.
 */
export function localRayLossGradient(parameters, entries, { offset, scale }) {
  if (parameters.length !== SIZE || !entries.length) throw new TypeError('Parameters and observed examples are required');
  const angles = effectiveAngles(parameters);
  const angleGradient = new Float64Array(SIZE), activeMask = new Uint8Array(SIZE);
  const work = workspace(), boardGradient = new Float64Array(RAY_GEOMETRY.rows + 1);
  let loss = 0;
  for (const entry of entries) {
    const output = walk(angles, entry.a, entry.b, work);
    const error = output - (entry.target - offset) / scale;
    loss += error * error;
    for (let row = 0; row <= RAY_GEOMETRY.rows; row++) {
      const x = work.xs[row];
      const excess = Math.max(0, Math.abs(x) - RAY_GEOMETRY.width * .95);
      loss += RAY_GEOMETRY.offboardPenalty * excess * excess;
      boardGradient[row] = 2 * RAY_GEOMETRY.offboardPenalty * excess * Math.sign(x);
    }
    let gx = 2 * error + boardGradient[RAY_GEOMETRY.rows], gv = 0;
    for (let row = RAY_GEOMETRY.rows - 1; row >= 0; row--) {
      const nextVelocityGradient = gv + RAY_GEOMETRY.height * gx;
      const angleDerivative = nextVelocityGradient * (1 + work.kicks[row] * work.kicks[row]);
      for (let j = 0; j < 4; j++) {
        const position = row * 4 + j;
        const index = row * RAY_GEOMETRY.guides + work.ids[position];
        angleGradient[index] += work.weights[position] * angleDerivative;
        if (work.weights[position] !== 0) activeMask[index] = 1;
      }
      gx += angleDerivative * work.slopes[row] + boardGradient[row];
      gv = RAY_GEOMETRY.rho * nextVelocityGradient;
    }
  }
  const gradient = new Float64Array(SIZE), activeIndices = [];
  for (let i = 0; i < SIZE; i++) {
    angleGradient[i] /= entries.length;
    const t = Math.tanh(parameters[i]);
    gradient[i] = angleGradient[i] * RAY_GEOMETRY.angleLimit * (1 - t * t);
    if (activeMask[i]) activeIndices.push(i);
  }
  return { loss: loss / entries.length, gradient, angleGradient, activeIndices };
}

function resolveCurriculum(type, trained, options) {
  const curriculum = (typeof options === 'string' ? options : options?.curriculum) ?? 'auto';
  if (!['auto', 'first', 'small', 'full'].includes(curriculum)) throw new RangeError(`Unknown curriculum: ${curriculum}`);
  if (curriculum !== 'auto') return curriculum;
  if (type === 'add' && trained < 20) return 'first';
  if (type === 'add' && trained < 200) return 'small';
  return 'full';
}
function examples(type, curriculum) {
  if (curriculum === 'first') return [[2, 3]];
  const max = curriculum === 'small' ? 4 : 9, grid = [];
  for (let a = 0; a <= max; a++) for (let b = type === 'div' ? 1 : 0; b <= max; b++) grid.push([a, b]);
  return grid;
}

export class LearningLab {
  constructor({ seed = DEFAULT_SEED } = {}) {
    counter(seed, 'seed', UINT_MAX);
    this.seed = seed;
    this.models = Object.fromEntries(OPERATIONS.map(type => [type, createModel((seed ^ CONFIG[type].salt) >>> 0)]));
  }
  predict(type, a, b) {
    assertOperation(type);
    const result = localRayForward(this.models[type].optimizer.x, a, b);
    const { offset, scale } = CONFIG[type];
    const value = offset + scale * result.normalizedValue;
    assertFinite(value, 'prediction');
    return { ...result, value };
  }

  /** One presentation, at most one accepted optimizer step, no unseen replay. */
  trainSample(type, a, b) {
    assertOperation(type); assertTrainingInputs(type, a, b);
    const model = this.models[type], target = answerKey(type, a, b), entry = { a, b, target };
    const before = this.predict(type, a, b), beforeParameters = model.optimizer.getParameters();
    const beforeAngles = matrix(effectiveAngles(beforeParameters));
    const local = localRayLossGradient(beforeParameters, [entry], CONFIG[type]);
    model.observed.observe(a, b, target);
    const entries = model.observed.entries();
    const aggregate = entries.length === 1 ? local : localRayLossGradient(beforeParameters, entries, CONFIG[type]);
    const step = model.optimizer.step(parameters => localRayLossGradient(parameters, entries, CONFIG[type]), {
      objectiveVersion: model.observed.version, sampleCount: entries.length,
      activeIndices: aggregate.activeIndices,
      // Avoid fitting a tiny prefix with very large geometric changes. The
      // restriction lifts only after every digit pair has actually been seen;
      // neither their labels nor evaluations are added to replay in advance.
      maxParameterChange: entries.length === 1 ? FIRST_STEP_LIMIT
        : entries.length < (type === 'div' ? 90 : 100) ? .003 : null,
    });
    model.trained++;
    const revisionsThisStep = (entries.length - 1) * step.gradientEvaluationsThisStep;
    model.revisions += revisionsThisStep;
    const after = this.predict(type, a, b), afterAngles = matrix(effectiveAngles(model.optimizer.x));
    const updatedPins = step.updatedIndices.map(index => ({
      row: Math.floor(index / RAY_GEOMETRY.guides), index: index % RAY_GEOMETRY.guides,
      before: beforeAngles[Math.floor(index / RAY_GEOMETRY.guides)][index % RAY_GEOMETRY.guides],
      after: afterAngles[Math.floor(index / RAY_GEOMETRY.guides)][index % RAY_GEOMETRY.guides],
    }));
    return {
      type, a, b, target, before: before.value, after: after.value,
      errorBefore: Math.abs(target - before.value), errorAfter: Math.abs(target - after.value),
      beforeTrace: before.trace, trace: after.trace, beforeAngles, afterAngles,
      gradients: { angles: matrix(local.angleGradient), parameters: matrix(local.gradient) },
      updateGradients: { angles: matrix(aggregate.angleGradient), parameters: matrix(aggregate.gradient) },
      updatedPins, revisionSize: entries.length > 1 ? entries.length : 0,
      revisions: model.revisions, revisionsThisStep, trained: model.trained,
      optimizerSteps: model.optimizer.iterations, optimizerStatus: step.status,
      gradientEvaluations: model.optimizer.gradientEvaluations,
      gradientEvaluationsThisStep: step.gradientEvaluationsThisStep,
      exampleEvaluations: model.optimizer.exampleEvaluations,
      lossBefore: step.lossBefore, lossAfter: step.lossAfter,
    };
  }

  train(type, count = 1, options = {}) {
    assertOperation(type); counter(count, 'example count', 1_000_000);
    const model = this.models[type];
    let last = null;
    for (let i = 0; i < count; i++) {
      const curriculum = resolveCurriculum(type, model.trained, options);
      let a = 2, b = 3;
      if (curriculum !== 'first') {
        const size = curriculum === 'small' ? 5 : 10;
        a = Math.floor(random(model) * size);
        b = type === 'div' ? 1 + Math.floor(random(model) * (size - 1)) : Math.floor(random(model) * size);
      }
      last = { ...this.trainSample(type, a, b), curriculum };
    }
    return last;
  }

  /** Measuring a table does not teach it or add its labels to replay memory. */
  evaluate(type, options = {}) {
    assertOperation(type);
    const curriculum = (typeof options === 'string' ? options : options.curriculum) ?? 'full';
    if (!['first', 'small', 'full'].includes(curriculum)) throw new RangeError('Evaluation needs a fixed curriculum');
    const tolerance = (typeof options === 'object' ? options.tolerance : undefined) ?? CONFIG[type].tolerance;
    assertFinite(tolerance, 'tolerance');
    if (tolerance <= 0) throw new RangeError('Tolerance must be positive');
    let sumError = 0, maxError = 0, correct = 0;
    const grid = examples(type, curriculum);
    for (const [a, b] of grid) {
      const error = Math.abs(this.predict(type, a, b).value - answerKey(type, a, b));
      sumError += error; maxError = Math.max(maxError, error);
      if (error <= tolerance) correct++;
    }
    const model = this.models[type];
    return { mae: sumError / grid.length, maxError, accuracy: correct / grid.length,
      correct, total: grid.length, tolerance, curriculum, trained: model.trained,
      observed: model.observed.size, revisions: model.revisions };
  }

  getNetwork(type) {
    assertOperation(type);
    const model = this.models[type];
    return {
      kind: 'local-ray', geometry: { ...RAY_GEOMETRY },
      positions: Array.from({ length: RAY_GEOMETRY.guides }, (_, i) => -RAY_GEOMETRY.width + i * SPACING),
      angles: matrix(effectiveAngles(model.optimizer.x)),
      offset: CONFIG[type].offset, scale: CONFIG[type].scale,
      trained: model.trained, revisions: model.revisions, observed: model.observed.size,
      optimizerSteps: model.optimizer.iterations,
      gradientEvaluations: model.optimizer.gradientEvaluations,
      exampleEvaluations: model.optimizer.exampleEvaluations,
    };
  }

  exportState() {
    const state = { version: STATE_VERSION, kind: 'local-ray', geometry: { ...RAY_GEOMETRY }, seed: this.seed,
      models: Object.fromEntries(OPERATIONS.map(type => {
        const model = this.models[type];
        return [type, { rngState: model.rngState, trained: model.trained, revisions: model.revisions,
          optimizer: model.optimizer.exportState(), observed: model.observed.exportState() }];
      })) };
    validatedModels(state);
    return state;
  }
  restore(state) {
    const candidate = typeof state === 'string' ? JSON.parse(state) : state;
    const models = validatedModels(candidate);
    this.seed = candidate.seed; this.models = models;
    return this;
  }
  static fromState(state) { return new LearningLab().restore(state); }
}

function validatedModels(state) {
  if (!state || state.version !== STATE_VERSION || state.kind !== 'local-ray') throw new TypeError('Unsupported learning save version');
  for (const [key, value] of Object.entries(RAY_GEOMETRY)) if (state.geometry?.[key] !== value) throw new TypeError('Saved guide geometry does not match');
  counter(state.seed, 'seed', UINT_MAX);
  if (!state.models || typeof state.models !== 'object') throw new TypeError('Missing saved guide networks');
  const models = {};
  for (const type of OPERATIONS) {
    const saved = state.models[type];
    if (!saved) throw new TypeError(`Missing ${type} network`);
    counter(saved.rngState, 'random state', UINT_MAX);
    counter(saved.trained, 'presentations'); counter(saved.revisions, 'revisions');
    const optimizer = LBFGS.fromState(saved.optimizer), observed = ObservedExamples.fromState(saved.observed);
    if (optimizer.x.length !== SIZE || saved.trained !== observed.presentations || optimizer.iterations > saved.trained
      || saved.revisions !== optimizer.exampleEvaluations - optimizer.gradientEvaluations
      || (observed.size && optimizer.objectiveVersion !== observed.version)
      || optimizer.sampleCount !== observed.size) throw new TypeError('Inconsistent learning counters or parameters');
    for (const entry of observed.entries()) {
      assertTrainingInputs(type, entry.a, entry.b);
      assertFinite(entry.target, 'observed target');
    }
    models[type] = { rngState: saved.rngState, trained: saved.trained, revisions: saved.revisions, optimizer, observed };
  }
  return models;
}
