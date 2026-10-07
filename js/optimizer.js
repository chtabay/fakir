/**
 * Small deterministic L-BFGS optimizer, with a bounded strong-Wolfe line search.
 * It knows neither arithmetic operations nor answer keys. The caller supplies a
 * pure objective over examples that the player has already encountered.
 *
 * A presentation, an accepted optimizer step, and a gradient evaluation are
 * separate events. Counters deliberately preserve that distinction.
 */
const DEFAULTS = Object.freeze({
  memorySize: 10, gradientTolerance: 1e-9, functionTolerance: 1e-14,
  stepTolerance: 1e-13, maxLineSearch: 30, c1: 1e-4, c2: 0.9, maxStep: 64,
});
const dot = (a, b) => {
  let value = 0;
  for (let i = 0; i < a.length; i++) value += a[i] * b[i];
  return value;
};
const normInfinity = a => {
  let value = 0;
  for (let i = 0; i < a.length; i++) value = Math.max(value, Math.abs(a[i]));
  return value;
};
const copyVector = a => Float64Array.from(a);
const isVector = a => Array.isArray(a) || a instanceof Float64Array || a instanceof Float32Array;

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
}

function counter(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new TypeError(`Invalid ${name}`);
}

function vector(value, length, name) {
  if (!isVector(value) || value.length !== length) throw new TypeError(`Invalid ${name} dimension`);
  for (let i = 0; i < value.length; i++) finite(value[i], name);
}

function objectiveKey(value) {
  if (typeof value === 'string' && value.length > 0 && value.length <= 200) return;
  counter(value, 'objective version');
}

function optionsWithDefaults(options = {}) {
  const result = { ...DEFAULTS, ...options };
  counter(result.memorySize, 'memory size', 100);
  counter(result.maxLineSearch, 'line-search budget', 100);
  if (!result.memorySize || !result.maxLineSearch) throw new RangeError('Optimizer budgets must be positive');
  for (const key of ['gradientTolerance', 'functionTolerance', 'stepTolerance', 'c1', 'c2', 'maxStep']) finite(result[key], key);
  if (result.gradientTolerance < 0 || result.functionTolerance < 0 || result.stepTolerance <= 0
      || !(result.c1 > 0 && result.c1 < result.c2 && result.c2 < 1) || result.maxStep <= 0) {
    throw new RangeError('Invalid L-BFGS options');
  }
  return result;
}

/** Limited-memory BFGS. `getParameters()` returns the last accepted state only. */
export class LBFGS {
  constructor(parameters, options = {}) {
    if (!isVector(parameters) || !parameters.length || parameters.length > 100000) throw new TypeError('A parameter vector is required');
    vector(parameters, parameters.length, 'parameters');
    this.options = optionsWithDefaults(options);
    this.x = copyVector(parameters);
    this.loss = null;
    this.gradient = null;
    this.history = [];
    this.objectiveVersion = null;
    this.sampleCount = 0;
    this.iterations = 0;
    this.gradientEvaluations = 0;
    this.exampleEvaluations = 0;
    this.objectiveChanges = 0;
  }

  getParameters() { return copyVector(this.x); }

  /** Forget stale curvature and objective values; never reinitialize parameters. */
  invalidateObjective(version, sampleCount = this.sampleCount) {
    objectiveKey(version);
    counter(sampleCount, 'sample count');
    this.objectiveVersion = version;
    this.sampleCount = sampleCount;
    this.loss = null;
    this.gradient = null;
    this.history = [];
    this.objectiveChanges++;
  }

  evaluate(oracle, parameters, allowInvalid = false) {
    this.gradientEvaluations++;
    this.exampleEvaluations += this.sampleCount;
    const result = oracle(parameters);
    if (!result || !isVector(result.gradient) || result.gradient.length !== this.x.length) {
      throw new TypeError('Objective must return {loss, gradient} with the parameter dimension');
    }
    const valid = typeof result.loss === 'number' && Number.isFinite(result.loss)
      && Array.from(result.gradient).every(value => typeof value === 'number' && Number.isFinite(value));
    if (!valid) {
      if (allowInvalid) return null;
      throw new TypeError('Objective and gradient must be finite at the accepted parameters');
    }
    return { loss: result.loss, gradient: copyVector(result.gradient) };
  }

