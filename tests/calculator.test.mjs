import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExpression } from '../js/calculator.js';

// An exact oracle belongs only in the tests. Production uses lab.predict.
const truth = (type, a, b) => ({ add: () => a + b, sub: () => a - b, mul: () => a * b, div: () => a / b })[type]();
const oracle = { predict: (type, a, b) => ({ value: truth(type, a, b), activations: [] }) };
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} doit être proche de ${expected} (tolérance ${tolerance})`);

test('addition : les retenues ne sont pas comptées deux fois dans le brut', () => {
  const out = evaluateExpression('38+47', oracle);
  assert.equal(out.result, 85);
  assert.equal(out.estimate, 85);
  assert.deepEqual(out.uses, ['add']);
  assert.ok(out.trace.some(line => line.includes('retenue entrante 1')));
  assert.equal(evaluateExpression('999 + 1', oracle).result, 1000);
});

test('multiplication : produits partiels et addition sont appris', () => {
  const out = evaluateExpression('23 × 14', oracle);
  assert.equal(out.result, 322);
  assert.equal(out.estimate, 322);
  assert.deepEqual(out.uses, ['mul', 'add']);
  assert.equal(evaluateExpression('99x99', oracle).estimate, 9801);
  near(evaluateExpression('999,99 * 999,99', oracle).estimate, 999980.0001);
});

test('soustraction : emprunts et résultats négatifs', () => {
  for (const [expression, expected] of [['38−47', -9], ['100-1', 99], ['100-99', 1], ['-12--3', -9], ['1--2', 3]]) {
    const out = evaluateExpression(expression, oracle);
    assert.equal(out.result, expected, expression);
    assert.equal(out.estimate, expected, expression);
  }
  assert.ok(evaluateExpression('100-1', oracle).trace.some(line => line.includes('emprunt entrant 1')));
});

test('décimales, signes et séparateurs sont alignés sans calcul natif final', () => {
  for (const [expression, expected] of [['-12,50 + 2.25', -10.25], ['1,2 + 0.03', 1.23], ['.25 × -.04', -.01], ['+2,5 * -4', -10], ['0,1+0,2', .3]]) {
    const out = evaluateExpression(expression, oracle);
    near(out.result, expected);
    near(out.estimate, expected);
  }
});

test('division posée : quotient inférieur, reste appris et quatre décimales', () => {
  const out = evaluateExpression('8÷3', oracle);
  assert.equal(out.result, 2.6667);
  near(out.estimate, 8 / 3);
  assert.ok(out.uses.includes('mul'));
  assert.ok(out.uses.includes('sub'));
  assert.ok(out.uses.includes('div'));
  assert.equal(evaluateExpression('999,99 / 0,01', oracle).result, 99999);
  assert.equal(evaluateExpression('-12,5 / +2,5', oracle).result, -5);
  assert.equal(evaluateExpression('0/9', oracle).result, 0);
});

test('composition exacte sur une grille de nombres signés et décimaux', () => {
  const values = [-99, -12.5, -1, -.04, 0, .2, 2.5, 47, 99.99];
  for (const a of values) for (const b of values) {
    for (const [symbol, expected] of [['+', a + b], ['-', a - b], ['*', a * b]]) {
      const out = evaluateExpression(`${a}${symbol}${b}`, oracle);
      near(out.result, expected, 1e-8);
      near(out.estimate, expected, 1e-8);
    }
    if (b !== 0) {
      const out = evaluateExpression(`${a}/${b}`, oracle);
      near(out.result, Math.sign(a / b) * Math.round(Math.abs(a / b) * 1e4 + 1e-9) / 1e4, 1e-8);
      near(out.estimate, a / b, 1.01e-6);
    }
  }
});

test('les biais neuronaux influencent la réponse, y compris le brut', () => {
  const biased = { predict: (type, a, b) => ({ value: truth(type, a, b) + 1 }) };
  const sum = evaluateExpression('38+47', biased);
  assert.notEqual(sum.result, 85);
  assert.notEqual(sum.estimate, 85);
  const product = evaluateExpression('23*14', biased);
  assert.notEqual(product.result, 322);
  assert.notEqual(product.estimate, 322);

  const biasedProducts = { predict: (type, a, b) => ({ value: truth(type, a, b) + (type === 'mul' ? 2 : 0) }) };
  const division = evaluateExpression('8/3', biasedProducts);
  assert.ok(Number.isFinite(division.estimate));
  assert.notEqual(division.result, 2.6667);
});

test('un petit biais reste visible dans l’estimation même après arrondi', () => {
  const slight = { predict: (type, a, b) => ({ value: truth(type, a, b) + .01 }) };
  const out = evaluateExpression('38+47', slight);
  assert.equal(out.result, 85);
  near(out.estimate, 85.11);
  const product = evaluateExpression('23*14', slight);
  assert.equal(product.result, 322);
  assert.notEqual(product.estimate, 322);
});

test('les sous-calculs envoyés aux réseaux restent dans les tables de chiffres', () => {
  let calls = 0;
  const checked = { predict(type, a, b) {
    assert.ok(Number.isInteger(a) && a >= 0 && a <= 9);
    assert.ok(Number.isInteger(b) && b >= 0 && b <= 9);
    assert.ok(type !== 'div' || b !== 0);
    calls++;
    return { value: truth(type, a, b) };
  } };
  for (const expression of ['999,99+12,3', '999,99*-99,99', '-123,45/6,78', '7/3', '99-100']) {
    evaluateExpression(expression, checked);
  }
  assert.ok(calls > 100);
});

test('parseur : aucun terme surnuméraire, code ou notation non prise en charge', () => {
  for (const expression of ['1+2+3', '2**3', '2/3/4', '1e3+2', '1000+1', '1.234+2', '(1+2)', '1+2;globalThis.pwned=true', '<script>1+2</script>', 'NaN+1', '1 2+3', '', 'alert(1)', '2^3']) {
    assert.throws(() => evaluateExpression(expression, oracle), /Saisis/, expression);
  }
  assert.equal(globalThis.pwned, undefined);
});

test('division par zéro : erreur explicite pour toutes les écritures admises', () => {
  for (const expression of ['8/0', '0÷0', '2/-0,00', '1/+0.0']) {
    assert.throws(() => evaluateExpression(expression, oracle), /division par zéro/, expression);
  }
});

test('déblocages : le calcul respecte aussi ses dépendances apprises', () => {
  assert.equal(evaluateExpression('3+4', oracle, ['add']).result, 7);
  assert.equal(evaluateExpression('3-0', oracle, ['sub']).result, 3);
  assert.equal(evaluateExpression('8/3', oracle, ['sub', 'mul', 'div']).result, 2.6667);
  assert.throws(() => evaluateExpression('3*4', oracle, ['add']), /multiplication.*débloquée/);
  assert.throws(() => evaluateExpression('3+-4', oracle, ['add']), /soustraction.*débloquée/);
});

test('réseau très mal appris : terminaison bornée ou erreur exploitable', () => {
  const zero = { predict: () => ({ value: 0 }) };
  const out = evaluateExpression('8/3', zero);
  assert.ok(Number.isFinite(out.result));
  assert.notEqual(out.result, 2.6667);
  assert.ok(out.trace.length <= 65);
  for (const value of [NaN, Infinity, 1e9, '4']) {
    assert.throws(() => evaluateExpression('38+47', { predict: () => ({ value }) }), /exploitable/);
  }
});
