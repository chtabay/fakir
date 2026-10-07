import test from 'node:test';
import assert from 'node:assert/strict';
import { LearningLab, OPERATIONS, RAY_GEOMETRY, localRayForward, localRayLossGradient } from '../js/learning.js';

const seeds = [1025052, 42, 789, 123456, 2026];
const close = (actual, expected, tolerance = 1e-11) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('the first case learns gradually from random angles, with strictly local changes', () => {
  for (const seed of seeds) {
    const lab = new LearningLab({ seed });
    const initial = lab.predict('add', 2, 3).value;
    assert.ok(Math.abs(initial - 5) > 1);
    let previousError = Math.abs(initial - 5);
    let learnedAt = null;
    for (let click = 1; click <= 30; click++) {
      const beforeParameters = lab.models.add.optimizer.getParameters();
      const previousAngles = lab.getNetwork('add').angles;
      const sample = lab.train('add', 1, { curriculum: 'first' });
      const afterParameters = lab.models.add.optimizer.getParameters();
      assert.deepEqual(sample.beforeAngles, previousAngles);
      assert.deepEqual(sample.afterAngles, lab.getNetwork('add').angles);
      assert.equal(sample.errorAfter, Math.abs(sample.after - 5));
      assert.ok(sample.errorAfter <= previousError + 1e-10);
      previousError = sample.errorAfter;
      if (sample.errorAfter <= .35 && learnedAt === null) learnedAt = click;
      for (let row = 0; row < RAY_GEOMETRY.rows; row++) {
        const active = new Set(sample.beforeTrace.rows[row].indices);
        for (let pin = 0; pin < RAY_GEOMETRY.guides; pin++) {
          const index = row * RAY_GEOMETRY.guides + pin;
          const change = afterParameters[index] - beforeParameters[index];
          assert.ok(Math.abs(change) <= .004 + 1e-14);
          if (!active.has(pin)) assert.equal(change, 0, 'An unvisited guide cannot change during a single-case update');
        }
      }
      assert.equal(sample.revisions, 0);
      assert.equal(sample.revisionSize, 0);
    }
    assert.ok(learnedAt >= 10 && learnedAt <= 30, `${seed}: first success at ${learnedAt}`);
    assert.ok(previousError < .01);
    assert.equal(lab.getNetwork('add').trained, 30);
    assert.equal(lab.models.add.observed.size, 1);
  }
});

test('geometric inference obeys the actual local guides and preserves both inputs', () => {
  const lab = new LearningLab();
  const parameters = new Float64Array(RAY_GEOMETRY.rows * RAY_GEOMETRY.guides);
  for (const [a, b] of [[2,3], [2,1], [1,2], [8,7], [.5,-2], [99,99]]) {
    const result = localRayForward(parameters, a, b);
    const A = a / 4.5 - 1, B = b / 4.5 - 1;
    // Even many rows with zero kicks return to the initial impact position.
    close(result.normalizedValue, B + .25 * (B - A));
    for (const row of result.trace.rows) {
      close(row.weights.reduce((sum, weight) => sum + weight, 0), 1);
      assert.ok(new Set(row.indices).size <= 4);
      assert.ok(row.weights.every(weight => weight >= 0));
      close(row.nextV, -row.v + Math.tan(row.angle));
      close(row.nextX, row.x + .7 * row.nextV);
    }
  }
  assert.notEqual(localRayForward(parameters, 1, 2).normalizedValue, localRayForward(parameters, 2, 3).normalizedValue,
    'Equal entry slopes do not erase their different positions');
  for (const type of OPERATIONS) lab.models[type].optimizer.x.fill(0);
  const expectedPosition = localRayForward(parameters, 2, 3).normalizedValue;
  for (const type of OPERATIONS) {
    const network = lab.getNetwork(type);
    close(lab.predict(type, 2, 3).value, network.offset + network.scale * expectedPosition);
  }
  assert.ok(lab.predict('mul', 99, 99).value > 81, 'There is no hidden output clamp');
  const before = lab.predict('mul', 2, 3).value;
  const activePin = lab.predict('mul', 2, 3).trace.rows[7].indices[1];
  lab.models.mul.optimizer.x[7 * RAY_GEOMETRY.guides + activePin] = .1;
  assert.notEqual(lab.predict('mul', 2, 3).value, before, 'An actual guide causally changes the answer');
});

