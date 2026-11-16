import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadModule } from './load-module.mjs';
const { parseNumberInput } = await loadModule('src/ui/number-input.ts');
const { COMPACT_WIDTH, NARROW_WIDTH } = await loadModule('src/ui/layout.ts');

test('U04: native numeric inputs distinguish missing values from zero and preserve signed decimals', () => {
  assert.equal(parseNumberInput(''), undefined);
  assert.equal(parseNumberInput('0'), 0);
  assert.equal(parseNumberInput('-1.25'), -1.25);
  assert.equal(parseNumberInput('2e3'), 2000);
  assert(Number.isNaN(parseNumberInput('invalid')));
});

test('U09: authored media queries and runtime responsive thresholds agree at their boundaries', () => {
  const css = readFileSync(new URL('../src/ui/trading.css', import.meta.url), 'utf8');
  const widths = [...css.matchAll(/@media \(max-width: (\d+)px\)/g)].map(match => Number(match[1]) + 1);
  assert.deepEqual(widths, [COMPACT_WIDTH, NARROW_WIDTH]);
});

const { accountDockHeight } = await loadModule('src/ui/layout.ts');
test('U10 narrow account docks retain a table viewport within host bounds', () => {
  assert.equal(accountDockHeight(240, 390, 600), 320);
  assert.equal(accountDockHeight(240, 600, 600), 240);
  assert.equal(accountDockHeight(440, 390, 600), 440);
  assert.equal(accountDockHeight(240, 390, 260), 260);
});
test('U09: the compact focus trap skips controls disabled through a fieldset and hidden or inert subtrees', async () => {
  const { isTabCandidate, trapTab } = await loadModule('src/ui/trap-tab.ts');
  // Browser semantics: `:disabled` matches controls inside a disabled fieldset; `[disabled]` does not.
  const element = ({ own = false, fieldset = false, hidden = false, inert = false } = {}) => {
    const value = {
      focused: 0,
      matches: selector => selector === ':disabled' ? own || fieldset : selector === '[disabled]' ? own : false,
      closest: selector => (selector.includes('[hidden]') && hidden) || (selector.includes('[inert]') && inert) ? {} : null,
      focus: () => { value.focused++; root.ownerDocument.activeElement = value; },
    };
    return value;
  };
  const close = element(), busy = element({ fieldset: true }), submit = element({ fieldset: true }), hidden = element({ hidden: true }), inert = element({ inert: true });
  assert.equal(isTabCandidate(close), true);
  assert.equal(isTabCandidate(busy), false);
  assert.equal(isTabCandidate(hidden), false);
  assert.equal(isTabCandidate(inert), false);
  const root = { ownerDocument: { activeElement: close }, querySelectorAll: () => [close, busy, submit, hidden, inert], contains: () => true };
  let prevented = 0;
  trapTab({ key: 'Tab', shiftKey: false, preventDefault: () => prevented++ }, root);
  assert.equal(prevented, 1, 'Tab from the only enabled control wraps instead of escaping to a disabled one');
  assert.equal(close.focused, 1);
});
