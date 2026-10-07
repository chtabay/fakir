import test from 'node:test';
import assert from 'node:assert/strict';
import { GameSession, CHAPTERS, FAMILIES, UPGRADES } from '../js/game-state.js';

const saved = game => {
  const state = game.exportState();
  delete state.savedAt;
  return state;
};

function assertEconomy(game) {
  assert.equal(game.data.balance, game.data.earned - game.data.spent);
  assert.ok(Number.isSafeInteger(game.data.balance) && game.data.balance >= 0);
  const rewards = CHAPTERS.slice(0, game.data.phase).reduce((sum, chapter) => sum + chapter.reward, 0);
  assert.equal(game.data.earned, game.total + rewards);
  const purchases = UPGRADES.reduce((sum, upgrade) => sum
    + upgrade.prices.slice(0, game.data.upgrades[upgrade.id]).reduce((a, b) => a + b, 0), 0);
  assert.equal(game.data.spent, purchases);
}

function measureAndAdvance(game, milestones) {
  const metrics = game.refreshMetrics();
  const chapter = game.chapter;
  const trained = game.lab.getNetwork(chapter.family).trained;
  const previous = game.data.phase;
  const milestone = game.checkMilestone();
  if (milestone && milestones) milestones.push({
    phase: previous,
    family: chapter.family,
    samples: trained,
    accuracy: metrics.accuracy,
    mae: Number(metrics.mae.toFixed(6)),
    maxError: Number(metrics.maxError.toFixed(6)),
    balance: game.data.balance,
  });
  assertEconomy(game);
  return milestone;
}

function affordableUpgrade(game, focus) {
  return UPGRADES.filter(upgrade => (focus || upgrade.id !== 'focus')
    && game.total >= upgrade.minExamples
    && game.data.phase >= upgrade.minPhase
    && upgrade.prices[game.data.upgrades[upgrade.id]] !== undefined
    && upgrade.prices[game.data.upgrades[upgrade.id]] <= game.data.balance)
    .sort((a, b) => a.prices[game.data.upgrades[a.id]] - b.prices[game.data.upgrades[b.id]])[0];
}

/** One player click per simulated second plus the purchased dispenser rate. */
function career({ focus = true, stopPhase = 6, budget = 50_000 } = {}) {
  const game = new GameSession();
  const actions = [];
  const milestones = [];
  let seconds = 0;
  const start = performance.now();
  function train(count, manual) {
    if (!count) return;
    const remaining = budget - game.trained;
    assert.ok(remaining > 0, `Blocage à la phase ${game.data.phase} (${game.data.family}) : ${JSON.stringify(game.metrics)}`);
    const actual = Math.min(count, remaining);
    game.train(actual, { manual });
    actions.push({ action: 'train', count: actual, manual });
    measureAndAdvance(game, milestones);
  }
  while (game.data.phase < stopPhase && seconds < 20_000) {
    const upgrade = affordableUpgrade(game, focus);
    if (upgrade) {
      assert.equal(game.purchase(upgrade.id), true);
      actions.push({ action: 'purchase', id: upgrade.id });
      assertEconomy(game);
    }
    train(game.clickPower, true);
    if (game.data.phase < stopPhase) train(game.autoRate, false);
    seconds++;
  }
  assert.equal(game.data.phase, stopPhase, `Le parcours doit atteindre la phase ${stopPhase}.`);
  const samples = Object.fromEntries(Object.keys(FAMILIES).map(type => [type, game.lab.getNetwork(type).trained]));
  for (const value of Object.values(samples)) assert.ok(value <= budget);
  return { game, actions, milestones, seconds, samples, milliseconds: performance.now() - start };
}

test('économie : aucun achat sans fonds, chaque exemple et chaque achat sont comptés', () => {
  const game = new GameSession();
  assert.equal(game.purchase('batch'), false);
  assert.equal(game.purchase('unknown'), false);
  game.train(8, { manual: true });
  assert.equal(game.purchase('batch'), false, 'Le premier achat coûte 16, même après huit exemples.');
  assert.equal(game.data.balance, 8);
  assert.equal(game.data.spent, 0);
  assert.equal(game.data.upgrades.batch, 0);
  game.train(8, { manual: true });
  assert.equal(game.purchase('batch'), true);
  assert.equal(game.clickPower, 2);
  assert.equal(game.data.balance, 0);
  assert.equal(game.data.manualClicks, 2);
  assert.equal(game.purchase('batch'), false);
  assert.equal(game.purchase('auto'), false);
  game.train(55);
  assert.equal(game.purchase('batch'), true);
  assert.equal(game.clickPower, 4);
  assert.equal(game.data.spent, 71);
  assertEconomy(game);
});

