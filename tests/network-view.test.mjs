import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkView } from '../js/network-view.js';
import { LearningLab } from '../js/learning.js';

function eventTarget(properties = {}) {
  const listeners = new Map();
  return {
    ...properties,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type) { for (const listener of [...(listeners.get(type) ?? [])]) listener(); },
  };
}

function fakeCanvas() {
  let now = 0, nextFrame = 1;
  const frames = new Map(), attributes = new Map();
  const media = eventTarget({ matches: false });
  const win = eventTarget({
    devicePixelRatio: 1,
    performance: { now: () => now },
    matchMedia: () => media,
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  const doc = eventTarget({ hidden: false, defaultView: win });
  const context = new Proxy({}, {
    get: (object, key) => key in object ? object[key] : () => {},
    set: (object, key, value) => (object[key] = value, true),
  });
  const canvas = {
    ownerDocument: doc,
    getContext: () => context,
    getBoundingClientRect: () => ({ width: 720, height: 680 }),
    setAttribute: (name, value) => attributes.set(name, value),
  };
  return {
    canvas, doc, media, frames, attributes,
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, callback] of [...frames]) {
        if (!frames.delete(id)) continue;
        callback(now);
      }
    },
  };
}

function fixture() {
  const env = fakeCanvas(), lab = new LearningLab();
  const view = new NetworkView(env.canvas);
  view.setState({
    network: lab.getNetwork('add'), prediction: lab.predict('add', 2, 3),
    example: { type: 'add', a: 2, b: 3, target: 5 },
  });
  const launches = [[2, 3], [1, 4], [9, 7]].map(([a, b]) => {
    const sample = lab.trainSample('add', a, b);
    return { sample, network: lab.getNetwork('add') };
  });
  return { env, lab, view, launches };
}

const launch = (view, item) => view.animate(item.sample, item.network);

test('finishImmediately commits the actual after snapshot and releases the caller exactly once', () => {
  const { env, view, launches: [first] } = fixture();
  const events = [];
  let locked = true;
  view.onSample = (sample, phase) => {
    events.push([sample.trained, phase]);
    if (phase === 'after') locked = false;
  };
  launch(view, first);
  assert.equal(env.frames.size, 1);
  assert.deepEqual(events, [[1, 'before']]);
  view.finishImmediately();
  assert.equal(locked, false);
  assert.equal(view.active, null);
  assert.equal(view.queued, null);
  assert.equal(env.frames.size, 0);
  assert.equal(view.state.prediction.value, first.sample.after);
  assert.deepEqual(view.state.prediction.trace, first.sample.trace);
  assert.deepEqual(view.state.network.angles, first.sample.afterAngles);
  view.finishImmediately();
  env.advance(20_000);
  assert.deepEqual(events, [[1, 'before'], [1, 'after']]);
  view.destroy();
});

test('normal coalescence finishes the visible cycle then uses the exact latest queued sample', () => {
  const { env, view, launches: [first, discarded, latest] } = fixture();
  const events = [];
  view.onSample = (sample, phase) => events.push([sample.trained, phase]);
  launch(view, first); launch(view, discarded); launch(view, latest);
  assert.equal(view.active.sample, first.sample);
  assert.equal(view.queued.sample, latest.sample);
  assert.deepEqual(view.state.network.angles, first.sample.afterAngles);
  env.advance(5600);
  assert.deepEqual(events, [[1, 'before'], [1, 'after'], [3, 'before']]);
  assert.equal(view.active.sample, latest.sample);
  assert.deepEqual(view.active.sample.beforeTrace, latest.sample.beforeTrace);
  assert.deepEqual(view.state.network.angles, latest.sample.afterAngles);
  env.advance(5600);
  assert.deepEqual(events, [[1, 'before'], [1, 'after'], [3, 'before'], [3, 'after']]);
  assert.equal(view.state.prediction.value, latest.sample.after);
  assert.deepEqual(view.state.prediction.trace, latest.sample.trace);
  assert.deepEqual(view.state.example, { type: 'add', a: 9, b: 7, target: 16 });
  assert.equal(view.active, null);
  assert.equal(env.frames.size, 0);
  view.destroy();
});

test('reduced motion interrupts a queue with one after callback for its latest snapshot', () => {
  const { env, view, launches: [first, discarded, latest] } = fixture();
  const events = [];
  let locked = true;
  view.onSample = (sample, phase) => {
    events.push([sample.trained, phase]);
    if (phase === 'after') locked = false;
  };
  launch(view, first); launch(view, discarded); launch(view, latest);
  env.advance(400);
  env.media.matches = true;
  env.media.emit('change');
  assert.equal(locked, false);
  assert.deepEqual(events, [[1, 'before'], [3, 'after']]);
  assert.deepEqual(view.state.network.angles, latest.sample.afterAngles);
  assert.deepEqual(view.state.prediction.trace, latest.sample.trace);
  assert.equal(view.state.prediction.value, latest.sample.after);
  assert.equal(view.active, null);
  assert.equal(view.queued, null);
  assert.equal(env.frames.size, 0);
  env.media.emit('change');
  env.advance(20_000);
  assert.deepEqual(events, [[1, 'before'], [3, 'after']]);
  view.destroy();
});

test('an after callback can replace state at a milestone without restarting a stale queued cycle', () => {
  const { env, lab, view, launches: [first, queued] } = fixture();
  const events = [];
  let locked = true, milestonePassed = false;
  const milestone = {
    network: lab.getNetwork('sub'), prediction: lab.predict('sub', 3, 1),
    example: { type: 'sub', a: 3, b: 1, target: 2 },
  };
  view.onSample = (sample, phase) => {
    events.push([sample.type, sample.trained, phase]);
    locked = phase === 'before';
    if (phase === 'after' && !milestonePassed) {
      milestonePassed = true;
      view.setState(milestone);
    }
  };
  launch(view, first); launch(view, queued);
  env.advance(5600);
  assert.equal(locked, false);
  assert.deepEqual(events, [['add', 1, 'before'], ['add', 1, 'after']]);
  assert.equal(view.state.prediction, milestone.prediction);
  assert.deepEqual(view.state.example, milestone.example);
  assert.equal(view.active, null);
  assert.equal(view.queued, null);
  assert.equal(env.frames.size, 0);
  const nextSample = lab.trainSample('sub', 3, 1);
  view.animate(nextSample, lab.getNetwork('sub'));
  assert.equal(locked, true);
  env.advance(5600);
  assert.equal(locked, false);
  assert.deepEqual(events.slice(-2), [['sub', 1, 'before'], ['sub', 1, 'after']]);
  assert.equal(view.state.prediction.value, nextSample.after);
  view.destroy();
});

test('a hidden document completes the pending correction and cannot issue a stale callback later', () => {
  const { env, view, launches: [first] } = fixture();
  const events = [];
  view.onSample = (_sample, phase) => events.push(phase);
  launch(view, first);
  env.doc.hidden = true;
  env.doc.emit('visibilitychange');
  assert.deepEqual(events, ['before', 'after']);
  assert.equal(view.state.prediction.value, first.sample.after);
  assert.equal(env.frames.size, 0);
  env.doc.hidden = false;
  env.doc.emit('visibilitychange');
  env.advance(20_000);
  assert.deepEqual(events, ['before', 'after']);
  view.destroy();
});
