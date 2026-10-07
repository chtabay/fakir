import test from 'node:test';
import assert from 'node:assert/strict';
import { LearningLab, OPERATIONS, NETWORK_SIZES } from '../js/learning.js';

test('the tutorial really learns 2 + 3 in 20 examples', () => {
  const lab = new LearningLab();
  const initial = Math.abs(lab.predict('add', 2, 3).value - 5);
  let result;
  for (let click = 0; click < 20; click++) result = lab.train('add');
  const final = Math.abs(lab.predict('add', 2, 3).value - 5);
  assert.ok(initial > 1, `Tutorial should start untrained; error=${initial}`);
  assert.ok(final <= 0.5, `Tutorial error after 20 clicks=${final}`);
  assert.ok(final < initial * 0.2);
  assert.equal(result.trained, 20);
  assert.equal(result.curriculum, 'first');
  assert.deepEqual(result.activations.map(layer => layer.length), NETWORK_SIZES);
  assert.equal(lab.train('add').curriculum, 'small');
  for (const seed of [42, 789, 123456]) {
    const alternate = new LearningLab({ seed });
    alternate.train('add', 20);
    assert.ok(Math.abs(alternate.predict('add', 2, 3).value - 5) < 0.5, `Seed ${seed} failed tutorial`);
  }
});

test('all arithmetic families learn their complete digit grid', () => {
  const lab = new LearningLab();
  const budgets = { add: 10_000, sub: 10_000, mul: 30_000, div: 30_000 };
  for (const type of OPERATIONS) {
    const before = lab.evaluate(type);
    lab.train(type, budgets[type], { curriculum: 'full' });
    const after = lab.evaluate(type);
    console.log(`${type}: MAE ${before.mae.toFixed(3)} → ${after.mae.toFixed(3)}, ${(100 * after.accuracy).toFixed(1)}% within tolerance after ${budgets[type]} examples`);
    assert.ok(after.mae < before.mae * 0.05, `${type}: improvement insufficient`);
    assert.ok(after.accuracy >= 0.90, `${type}: accuracy=${after.accuracy}, MAE=${after.mae}`);
    assert.equal(after.total, type === 'div' ? 90 : 100);
  }
});

test('inference is determined by weights, not the answer key or training counter', () => {
  const lab = new LearningLab();
  const state = lab.exportState();
  for (const type of OPERATIONS) {
    const model = state.models[type];
    model.weights = model.weights.map(layer => layer.map(row => row.map(() => 0)));
    model.biases = model.biases.map(layer => layer.map(() => 0));
    model.biases.at(-1)[0] = 2;
  }
  lab.restore(state);
  for (const type of OPERATIONS) {
    const network = lab.getNetwork(type);
    const expected = network.offset + 2 * network.scale;
    assert.equal(lab.predict(type, 2, 3).value, expected);
    assert.equal(lab.predict(type, 8, 7).value, expected);
    assert.equal(lab.predict(type, 0.5, -2).value, expected);
  }
  assert.ok(lab.predict('mul', 9, 9).value > 81, 'Linear outputs must not be clamped to the digit table');
});

test('training changes parameters; operation memories stay independent', () => {
  const lab = new LearningLab({ seed: 789 });
  const additionBefore = lab.getNetwork('add');
  const divisionBefore = lab.getNetwork('div');
  const sample = lab.trainSample('add', 2, 3);
  assert.notDeepEqual(lab.getNetwork('add').weights, additionBefore.weights);
  assert.deepEqual(lab.getNetwork('div'), divisionBefore);
  assert.equal(sample.target, 5);
  assert.equal(sample.errorBefore, Math.abs(5 - sample.before));
  assert.equal(sample.errorAfter, Math.abs(5 - sample.after));
  assert.ok(sample.gradients.weights.flat(2).some(value => value !== 0));
  const rendererCopy = lab.getNetwork('add');
  rendererCopy.weights[0][0][0] = 12345;
  assert.notEqual(lab.getNetwork('add').weights[0][0][0], 12345);
});