test('verrouillages : familles, répertoire, phase et fonds sont indépendants', () => {
  const game = new GameSession();
  assert.deepEqual(game.unlocked, ['add']);
  assert.equal(game.selectFamily('sub'), false);
  assert.equal(game.selectFamily('mul'), false);
  assert.equal(game.selectFamily('div'), false);
  assert.equal(game.selectFamily('unknown'), false);
  assert.equal(game.selectExample(4, 3), false);
  assert.equal(game.selectExample(2, 3), true);
  assert.equal(game.selectExample(-1, 3), false);
  assert.equal(game.selectExample(2.5, 3), false);
  assert.equal(game.checkMilestone(), null);
  game.train(500);
  game.train(100);
  assert.equal(game.data.balance, 600);
  assert.equal(game.purchase('focus'), false, 'Les fonds ne remplacent pas le déblocage du chapitre.');
  measureAndAdvance(game);
  assert.equal(game.data.phase, 1);
  assert.equal(game.curriculum, 'small');
  assert.equal(game.metrics.total, 25);
  assert.equal(game.selectExample(4, 4), true);
  assert.equal(game.selectExample(5, 4), false);
  assert.equal(game.selectFamily('sub'), false);
  assertEconomy(game);
});

test('limite des lots et refus des lots vides sans altération des compteurs', () => {
  const game = new GameSession();
  assert.equal(game.train(0, { manual: true }), null);
  assert.equal(game.train(-5, { manual: true }), null);
  assert.equal(game.data.manualClicks, 0);
  game.train(1000, { manual: true });
  assert.equal(game.total, 500);
  assert.equal(game.data.manualClicks, 1);
  game.train(3.9);
  assert.equal(game.total, 503);
  assertEconomy(game);
});

test('sauvegarde JSON : poids, optimiseur, aléatoire et progression reprennent exactement', () => {
  const { game } = career({ stopPhase: 4 });
  assert.equal(game.data.upgrades.focus, 1);
  game.selectExample(3, 8);
  game.train(29, { manual: true });
  game.train(37);
  // Save between two UI measurements, as the autosave timer can actually do.
  // The weak-case cache must not silently change the post-restore curriculum.
  const restored = new GameSession().restore(JSON.stringify(game.exportState()));
  assert.deepEqual(saved(restored), saved(game));
  assert.deepEqual(restored.metrics, game.metrics);
  assert.deepEqual(restored.weakCases, game.weakCases);
  assert.deepEqual(restored.data.selected, { a: 3, b: 8 });
  for (let index = 0; index < 12; index++) {
    const count = 7 + index;
    const manual = index % 3 === 0;
    assert.deepEqual(restored.train(count, { manual }), game.train(count, { manual }));
    measureAndAdvance(game);
    measureAndAdvance(restored);
    assert.deepEqual(saved(restored), saved(game));
  }
});

test('imports incohérents : refus atomique des soldes, familles ou poids invalides', () => {
  const game = new GameSession();
  game.train(8);
  const before = saved(game);
  const badBalance = structuredClone(before);
  badBalance.game.balance++;
  assert.throws(() => game.restore(badBalance), /incohérente/);
  assert.deepEqual(saved(game), before);
  const locked = structuredClone(before);
  locked.game.family = 'div';
  assert.throws(() => game.restore(locked), /non disponible/);
  assert.deepEqual(saved(game), before);
  const badLearning = structuredClone(before);
  badLearning.learning.version = -1;
  assert.throws(() => game.restore(badLearning));
  assert.deepEqual(saved(game), before);
});

test('parcours réel avec focus : phase 6 sous 50 000 exemples par famille, achats payés et replay exact', t => {
  const run = career({ focus: true });
  assert.equal(run.game.data.upgrades.focus, 1);
  assert.deepEqual(run.milestones.map(item => item.phase), [0, 1, 2, 3, 4, 5]);
  const replay = new GameSession();
  for (const action of run.actions) {
    if (action.action === 'purchase') assert.equal(replay.purchase(action.id), true);
    else {
      replay.train(action.count, { manual: action.manual });
      measureAndAdvance(replay);
    }
  }
  assert.deepEqual(saved(replay), saved(run.game));
  assertEconomy(replay);
  t.diagnostic(JSON.stringify({ focus: true, simulatedSeconds: run.seconds, samples: run.samples,
    milliseconds: Math.round(run.milliseconds), upgrades: run.game.data.upgrades,
    balance: run.game.data.balance, earned: run.game.data.earned, spent: run.game.data.spent,
    milestones: run.milestones }));
});

test('parcours témoin sans focus : progression possible sans répétition ciblée', t => {
  const run = career({ focus: false });
  assert.equal(run.game.data.upgrades.focus, 0);
  assertEconomy(run.game);
  t.diagnostic(JSON.stringify({ focus: false, simulatedSeconds: run.seconds, samples: run.samples,
    milliseconds: Math.round(run.milliseconds), upgrades: run.game.data.upgrades,
    balance: run.game.data.balance, earned: run.game.data.earned, spent: run.game.data.spent,
    milestones: run.milestones }));
});