test('all analytic parameter gradients include interpolation, tanh and the edge loss', () => {
  const lab = new LearningLab({ seed: 42 });
  const parameters = lab.models.mul.optimizer.getParameters();
  // Include a deliberately off-board trajectory to exercise the soft penalty.
  const entries = [{ a: 1.1, b: 4.4, target: 4.84 }, { a: 8.2, b: 6.1, target: 50.02 }, { a: -2, b: 12, target: -24 }];
  const config = lab.getNetwork('mul');
  const analytical = localRayLossGradient(parameters, entries, config);
  let worst = 0;
  for (let index = 0; index < parameters.length; index++) {
    const plus = parameters.slice(), minus = parameters.slice();
    plus[index] += 1e-6; minus[index] -= 1e-6;
    const numerical = (localRayLossGradient(plus, entries, config).loss - localRayLossGradient(minus, entries, config).loss) / 2e-6;
    worst = Math.max(worst, Math.abs(numerical - analytical.gradient[index]));
  }
  assert.ok(worst < 1e-7, `Maximum gradient disagreement: ${worst}`);
});

test('a continuous career learns all tables from only the cases actually presented', () => {
  const lab = new LearningLab();
  lab.train('add', 20, { curriculum: 'first' });
  assert.equal(lab.models.add.observed.size, 1);
  lab.train('add', 380, { curriculum: 'small' });
  assert.ok(lab.evaluate('add', 'small').accuracy >= .8);
  assert.ok(lab.models.add.observed.entries().every(({a,b}) => a <= 4 && b <= 4));
  for (const type of OPERATIONS) {
    const initial = lab.evaluate(type);
    const budget = type === 'div' ? 12_000 : 4000;
    lab.train(type, 4000 - lab.getNetwork(type).trained, { curriculum: 'full' });
    let measured = lab.evaluate(type);
    // As in the game, pass the threshold when it is actually measured. The
    // optimized squared error decreases, but a discrete tolerance count can
    // fluctuate as individual cases cross either side of its boundary.
    while (type === 'div' && measured.accuracy < .9 && measured.trained < budget) {
      lab.train(type, 100, { curriculum: 'full' });
      measured = lab.evaluate(type);
    }
    assert.ok(measured.accuracy >= (type === 'mul' ? .97 : .9), `${type}: ${JSON.stringify(measured)}`);
    assert.ok(measured.mae < initial.mae * .15);
    assert.equal(measured.total, type === 'div' ? 90 : 100);
    assert.equal(lab.models[type].observed.size, measured.total);
    const network = lab.getNetwork(type);
    assert.equal(network.trained, measured.trained);
    assert.ok(network.trained <= budget);
    assert.ok(network.optimizerSteps <= network.trained);
    assert.equal(network.revisions, network.exampleEvaluations - network.gradientEvaluations);
  }
});