  direction(activeMask) {
    const q = copyVector(this.gradient);
    const alpha = new Float64Array(this.history.length);
    for (let k = this.history.length - 1; k >= 0; k--) {
      const pair = this.history[k];
      alpha[k] = pair.rho * dot(pair.s, q);
      for (let i = 0; i < q.length; i++) q[i] -= alpha[k] * pair.y[i];
    }
    const last = this.history.at(-1);
    const yy = last ? dot(last.y, last.y) : 0;
    const gamma = last && yy > 0 ? Math.min(1e8, Math.max(1e-8, dot(last.s, last.y) / yy)) : 1;
    for (let i = 0; i < q.length; i++) q[i] *= gamma;
    for (let k = 0; k < this.history.length; k++) {
      const pair = this.history[k];
      const beta = pair.rho * dot(pair.y, q);
      for (let i = 0; i < q.length; i++) q[i] += pair.s[i] * (alpha[k] - beta);
    }
    for (let i = 0; i < q.length; i++) q[i] = !activeMask || activeMask[i] ? -q[i] : 0;
    const derivative = dot(q, this.gradient);
    if (!Number.isFinite(derivative) || derivative >= 0) {
      this.history = [];
      for (let i = 0; i < q.length; i++) q[i] = !activeMask || activeMask[i] ? -this.gradient[i] : 0;
    }
    return q;
  }

  lineSearch(oracle, direction, budget, maxStep = this.options.maxStep) {
    const { c1, c2, stepTolerance } = this.options;
    const initialDerivative = dot(this.gradient, direction);
    if (!(initialDerivative < 0) || budget <= 0) return null;
    const base = { alpha: 0, loss: this.loss, gradient: this.gradient, derivative: initialDerivative, parameters: this.x };
    let remaining = budget;
    let best = null;
    const armijo = point => Number.isFinite(point.loss)
      && point.loss <= base.loss + c1 * point.alpha * initialDerivative;
    const trial = alpha => {
      if (remaining <= 0) return null;
      remaining--;
      const parameters = this.x.map((value, i) => value + alpha * direction[i]);
      const evaluated = this.evaluate(oracle, parameters, true);
      const point = evaluated
        ? { ...evaluated, alpha, parameters, derivative: dot(evaluated.gradient, direction) }
        : { alpha, parameters, loss: Infinity, gradient: null, derivative: NaN };
      if (armijo(point) && point.loss < base.loss && (!best || point.loss < best.loss)) best = point;
      return point;
    };
    const zoom = (lowStart, highStart) => {
      let low = lowStart;
      let high = highStart;
      while (remaining > 0) {
        const lower = Math.min(low.alpha, high.alpha);
        const upper = Math.max(low.alpha, high.alpha);
        const width = upper - lower;
        if (width <= stepTolerance * Math.max(1, Math.abs(lower), Math.abs(upper))) break;
        // Safeguarded quadratic interpolation; fall back to bisection when a
        // trial is invalid or the fitted parabola points outside the bracket.
        const distance = high.alpha - low.alpha;
        const denominator = 2 * (high.loss - low.loss - low.derivative * distance);
        let alpha = low.alpha - low.derivative * distance * distance / denominator;
        if (!Number.isFinite(alpha) || alpha < lower + width * 0.1 || alpha > upper - width * 0.1) alpha = (lower + upper) / 2;
        const point = trial(alpha);
        if (!point) break;
        if (!armijo(point) || point.loss >= low.loss) {
          high = point;
        } else {
          if (Math.abs(point.derivative) <= -c2 * initialDerivative) return { ...point, wolfeSatisfied: true };
          if (point.derivative * (high.alpha - low.alpha) >= 0) high = low;
          low = point;
        }
      }
      return best ? { ...best, wolfeSatisfied: false } : null;
    };
    let previous = base;
    let alpha = Math.min(1, maxStep);
    while (remaining > 0) {
      const point = trial(alpha);
      if (!point) break;
      if (!armijo(point) || (previous.alpha > 0 && point.loss >= previous.loss)) return zoom(previous, point);
      if (Math.abs(point.derivative) <= -c2 * initialDerivative) return { ...point, wolfeSatisfied: true };
      if (point.derivative >= 0) return zoom(point, previous);
      previous = point;
      if (alpha === maxStep) break;
      alpha = Math.min(maxStep, alpha * 2);
    }
    return best ? { ...best, wolfeSatisfied: false } : null;
  }

