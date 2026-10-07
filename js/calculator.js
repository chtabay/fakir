/**
 * Compose learned digit operations without consulting an arithmetic answer.
 *
 * The host supplies parsing, signs, place values, comparisons, rounding and the
 * carry/borrow rules. Only lab.predict(type, digitA, digitB).value supplies the
 * elementary sum, difference, product or division estimate. These composition
 * rules are provided to the machine; this module does not claim it learned them.
 *
 * Inputs: two signed operands, at most three integer and two fractional digits.
 * Division uses learned long division with six fractional digits internally,
 * then rounds to four places. A learned one-digit division suggests a quotient
 * when applicable; learned products check it and learned subtraction updates
 * the remainder. Poor networks can give incorrect results. A negative decoded
 * remainder is explicitly bounded at zero so calculation can continue; invalid
 * or excessively large predictions raise a French error instead of looping.
 *
 * `estimate` retains unrounded primitive estimates for +, − and ×, without
 * counting carries twice. For ÷ it is the long-division estimate before the
 * final four-place rounding. `result` is the value decoded for use in subsequent
 * arithmetic; it is never replaced by a native calculation of the expression.
 * `uses` lists the network IDs actually consulted, in first-use order.
 */

const LABELS = { add: 'addition', sub: 'soustraction', mul: 'multiplication', div: 'division' };
const SYMBOLS = { add: '+', sub: '−', mul: '×', div: '÷' };
const TYPES = { '+': 'add', '-': 'sub', '−': 'sub', '×': 'mul', x: 'mul', X: 'mul', '*': 'mul', '÷': 'div', '/': 'div' };
const NUMBER = '[+\\-−]?(?:\\d{1,3}(?:[.,]\\d{1,2})?|[.,]\\d{1,2})';
const EXPRESSION = new RegExp(`^\\s*(${NUMBER})\\s*([+\\-−×xX*÷/])\\s*(${NUMBER})\\s*$`);
const MAX_INTEGER = 1e12;
const MAX_PREDICTION = 1e4;
const FRACTION_DIGITS = 6;
const TRACE_LIMIT = 64;

const cleanZero = value => Object.is(value, -0) ? 0 : value;
const format = value => cleanZero(value).toLocaleString('fr-FR', {
  useGrouping: false, minimumFractionDigits: 0, maximumFractionDigits: 6,
});

function operand(text) {
  const normalized = text.replace('−', '-').replace(',', '.');
  const negative = normalized.startsWith('-');
  const unsigned = normalized.replace(/^[+-]/, '');
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const coefficient = Number(`${whole || '0'}${fraction}`);
  return { sign: negative ? -1 : 1, coefficient, scale: fraction.length };
}

function integer(value) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_INTEGER) {
    throw new Error('Les estimations du réseau dépassent la plage de composition. Entraîne encore la machine.');
  }
  return cleanZero(value);
}

function finite(value) {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_INTEGER * 100) {
    throw new Error('Le réseau ne produit pas encore une estimation exploitable.');
  }
  return cleanZero(value);
}

function context(lab, unlockedTypes) {
  if (!lab || typeof lab.predict !== 'function') {
    throw new Error('Le moteur d’apprentissage est indisponible.');
  }
  const unlocked = new Set(unlockedTypes);
  const trace = [];
  const uses = new Set();
  let omitted = false;
  return {
    trace, uses,
    require(type) {
      if (!unlocked.has(type)) {
        throw new Error(`L’opération « ${LABELS[type]} » n’est pas encore débloquée.`);
      }
    },
    note(message) {
      if (trace.length < TRACE_LIMIT) trace.push(message);
      else if (!omitted) {
        trace.push('Les étapes suivantes emploient les mêmes règles de composition.');
        omitted = true;
      }
    },
    predict(type, a, b) {
      this.require(type);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || a > 9 || b < 0 || b > 9 || (type === 'div' && b === 0)) {
        throw new Error('Un sous-calcul sort de la table des chiffres.');
      }
      const value = lab.predict(type, a, b)?.value;
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_PREDICTION) {
        throw new Error(`Le réseau de ${LABELS[type]} ne fournit pas une estimation exploitable.`);
      }
      uses.add(type);
      return value;
    },
  };
}