test('backpropagated gradients agree with numerical loss derivatives', () => {
  const lab = new LearningLab({ seed: 101 });
  const state = lab.exportState();
  const { offset, scale } = lab.getNetwork('mul');
  const target = 6 * 7;
  const observed = lab.trainSample('mul', 6, 7);
  const h = 1e-5;
  const lossAt = (layer, row, column, adjustment) => {
    const perturbed = structuredClone(state);
    if (column === null) perturbed.models.mul.biases[layer][row] += adjustment;
    else perturbed.models.mul.weights[layer][row][column] += adjustment;
    const prediction = LearningLab.fromState(perturbed).predict('mul', 6, 7).normalizedValue;
    return 0.5 * (prediction - (target - offset) / scale) ** 2;
  };
  for (const [layer, row, column] of [[0, 3, 1], [1, 4, 3], [2, 0, 8], [0, 3, null], [2, 0, null]]) {
    const numerical = (lossAt(layer, row, column, h) - lossAt(layer, row, column, -h)) / (2 * h);
    const analytical = column === null ? observed.gradients.biases[layer][row] : observed.gradients.weights[layer][row][column];
    assert.ok(Math.abs(numerical - analytical) < 1e-8,
      `Gradient mismatch at ${layer}/${row}/${column}: analytical=${analytical}, numerical=${numerical}`);
  }
});

test('saved Adam moments and random state give an exact deterministic continuation', () => {
  const original = new LearningLab({ seed: 123456 });
  original.train('add', 253);
  original.train('mul', 71);
  const state = original.exportState();
  const restored = LearningLab.fromState(JSON.stringify(state));
  for (const type of OPERATIONS) {
    assert.deepEqual(original.train(type, 50), restored.train(type, 50));
    assert.deepEqual(original.evaluate(type), restored.evaluate(type));
  }
  assert.deepEqual(original.exportState(), restored.exportState());
  const first = new LearningLab({ seed: 42 });
  const second = new LearningLab({ seed: 42 });
  assert.deepEqual(first.train('div', 20), second.train('div', 20));
});

test('evaluation is exhaustive, measured, and has no training side effects', () => {
  const lab = new LearningLab();
  const state = lab.exportState();
  const measured = lab.evaluate('add');
  let sum = 0;
  let correct = 0;
  for (let a = 0; a <= 9; a++) for (let b = 0; b <= 9; b++) {
    const error = Math.abs(lab.predict('add', a, b).value - (a + b));
    sum += error;
    if (error <= 0.5) correct++;
  }
  assert.equal(measured.mae, sum / 100);
  assert.equal(measured.accuracy, correct / 100);
  assert.deepEqual(lab.exportState(), state);
  assert.equal(lab.evaluate('add', 'small').total, 25);
  assert.equal(lab.evaluate('div', 'small').total, 20);
  assert.equal(lab.evaluate('add', 'first').total, 1);
});

test('malformed or nonfinite saves are rejected atomically', () => {
  const lab = new LearningLab();
  lab.train('add', 31);
  const before = lab.exportState();
  for (const value of [NaN, Infinity, -Infinity, '0']) {
    const bad = lab.exportState();
    bad.models.add.weights[0][0][0] = value;
    assert.throws(() => lab.restore(bad));
    assert.deepEqual(lab.exportState(), before);
  }
  const negativeVariance = lab.exportState();
  negativeVariance.models.mul.optimizer.vw[0][0][0] = -1;
  assert.throws(() => lab.restore(negativeVariance));
  const shape = lab.exportState();
  shape.models.div.weights[0].pop();
  assert.throws(() => lab.restore(shape));
  const counters = lab.exportState();
  counters.models.add.trained++;
  assert.throws(() => lab.restore(counters));
  assert.throws(() => lab.trainSample('div', 3, 0));
  assert.throws(() => lab.trainSample('mul', 10, 2));
  assert.throws(() => lab.predict('add', NaN, 2));
  assert.throws(() => lab.train('add', -1));
  assert.throws(() => lab.evaluate('div', { tolerance: 0 }));
  lab.models.add.biases[0][0] = Infinity;
  assert.throws(() => lab.exportState(), 'Export must also reject nonfinite model values');
});