  /**
   * One accepted iteration at most. An objective version identifies the exact
   * dataset/weighting, not just its size. No line-search trial mutates live state.
   * `activeIndices` optionally restricts every parameter update to local pins.
   */
  step(oracle, { objectiveVersion = 0, sampleCount = 1, maxEvaluations = this.options.maxLineSearch + 1, activeIndices = null, maxParameterChange = null } = {}) {
    if (typeof oracle !== 'function') throw new TypeError('An objective function is required');
    objectiveKey(objectiveVersion);
    counter(sampleCount, 'sample count');
    counter(maxEvaluations, 'evaluation budget', 1000);
    if (!sampleCount || !maxEvaluations) throw new RangeError('Step budgets must be positive');
    if (maxParameterChange !== null) {
      finite(maxParameterChange, 'maximum parameter change');
      if (!(maxParameterChange > 0)) throw new RangeError('Maximum parameter change must be positive');
    }
    let activeMask = null;
    if (activeIndices !== null) {
      if (!Array.isArray(activeIndices) && !(activeIndices instanceof Uint32Array)) throw new TypeError('activeIndices must be an index array');
      activeMask = new Uint8Array(this.x.length);
      for (const index of activeIndices) {
        counter(index, 'active parameter index', this.x.length - 1);
        activeMask[index] = 1;
      }
    }
    if (objectiveVersion !== this.objectiveVersion || sampleCount !== this.sampleCount) this.invalidateObjective(objectiveVersion, sampleCount);
    const evaluationsBefore = this.gradientEvaluations;
    const exampleEvaluationsBefore = this.exampleEvaluations;
    const beforeParameters = this.getParameters();
    if (!this.gradient) {
      const evaluated = this.evaluate(oracle, this.getParameters());
      this.loss = evaluated.loss;
      this.gradient = evaluated.gradient;
    }
    const lossBefore = this.loss;
    const gradientBefore = copyVector(this.gradient);
    const projectedGradient = this.gradient.map((value, index) => !activeMask || activeMask[index] ? value : 0);
    const report = (status, extra = {}) => ({
      status, lossBefore, lossAfter: this.loss, beforeParameters, afterParameters: this.getParameters(),
      gradientBefore, gradientAfter: copyVector(this.gradient), updatedIndices: [],
      gradientNorm: normInfinity(projectedGradient), iterations: this.iterations,
      gradientEvaluations: this.gradientEvaluations, exampleEvaluations: this.exampleEvaluations,
      gradientEvaluationsThisStep: this.gradientEvaluations - evaluationsBefore,
      exampleEvaluationsThisStep: this.exampleEvaluations - exampleEvaluationsBefore,
      objectiveVersion: this.objectiveVersion, ...extra,
    });
    if (normInfinity(projectedGradient) <= this.options.gradientTolerance) return report('converged_gradient');
    const budget = Math.min(this.options.maxLineSearch, maxEvaluations - (this.gradientEvaluations - evaluationsBefore));
    if (budget <= 0) return report('evaluation_budget');
    const direction = this.direction(activeMask);
    // Bound the whole search interval, not merely its first trial. This keeps
    // tutorial updates small even when the Wolfe search would expand its step.
    const maxStep = maxParameterChange === null ? this.options.maxStep
      : Math.min(this.options.maxStep, maxParameterChange / normInfinity(direction));
    const accepted = this.lineSearch(oracle, direction, budget, maxStep);
    if (!accepted) return report('line_search_failed');
    const s = new Float64Array(this.x.length);
    const y = new Float64Array(this.x.length);
    const updatedIndices = [];
    for (let i = 0; i < this.x.length; i++) {
      s[i] = accepted.parameters[i] - this.x[i];
      y[i] = accepted.gradient[i] - this.gradient[i];
      if (s[i] !== 0) updatedIndices.push(i);
    }
    const sy = dot(s, y);
    const curvatureScale = Math.sqrt(dot(s, s)) * Math.sqrt(dot(y, y));
    if (Number.isFinite(sy) && sy > 0 && sy > 1e-12 * curvatureScale && Number.isFinite(1 / sy)) {
      this.history.push({ s, y, rho: 1 / sy });
      if (this.history.length > this.options.memorySize) this.history.shift();
    }
    this.x = copyVector(accepted.parameters);
    this.loss = accepted.loss;
    this.gradient = copyVector(accepted.gradient);
    this.iterations++;
    const smallImprovement = Math.abs(lossBefore - this.loss)
      <= this.options.functionTolerance * Math.max(1, Math.abs(lossBefore), Math.abs(this.loss));
    return report(smallImprovement ? 'converged_loss' : 'accepted', {
      updatedIndices, stepSize: accepted.alpha, parameterChangeNorm: Math.sqrt(dot(s, s)),
      wolfeSatisfied: accepted.wolfeSatisfied,
      gradientNorm: normInfinity(this.gradient.map((value, index) => !activeMask || activeMask[index] ? value : 0)),
    });
  }

