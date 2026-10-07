/**
 * Fakir's small, genuinely trainable arithmetic networks.
 *
 * Each operation owns a separate 2 → 12 → 12 → 1 MLP. Hidden layers use tanh;
 * the output is linear. `predict` only uses inputs and learned parameters.
 * Arithmetic answer keys are confined to the training and evaluation paths.
 * No packages, network access or DOM are needed.
 */

export const OPERATIONS = Object.freeze(['add', 'sub', 'mul', 'div']);
export const NETWORK_SIZES = Object.freeze([2, 12, 12, 1]);
const STATE_VERSION = 1;
const DEFAULT_SEED = 0xFA41C;
const UINT_MAX = 0xFFFFFFFF;
const CONFIG = Object.freeze({
  add: Object.freeze({ offset: 9, scale: 9, tolerance: 0.5, salt: 0xA1D1 }),
  sub: Object.freeze({ offset: 0, scale: 9, tolerance: 0.5, salt: 0x5AB1 }),
  mul: Object.freeze({ offset: 40.5, scale: 40.5, tolerance: 0.5, salt: 0xAA17 }),
  div: Object.freeze({ offset: 4.5, scale: 4.5, tolerance: 0.15, salt: 0xD171 }),
});

const copy = (value) => JSON.parse(JSON.stringify(value));
const zerosLike = (value) => Array.isArray(value) ? value.map(zerosLike) : 0;

function assertOperation(type) {
  if (!OPERATIONS.includes(type)) throw new RangeError(`Unknown operation: ${type}`);
}

function assertFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
}

function assertTrainingInputs(type, a, b) {
  assertFinite(a, 'a');
  assertFinite(b, 'b');
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || a > 9 || b < 0 || b > 9) {
    throw new RangeError('Training examples must be integer digits from 0 to 9');
  }
  if (type === 'div' && b === 0) throw new RangeError('Division by zero is not a training example');
}

// This is an answer key, never a prediction rule.
function answerKey(type, a, b) {
  if (type === 'add') return a + b;
  if (type === 'sub') return a - b;
  if (type === 'mul') return a * b;
  return a / b;
}