/** Carry is a positional transfer: do not add it again to the raw estimate. */
function digitOperation(a, b, type, ctx, details = true) {
  integer(a); integer(b);
  const left = String(a).split('').reverse().map(Number);
  const right = String(b).split('').reverse().map(Number);
  const length = Math.max(left.length, right.length);
  let carry = 0;
  let result = 0;
  let estimate = 0;
  for (let index = 0; index < length; index++) {
    const da = left[index] || 0;
    const db = right[index] || 0;
    const raw = ctx.predict(type, da, db);
    const incoming = carry;
    const rounded = Math.round(raw + incoming);
    const digit = ((rounded % 10) + 10) % 10;
    carry = Math.floor(rounded / 10);
    const place = 10 ** index;
    estimate += raw * place;
    result += digit * place;
    if (details) {
      const transfer = type === 'sub'
        ? `emprunt entrant ${-incoming}, emprunt sortant ${-carry}`
        : `retenue entrante ${incoming}, retenue sortante ${carry}`;
      ctx.note(`Position 10^${index} : ${da} ${SYMBOLS[type]} ${db} ≈ ${format(raw)} ; ${transfer} ; écrire ${digit}.`);
    }
  }
  result += carry * 10 ** length;
  return { result: integer(result), estimate: finite(estimate) };
}

function signedAdd(a, b, ctx, details = true) {
  integer(a); integer(b);
  const signA = a < 0 ? -1 : 1;
  const signB = b < 0 ? -1 : 1;
  const absA = Math.abs(a);
  const absB = Math.abs(b);
  let out;
  let sign;
  if (signA === signB) {
    out = digitOperation(absA, absB, 'add', ctx, details);
    sign = signA;
  } else if (absA >= absB) {
    out = digitOperation(absA, absB, 'sub', ctx, details);
    sign = signA;
  } else {
    out = digitOperation(absB, absA, 'sub', ctx, details);
    sign = signB;
  }
  return { result: cleanZero(sign * out.result), estimate: cleanZero(sign * out.estimate) };
}

function signedSubtract(a, b, ctx, details = true) {
  integer(a); integer(b);
  const signA = a < 0 ? -1 : 1;
  const signB = b < 0 ? -1 : 1;
  const absA = Math.abs(a);
  const absB = Math.abs(b);
  let out;
  let sign = signA;
  if (signA !== signB) {
    out = digitOperation(absA, absB, 'add', ctx, details);
  } else {
    out = digitOperation(Math.max(absA, absB), Math.min(absA, absB), 'sub', ctx, details);
    if (absB > absA) sign = -sign;
  }
  return { result: cleanZero(sign * out.result), estimate: cleanZero(sign * out.estimate) };
}

function multiplyByDigit(a, digit, ctx, details = true) {
  integer(a);
  const digits = String(a).split('').reverse().map(Number);
  let carry = 0;
  let result = 0;
  let estimate = 0;
  for (let index = 0; index < digits.length; index++) {
    const raw = ctx.predict('mul', digits[index], digit);
    const incoming = carry;
    const rounded = Math.round(raw + incoming);
    const written = ((rounded % 10) + 10) % 10;
    carry = Math.floor(rounded / 10);
    const place = 10 ** index;
    estimate += raw * place;
    result += written * place;
    if (details) {
      ctx.note(`Position 10^${index} : ${digits[index]} × ${digit} ≈ ${format(raw)} ; retenue entrante ${incoming} ; écrire ${written}, retenir ${carry}.`);
    }
  }
  result += carry * 10 ** digits.length;
  return { result: integer(result), estimate: finite(estimate) };
}

function multiply(a, b, ctx) {
  const digits = String(b).split('').reverse().map(Number);
  let accumulated = null;
  for (let index = 0; index < digits.length; index++) {
    const partial = multiplyByDigit(a, digits[index], ctx);
    const shift = 10 ** index;
    partial.result = integer(partial.result * shift);
    partial.estimate = finite(partial.estimate * shift);
    ctx.note(`Produit partiel par ${digits[index]}, décalé de ${index} position(s) : ≈ ${format(partial.estimate)} ; valeur composée ${partial.result}.`);
    if (accumulated === null) {
      accumulated = partial;
    } else {
      const merged = signedAdd(accumulated.result, partial.result, ctx);
      // Preserve the unrounded residual of each partial, then the learned
      // addition's own error. Incoming carries are absent from these residuals.
      merged.estimate = finite(merged.estimate
        + (accumulated.estimate - accumulated.result)
        + (partial.estimate - partial.result));
      ctx.note(`Addition apprise des produits partiels : ≈ ${format(merged.estimate)} ; valeur composée ${merged.result}.`);
      accumulated = merged;
    }
  }
  return accumulated;
}