  exportState() {
    const state = {
      version: 1, parameters: Array.from(this.x), options: { ...this.options },
      loss: this.loss, gradient: this.gradient ? Array.from(this.gradient) : null,
      history: this.history.map(pair => ({ s: Array.from(pair.s), y: Array.from(pair.y), rho: pair.rho })),
      objectiveVersion: this.objectiveVersion, sampleCount: this.sampleCount,
      iterations: this.iterations, gradientEvaluations: this.gradientEvaluations,
      exampleEvaluations: this.exampleEvaluations, objectiveChanges: this.objectiveChanges,
    };
    validateOptimizerState(state);
    return state;
  }

  static fromState(state) {
    const parsed = typeof state === 'string' ? JSON.parse(state) : state;
    validateOptimizerState(parsed);
    const optimizer = new LBFGS(parsed.parameters, parsed.options);
    optimizer.loss = parsed.loss;
    optimizer.gradient = parsed.gradient ? copyVector(parsed.gradient) : null;
    optimizer.history = parsed.history.map(pair => ({ s: copyVector(pair.s), y: copyVector(pair.y), rho: pair.rho }));
    for (const key of ['objectiveVersion', 'sampleCount', 'iterations', 'gradientEvaluations', 'exampleEvaluations', 'objectiveChanges']) optimizer[key] = parsed[key];
    return optimizer;
  }
}

function validateOptimizerState(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.parameters) || !state.parameters.length || state.parameters.length > 100000) throw new TypeError('Invalid optimizer save');
  const size = state.parameters.length;
  vector(state.parameters, size, 'saved parameters');
  const options = optionsWithDefaults(state.options);
  if (state.objectiveVersion !== null) objectiveKey(state.objectiveVersion);
  if ((state.loss === null) !== (state.gradient === null)) throw new TypeError('Incomplete objective cache');
  if (state.loss !== null) { finite(state.loss, 'saved loss'); vector(state.gradient, size, 'saved gradient'); }
  if (!Array.isArray(state.history) || state.history.length > options.memorySize) throw new TypeError('Invalid curvature history');
  for (const pair of state.history) {
    vector(pair.s, size, 'saved displacement'); vector(pair.y, size, 'saved gradient difference'); finite(pair.rho, 'saved curvature');
    const sy = dot(pair.s, pair.y);
    if (!(sy > 0) || !(pair.rho > 0) || Math.abs(pair.rho * sy - 1) > 1e-8) throw new TypeError('Invalid curvature pair');
  }
  for (const key of ['sampleCount', 'iterations', 'gradientEvaluations', 'exampleEvaluations', 'objectiveChanges']) counter(state[key], key);
  if (state.iterations > state.gradientEvaluations || (state.gradient !== null && state.objectiveVersion === null)) throw new TypeError('Inconsistent optimizer counters or cache');
}