// Mulberry32, with all mutable state held in the model for exact saved replays.
function random(model) {
  model.rngState = (model.rngState + 0x6D2B79F5) >>> 0;
  let t = model.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function createModel(seed) {
  const model = { rngState: seed >>> 0, trained: 0, weights: [], biases: [] };
  for (let l = 1; l < NETWORK_SIZES.length; l++) {
    const fanIn = NETWORK_SIZES[l - 1];
    const fanOut = NETWORK_SIZES[l];
    const limit = Math.sqrt(6 / (fanIn + fanOut));
    const outputFactor = l === NETWORK_SIZES.length - 1 ? 0.15 : 1;
    model.weights.push(Array.from({ length: fanOut }, () =>
      Array.from({ length: fanIn }, () => (random(model) * 2 - 1) * limit * outputFactor)));
    model.biases.push(Array(fanOut).fill(0));
  }
  model.optimizer = {
    step: 0,
    mw: zerosLike(model.weights), vw: zerosLike(model.weights),
    mb: zerosLike(model.biases), vb: zerosLike(model.biases),
  };
  return model;
}

/** Inference only: there is deliberately no operation or target argument. */
function forward(model, a, b) {
  const activations = [[a / 4.5 - 1, b / 4.5 - 1]];
  const preActivations = [];
  for (let l = 0; l < model.weights.length; l++) {
    const input = activations[l];
    const z = model.weights[l].map((row, j) => {
      let sum = model.biases[l][j];
      for (let i = 0; i < input.length; i++) sum += row[i] * input[i];
      return sum;
    });
    preActivations.push(z);
    activations.push(l === model.weights.length - 1 ? z.slice() : z.map(Math.tanh));
  }
  return { normalizedValue: activations.at(-1)[0], activations, preActivations };
}

function backprop(model, activations, target) {
  const last = model.weights.length - 1;
  const deltas = Array(model.weights.length);
  deltas[last] = [activations.at(-1)[0] - target];
  for (let l = last - 1; l >= 0; l--) {
    deltas[l] = activations[l + 1].map((activation, j) => {
      let upstream = 0;
      for (let k = 0; k < deltas[l + 1].length; k++) {
        upstream += model.weights[l + 1][k][j] * deltas[l + 1][k];
      }
      return upstream * (1 - activation * activation);
    });
  }
  const weights = deltas.map((layer, l) => layer.map(delta =>
    activations[l].map(activation => delta * activation)));
  const biases = deltas.map(layer => layer.slice());
  return { weights, biases, deltas };
}

function applyAdam(model, gradients) {
  const opt = model.optimizer;
  opt.step++;
  // Shorter momentum makes the first repeated example visibly settle rather
  // than oscillate past its target for a long time.
  const beta1 = 0.5;
  const beta2 = 0.999;
  const b1Correction = 1 - beta1 ** opt.step;
  const b2Correction = 1 - beta2 ** opt.step;
  const learningRate = 0.006 / (1 + opt.step / 1500);
  const update = (gradient, moment, variance) => {
    // Elementwise gradient clipping; no access to arithmetic answer keys.
    const g = Math.max(-5, Math.min(5, gradient));
    const m = beta1 * moment + (1 - beta1) * g;
    const v = beta2 * variance + (1 - beta2) * g * g;
    const step = learningRate * (m / b1Correction) / (Math.sqrt(v / b2Correction) + 1e-8);
    return [m, v, step];
  };
  for (let l = 0; l < model.weights.length; l++) {
    for (let j = 0; j < model.weights[l].length; j++) {
      for (let i = 0; i < model.weights[l][j].length; i++) {
        const [m, v, step] = update(gradients.weights[l][j][i], opt.mw[l][j][i], opt.vw[l][j][i]);
        opt.mw[l][j][i] = m;
        opt.vw[l][j][i] = v;
        model.weights[l][j][i] -= step;
      }
      const [m, v, step] = update(gradients.biases[l][j], opt.mb[l][j], opt.vb[l][j]);
      opt.mb[l][j] = m;
      opt.vb[l][j] = v;
      model.biases[l][j] -= step;
    }
  }
  return learningRate;
}

function resolveCurriculum(type, trained, options) {
  const requested = typeof options === 'string' ? options : options?.curriculum;
  const curriculum = requested ?? 'auto';
  if (!['auto', 'first', 'small', 'full'].includes(curriculum)) {
    throw new RangeError(`Unknown curriculum: ${curriculum}`);
  }
  if (curriculum !== 'auto') return curriculum;
  if (type === 'add' && trained < 20) return 'first';
  if (type === 'add' && trained < 200) return 'small';
  return 'full';
}

function examples(type, curriculum = 'full') {
  if (curriculum === 'first') return [[2, 3]];
  const max = curriculum === 'small' ? 4 : 9;
  const result = [];
  for (let a = 0; a <= max; a++) {
    for (let b = type === 'div' ? 1 : 0; b <= max; b++) result.push([a, b]);
  }
  return result;
}

function validateArray(value, shape, label, nonNegative = false) {
  if (!Array.isArray(value) || value.length !== shape[0]) throw new TypeError(`Invalid ${label} shape`);
  if (shape.length > 1) {
    value.forEach((v, index) => validateArray(v, shape.slice(1), `${label}[${index}]`, nonNegative));
  } else {
    value.forEach((v) => {
      assertFinite(v, label);
      if (Math.abs(v) > 1e8 || (nonNegative && v < 0)) throw new RangeError(`Invalid ${label} value`);
    });
  }
}

function validateLayers(layers, isWeight, label, nonNegative = false) {
  if (!Array.isArray(layers) || layers.length !== NETWORK_SIZES.length - 1) {
    throw new TypeError(`Invalid ${label} layer count`);
  }
  layers.forEach((layer, l) => validateArray(layer,
    isWeight ? [NETWORK_SIZES[l + 1], NETWORK_SIZES[l]] : [NETWORK_SIZES[l + 1]], label, nonNegative));
}

function validateCounter(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new TypeError(`Invalid ${label}`);
}

function validateState(state) {
  if (!state || state.version !== STATE_VERSION) throw new TypeError('Unsupported learning save version');
  if (!Array.isArray(state.architecture) || state.architecture.join(',') !== NETWORK_SIZES.join(',')) {
    throw new TypeError('Saved network architecture does not match');
  }
  validateCounter(state.seed, 'seed', UINT_MAX);
  if (!state.models || typeof state.models !== 'object') throw new TypeError('Missing saved networks');
  for (const type of OPERATIONS) {
    const model = state.models[type];
    if (!model || !model.optimizer) throw new TypeError(`Missing ${type} network`);
    validateCounter(model.rngState, 'random state', UINT_MAX);
    validateCounter(model.trained, 'trained examples');
    validateCounter(model.optimizer.step, 'optimizer step');
    if (model.optimizer.step !== model.trained) throw new TypeError('Training counters disagree');
    validateLayers(model.weights, true, `${type} weights`);
    validateLayers(model.biases, false, `${type} biases`);
    validateLayers(model.optimizer.mw, true, `${type} first moments`);
    validateLayers(model.optimizer.vw, true, `${type} second moments`, true);
    validateLayers(model.optimizer.mb, false, `${type} bias first moments`);
    validateLayers(model.optimizer.vb, false, `${type} bias second moments`, true);
  }
}

export class LearningLab {
  constructor({ seed = DEFAULT_SEED } = {}) {
    validateCounter(seed, 'seed', UINT_MAX);
    this.seed = seed;
    this.models = Object.fromEntries(OPERATIONS.map(type => [type, createModel((seed ^ CONFIG[type].salt) >>> 0)]));
  }

  /** Returns a freely varying model output; decimal results are never rounded. */
  predict(type, a, b) {
    assertOperation(type);
    assertFinite(a, 'a');
    assertFinite(b, 'b');
    const result = forward(this.models[type], a, b);
    const { offset, scale } = CONFIG[type];
    return { ...result, value: offset + result.normalizedValue * scale };
  }

  /** One example, one Adam update, and before/after evidence for the animation. */
  trainSample(type, a, b) {
    assertOperation(type);
    assertTrainingInputs(type, a, b);
    const model = this.models[type];
    const target = answerKey(type, a, b);
    const before = this.predict(type, a, b);
    const { offset, scale } = CONFIG[type];
    const gradients = backprop(model, before.activations, (target - offset) / scale);
    const learningRate = applyAdam(model, gradients);
    model.trained++;
    const after = this.predict(type, a, b);
    return {
      type, a, b, target, before: before.value, after: after.value,
      errorBefore: Math.abs(target - before.value), errorAfter: Math.abs(target - after.value),
      gradients, activations: after.activations, beforeActivations: before.activations,
      trained: model.trained, learningRate,
    };
  }

  /** Exact count of presented examples. Large counts should be chunked by the UI. */
  train(type, count = 1, options = {}) {
    assertOperation(type);
    validateCounter(count, 'example count', 1_000_000);
    const model = this.models[type];
    let last = null;
    for (let i = 0; i < count; i++) {
      const curriculum = resolveCurriculum(type, model.trained, options);
      let a = 2;
      let b = 3;
      if (curriculum !== 'first') {
        const size = curriculum === 'small' ? 5 : 10;
        a = Math.floor(random(model) * size);
        b = type === 'div' ? 1 + Math.floor(random(model) * (size - 1)) : Math.floor(random(model) * size);
      }
      last = { ...this.trainSample(type, a, b), curriculum };
    }
    return last;
  }

  /** Exhaustive measurement on the requested digit grid, without training. */
  evaluate(type, options = {}) {
    assertOperation(type);
    const curriculum = (typeof options === 'string' ? options : options.curriculum) ?? 'full';
    if (!['first', 'small', 'full'].includes(curriculum)) throw new RangeError('Evaluation needs a fixed curriculum');
    const tolerance = (typeof options === 'object' ? options.tolerance : undefined) ?? CONFIG[type].tolerance;
    assertFinite(tolerance, 'tolerance');
    if (tolerance <= 0) throw new RangeError('Tolerance must be positive');
    let sumError = 0;
    let maxError = 0;
    let correct = 0;
    const grid = examples(type, curriculum);
    for (const [a, b] of grid) {
      const error = Math.abs(this.predict(type, a, b).value - answerKey(type, a, b));
      sumError += error;
      maxError = Math.max(maxError, error);
      if (error <= tolerance) correct++;
    }
    return {
      mae: sumError / grid.length, maxError, accuracy: correct / grid.length,
      correct, total: grid.length, tolerance, curriculum, trained: this.models[type].trained,
    };
  }

  /** Copies ensure renderer code cannot accidentally mutate the trained model. */
  getNetwork(type) {
    assertOperation(type);
    const model = this.models[type];
    return {
      sizes: NETWORK_SIZES.slice(), weights: copy(model.weights), biases: copy(model.biases),
      trained: model.trained, offset: CONFIG[type].offset, scale: CONFIG[type].scale,
    };
  }

  exportState() {
    const state = { version: STATE_VERSION, architecture: NETWORK_SIZES.slice(), seed: this.seed, models: this.models };
    validateState(state);
    return copy(state);
  }

  /** Validation completes before touching the current state, so failure is atomic. */
  restore(state) {
    const candidate = typeof state === 'string' ? JSON.parse(state) : state;
    validateState(candidate);
    const clean = copy(candidate);
    this.seed = clean.seed;
    this.models = Object.fromEntries(OPERATIONS.map(type => [type, clean.models[type]]));
    return this;
  }

  static fromState(state) {
    return new LearningLab().restore(state);
  }
}