function divide(a, b, ctx) {
  integer(a); integer(b);
  const products = new Map();
  const productFor = q => {
    if (!products.has(q)) products.set(q, multiplyByDigit(b, q, ctx, false));
    return products.get(q);
  };
  let remainder = 0;
  const wholeDigits = [];
  const fractionDigits = [];
  ctx.note(`Division posée : dividende ${a}, diviseur ${b} après alignement des décimales.`);

  function step(incomingDigit, place) {
    remainder = integer(remainder * 10 + incomingDigit);
    const before = remainder;
    let q = 0;
    let guess = null;
    if (before <= 9 && b <= 9) {
      guess = ctx.predict('div', before, b);
      q = Math.max(0, Math.min(9, Math.floor(guess)));
    }
    let product = productFor(q);
    // These loops always terminate: q remains an integer between zero and nine.
    while (q > 0 && product.result > before) {
      q--;
      product = productFor(q);
    }
    while (q < 9) {
      const next = productFor(q + 1);
      if (next.result > before) break;
      q++;
      product = next;
    }
    const difference = signedSubtract(before, product.result, ctx, false);
    remainder = integer(Math.max(0, difference.result));
    const suggested = guess === null ? '' : ` ÷ suggère ${format(guess)} ;`;
    const bounded = difference.result < 0 ? ' Reste décodé négatif : ramené à 0 pour poursuivre.' : '';
    ctx.note(`${place} : abaisser ${incomingDigit} → ${before} ;${suggested} écrire ${q}, produit appris ≈ ${format(product.estimate)}, reste appris ≈ ${format(difference.estimate)} (retenu ${remainder}).${bounded}`);
    return q;
  }

  for (const digit of String(a)) wholeDigits.push(step(Number(digit), 'Partie entière'));
  for (let index = 0; index < FRACTION_DIGITS; index++) {
    fractionDigits.push(step(0, `Décimale ${index + 1}`));
  }
  let estimate = Number(`${wholeDigits.join('')}.${fractionDigits.join('')}`);
  if (remainder <= 9 && b <= 9) {
    const tail = ctx.predict('div', remainder, b);
    estimate += tail * 10 ** -FRACTION_DIGITS;
    ctx.note(`Au-delà des six décimales : reste ${remainder} ÷ ${b} ≈ ${format(tail)}, replacé à 10^−${FRACTION_DIGITS}.`);
  }
  estimate = finite(estimate);
  const result = cleanZero(Math.round(estimate * 1e4 + 1e-9) / 1e4);
  ctx.note(`Estimation de division ≈ ${format(estimate)} ; arrondi à quatre décimales : ${format(result)}.`);
  return { estimate, result };
}

export function evaluateExpression(expression, lab, unlockedTypes = ['add', 'sub', 'mul', 'div']) {
  if (typeof expression !== 'string' || expression.length > 64) {
    throw new Error('Saisis une opération entre deux nombres, avec au plus trois chiffres et deux décimales chacun.');
  }
  const match = EXPRESSION.exec(expression);
  if (!match) {
    throw new Error('Saisis deux nombres signés et une opération (+, −, × ou ÷), avec au plus trois chiffres et deux décimales par nombre.');
  }
  const left = operand(match[1]);
  const right = operand(match[3]);
  const type = TYPES[match[2]];
  if (type === 'div' && right.coefficient === 0) {
    throw new Error('La division par zéro est impossible.');
  }
  const ctx = context(lab, unlockedTypes);
  ctx.require(type);
  let out;
  let scale;
  if (type === 'add' || type === 'sub') {
    scale = Math.max(left.scale, right.scale);
    const a = left.sign * left.coefficient * 10 ** (scale - left.scale);
    const b = right.sign * right.coefficient * 10 ** (scale - right.scale);
    ctx.note(`Décimales alignées sur ${scale} position(s) ; retenues et emprunts transmis de droite à gauche.`);
    out = type === 'sub' ? signedSubtract(a, b, ctx) : signedAdd(a, b, ctx);
  } else if (type === 'mul') {
    scale = left.scale + right.scale;
    out = multiply(left.coefficient, right.coefficient, ctx);
    out.result *= left.sign * right.sign;
    out.estimate *= left.sign * right.sign;
    ctx.note(`Replacer la virgule de ${scale} position(s) et appliquer les signes.`);
  } else {
    const alignedScale = Math.max(left.scale, right.scale);
    const a = left.coefficient * 10 ** (alignedScale - left.scale);
    const b = right.coefficient * 10 ** (alignedScale - right.scale);
    out = divide(a, b, ctx);
    out.result *= left.sign * right.sign;
    out.estimate *= left.sign * right.sign;
    scale = 0;
  }
  return {
    expression: `${match[1]} ${SYMBOLS[type]} ${match[3]}`,
    type,
    estimate: finite(out.estimate / 10 ** scale),
    result: finite(out.result / 10 ** scale),
    trace: ctx.trace,
    uses: [...ctx.uses],
  };
}