/**
 * Balanced replay memory: one target per distinct encountered pair. Repeated
 * presentations are counted but do not silently change the replay objective.
 */
export class ObservedExamples {
  constructor({ capacity = 100 } = {}) {
    counter(capacity, 'observation capacity', 100000);
    if (!capacity) throw new RangeError('Observation capacity must be positive');
    this.capacity = capacity;
    this.records = [];
    this.index = new Map();
    this.presentations = 0;
    this.version = 0;
  }

  get size() { return this.records.length; }

  observe(a, b, target) {
    finite(a, 'a'); finite(b, 'b'); finite(target, 'target');
    const key = JSON.stringify([a, b]);
    const existing = this.index.get(key);
    if (existing !== undefined) {
      const record = this.records[existing];
      if (record.target !== target) throw new TypeError('An observed pair cannot change its target');
      this.presentations++;
      record.count++;
      record.lastPresentation = this.presentations;
      return { added: false, version: this.version, size: this.size, presentations: this.presentations };
    }
    if (this.size >= this.capacity) throw new RangeError('Observed example capacity exceeded');
    this.presentations++;
    const record = { a, b, target, count: 1, firstPresentation: this.presentations, lastPresentation: this.presentations };
    this.index.set(key, this.records.length);
    this.records.push(record);
    this.version++;
    return { added: true, version: this.version, size: this.size, presentations: this.presentations };
  }

  entries() { return this.records.map(({ a, b, target }) => ({ a, b, target })); }

  exportState() {
    const state = { version: 1, capacity: this.capacity, presentations: this.presentations, objectiveVersion: this.version, records: this.records.map(record => ({ ...record })) };
    validateObservedState(state);
    return state;
  }

  static fromState(state) {
    const parsed = typeof state === 'string' ? JSON.parse(state) : state;
    validateObservedState(parsed);
    const memory = new ObservedExamples({ capacity: parsed.capacity });
    memory.records = parsed.records.map(record => ({ ...record }));
    memory.records.forEach((record, index) => memory.index.set(JSON.stringify([record.a, record.b]), index));
    memory.presentations = parsed.presentations;
    memory.version = parsed.objectiveVersion;
    return memory;
  }
}

function validateObservedState(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.records)) throw new TypeError('Invalid observed examples save');
  counter(state.capacity, 'observation capacity', 100000);
  counter(state.presentations, 'presentations'); counter(state.objectiveVersion, 'objective version');
  if (!state.capacity || state.records.length > state.capacity || state.objectiveVersion !== state.records.length) throw new TypeError('Inconsistent observation counts');
  const keys = new Set();
  let count = 0;
  let previousFirst = 0;
  for (const record of state.records) {
    finite(record.a, 'observed a'); finite(record.b, 'observed b'); finite(record.target, 'observed target');
    counter(record.count, 'pair presentation count'); counter(record.firstPresentation, 'first presentation'); counter(record.lastPresentation, 'last presentation');
    const key = JSON.stringify([record.a, record.b]);
    if (keys.has(key) || !record.count || record.firstPresentation <= previousFirst
        || record.lastPresentation < record.firstPresentation || record.lastPresentation > state.presentations) throw new TypeError('Invalid observation record');
    keys.add(key); previousFirst = record.firstPresentation; count += record.count;
  }
  if (count !== state.presentations) throw new TypeError('Presentation counters disagree');
}