test('new examples preserve existing parameters and expose aggregate replay changes', () => {
  const lab = new LearningLab({ seed: 789 });
  lab.train('add', 20, { curriculum: 'first' });
  const division = lab.getNetwork('div');
  const previous = lab.getNetwork('add').angles;
  const prediction = lab.predict('add', 2, 1);
  const sample = lab.trainSample('add', 2, 1);
  assert.deepEqual(sample.beforeAngles, previous, 'A new case must not reset the machine');
  assert.deepEqual(sample.beforeTrace, prediction.trace);
  assert.equal(sample.before, prediction.value);
  assert.equal(sample.revisionSize, 2);
  assert.ok(sample.revisionsThisStep > 0);
  assert.deepEqual(lab.models.add.observed.entries(), [{a:2,b:3,target:5},{a:2,b:1,target:3}]);
  assert.deepEqual(lab.getNetwork('div'), division);
  const changed = [];
  const current = lab.getNetwork('add').angles;
  for (let row = 0; row < 8; row++) for (let index = 0; index < 17; index++) {
    if (previous[row][index] !== current[row][index]) changed.push({row,index,before:previous[row][index],after:current[row][index]});
  }
  assert.deepEqual(sample.updatedPins, changed);
  const rendererCopy = lab.getNetwork('add'); rendererCopy.angles[0][0] = 12345;
  assert.notEqual(lab.getNetwork('add').angles[0][0], 12345);
});

test('saving preserves guide parameters, replay memory, optimizer and random continuation', () => {
  const original = new LearningLab({ seed: 123456 });
  original.train('add', 253); original.train('mul', 71);
  const restored = LearningLab.fromState(JSON.stringify(original.exportState()));
  for (const type of OPERATIONS) {
    assert.deepEqual(original.train(type, 50), restored.train(type, 50));
    assert.deepEqual(original.evaluate(type), restored.evaluate(type));
  }
  assert.deepEqual(original.exportState(), restored.exportState());
  const first = new LearningLab({ seed: 42 }), second = new LearningLab({ seed: 42 });
  assert.deepEqual(first.train('div', 20), second.train('div', 20));
});

test('evaluation measures the exhaustive table without adding any observations', () => {
  const lab = new LearningLab();
  lab.train('add', 12, { curriculum: 'first' });
  const state = lab.exportState(), measured = lab.evaluate('add');
  let sum = 0, correct = 0;
  for (let a = 0; a <= 9; a++) for (let b = 0; b <= 9; b++) {
    const error = Math.abs(lab.predict('add', a, b).value - (a + b));
    sum += error;
    if (error <= .5) correct++;
  }
  assert.equal(measured.mae, sum / 100); assert.equal(measured.accuracy, correct / 100);
  assert.deepEqual(lab.exportState(), state);
  assert.equal(lab.models.add.observed.size, 1);
  assert.equal(lab.evaluate('add', 'small').total, 25);
  assert.equal(lab.evaluate('div', 'small').total, 20);
  assert.equal(lab.evaluate('add', 'first').total, 1);
});

test('malformed saves, invalid observations and nonfinite parameters fail atomically', () => {
  const lab = new LearningLab(); lab.train('add', 31);
  const before = lab.exportState();
  for (const value of [NaN, Infinity, -Infinity, '0']) {
    const bad = structuredClone(before); bad.models.add.optimizer.parameters[0] = value;
    assert.throws(() => lab.restore(bad)); assert.deepEqual(lab.exportState(), before);
  }
  const badShape = structuredClone(before); badShape.models.div.optimizer.parameters.pop();
  assert.throws(() => lab.restore(badShape));
  const badCounter = structuredClone(before); badCounter.models.add.trained++;
  assert.throws(() => lab.restore(badCounter));
  const badObservation = structuredClone(before); badObservation.models.add.observed.records[0].target = NaN;
  assert.throws(() => lab.restore(badObservation));
  const badGeometry = structuredClone(before); badGeometry.geometry.guides++;
  assert.throws(() => lab.restore(badGeometry));
  assert.throws(() => lab.restore({version:1}));
  assert.throws(() => lab.trainSample('div', 3, 0));
  assert.throws(() => lab.trainSample('mul', 10, 2));
  assert.throws(() => lab.predict('add', NaN, 2));
  assert.throws(() => lab.train('add', -1));
  assert.throws(() => lab.evaluate('div', { tolerance: 0 }));
  lab.models.add.optimizer.x[0] = Infinity;
  assert.throws(() => lab.exportState());
});
