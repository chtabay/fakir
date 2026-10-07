import test from 'node:test';
import assert from 'node:assert/strict';
import { LBFGS, ObservedExamples } from '../js/optimizer.js';

const rosenbrock = p => {
  const [x, y] = p;
  return { loss: (1 - x) ** 2 + 100 * (y - x * x) ** 2, gradient: [-2 * (1 - x) - 400 * x * (y - x * x), 200 * (y - x * x)] };
};

test('L-BFGS solves a nonconvex curved valley with genuine decreasing accepted steps', () => {
  const optimizer = new LBFGS([-1.2, 1]);
  let previous = Infinity;
  for (let i = 0; i < 200; i++) {
    const step = optimizer.step(rosenbrock, { objectiveVersion: 'rosenbrock', sampleCount: 1 });
    assert.ok(step.lossAfter <= previous + 1e-14);
    previous = step.lossAfter;
    if (step.status.startsWith('converged')) break;
  }
  const p = optimizer.getParameters();
  assert.ok(Math.abs(p[0] - 1) < 1e-5 && Math.abs(p[1] - 1) < 1e-5, `Final parameters: ${p}`);
  assert.ok(optimizer.gradientEvaluations >= optimizer.iterations);
  assert.equal(optimizer.exampleEvaluations, optimizer.gradientEvaluations);
});

test('active indices guarantee strictly local updates even with earlier curvature history', () => {
  const objective = p => ({ loss: (p[0] - 2) ** 2 + 3 * (p[1] - p[0]) ** 2, gradient: [2 * (p[0] - 2) - 6 * (p[1] - p[0]), 6 * (p[1] - p[0])] });
  const optimizer = new LBFGS([8, -4]);
  optimizer.step(objective, { objectiveVersion: 'same', sampleCount: 1 });
  const frozen = optimizer.getParameters()[1];
  for (let i = 0; i < 8; i++) {
    const step = optimizer.step(objective, { objectiveVersion: 'same', sampleCount: 1, activeIndices: [0] });
    assert.equal(optimizer.getParameters()[1], frozen);
    assert.ok(step.updatedIndices.every(index => index === 0));
  }
});

test('a parameter-change limit bounds every accepted line-search step', () => {
  const optimizer = new LBFGS([0, 0]);
  const objective = p => ({ loss: (p[0] - 50) ** 2 + (p[1] + 20) ** 2,
    gradient: [2 * (p[0] - 50), 2 * (p[1] + 20)] });
  for (let i = 0; i < 10; i++) {
    const step = optimizer.step(objective, { maxParameterChange: .003 });
    assert.ok(step.lossAfter < step.lossBefore);
    for (let j = 0; j < 2; j++) assert.ok(Math.abs(step.afterParameters[j] - step.beforeParameters[j]) <= .003 + 1e-15);
  }
});

test('only explicitly observed examples enter replay; objective changes preserve weights', () => {
  const memory = new ObservedExamples();
  const optimizer = new LBFGS([0]);
  memory.observe(2, 3, 5);
  const seenByOracle = [];
  const objective = p => {
    const entries = memory.entries();
    seenByOracle.push(entries.map(row => [row.a, row.b]));
    return {
      loss: entries.reduce((sum, row) => sum + 0.5 * (p[0] - row.target) ** 2, 0) / entries.length,
      gradient: [entries.reduce((sum, row) => sum + p[0] - row.target, 0) / entries.length],
    };
  };
  optimizer.step(objective, { objectiveVersion: memory.version, sampleCount: memory.size });
  assert.ok(Math.abs(optimizer.getParameters()[0] - 5) < 1e-9);
  assert.equal(memory.presentations, 1);
  assert.equal(memory.size, 1);
  assert.ok(seenByOracle.every(pairs => JSON.stringify(pairs) === '[[2,3]]'));
  const previous = optimizer.getParameters();
  const version = memory.version;
  memory.observe(2, 3, 5);
  assert.equal(memory.version, version);
  memory.observe(2, 1, 3);
  let firstParameters = null;
  optimizer.step(p => { firstParameters ??= Array.from(p); return objective(p); }, { objectiveVersion: memory.version, sampleCount: memory.size });
  assert.deepEqual(firstParameters, Array.from(previous));
  assert.ok(Math.abs(optimizer.getParameters()[0] - 4) < 1e-9);
  assert.equal(memory.presentations, 3);
  assert.equal(memory.size, 2);
});

test('saving parameters, objective cache and curvature gives exact deterministic continuation', () => {
  const first = new LBFGS([-1.2, 1]);
  for (let i = 0; i < 12; i++) first.step(rosenbrock, { objectiveVersion: 1, sampleCount: 7 });
  const second = LBFGS.fromState(JSON.stringify(first.exportState()));
  for (let i = 0; i < 15; i++) {
    assert.deepEqual(first.step(rosenbrock, { objectiveVersion: 1, sampleCount: 7 }), second.step(rosenbrock, { objectiveVersion: 1, sampleCount: 7 }));
  }
  assert.deepEqual(first.exportState(), second.exportState());
  assert.equal(first.exampleEvaluations, first.gradientEvaluations * 7);
});

test('line-search trials cannot mutate accepted parameters; evaluation budgets are explicit', () => {
  const optimizer = new LBFGS([1]);
  const objective = p => p[0] === 1 ? { loss: 1, gradient: [1] } : { loss: Infinity, gradient: [NaN] };
  const step = optimizer.step(objective, { maxEvaluations: 4, objectiveVersion: 'restricted-domain', sampleCount: 3 });
  assert.equal(step.status, 'line_search_failed');
  assert.equal(step.gradientEvaluationsThisStep, 4);
  assert.equal(step.exampleEvaluationsThisStep, 12);
  assert.deepEqual(Array.from(optimizer.getParameters()), [1]);
  const external = optimizer.getParameters(); external[0] = 999;
  assert.equal(optimizer.getParameters()[0], 1);
});

test('malformed optimizer and observation saves are rejected', () => {
  const optimizer = new LBFGS([2, 3]);
  const saved = optimizer.exportState();
  for (const value of [NaN, Infinity, -Infinity, '0']) {
    const bad = structuredClone(saved); bad.parameters[0] = value;
    assert.throws(() => LBFGS.fromState(bad));
  }
  const inconsistent = structuredClone(saved); inconsistent.iterations = 2;
  assert.throws(() => LBFGS.fromState(inconsistent));
  assert.throws(() => optimizer.step(rosenbrock, { activeIndices: [2] }));
  const memory = new ObservedExamples();
  memory.observe(2, 3, 5); memory.observe(2, 3, 5); memory.observe(2, 1, 3);
  const restored = ObservedExamples.fromState(JSON.stringify(memory.exportState()));
  assert.deepEqual(restored.exportState(), memory.exportState());
  const entries = restored.entries(); entries[0].target = 99;
  assert.equal(restored.entries()[0].target, 5);
  assert.throws(() => restored.observe(2, 3, 7));
  const badMemory = memory.exportState(); badMemory.records[0].count++;
  assert.throws(() => ObservedExamples.fromState(badMemory));
});
