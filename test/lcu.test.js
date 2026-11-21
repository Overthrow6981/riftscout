const test = require('node:test');
const assert = require('node:assert');
const lcu = require('../lcu');

test('Blitz-app se item sets word herken (en net vir jou champion)', () => {
  const s = (title, champs) => ({ title, associatedChampions: champs });
  assert.ok(lcu.isBlitzSet(s('Blitz: Crit Miss Fortune', [21]), 21, 'Miss Fortune'));
  assert.ok(lcu.isBlitzSet(s('blitz - Miss Fortune ADC', [21]), 21, 'Miss Fortune'));
  assert.ok(lcu.isBlitzSet(s('Blitz: Crit Miss Fortune', []), 21, 'Miss Fortune'), 'sonder champion-koppeling, met die naam');
  assert.ok(!lcu.isBlitzSet(s('Blitz: Lux Support', [99]), 21, 'Miss Fortune'), 'ander champion bly');
  assert.ok(!lcu.isBlitzSet(s('Blitz: Lux Support', []), 21, 'Miss Fortune'), 'ander champion sonder koppeling bly');
  assert.ok(!lcu.isBlitzSet(s('Blitzcrank hooks', [21]), 21, 'Miss Fortune'), 'Blitzcrank is nie die Blitz-app nie');
  assert.ok(!lcu.isBlitzSet(s('My MF build', [21]), 21, 'Miss Fortune'), 'jou eie sets bly');
  assert.ok(!lcu.isBlitzSet(s('', [21]), 21, 'Miss Fortune'));
});

test('Blitz se rune page word herken, jou eie en RiftScout s\'n nie', () => {
  assert.ok(lcu.isBlitzPage({ id: 1, name: 'Blitz: Miss Fortune ADC' }));
  assert.ok(lcu.isBlitzPage({ id: 1, name: 'Miss Fortune (Blitz)' }));
  assert.ok(!lcu.isBlitzPage({ id: 1, name: 'RiftScout Miss Fortune' }));
  assert.ok(!lcu.isBlitzPage({ id: 1, name: 'My MF page' }));
  assert.ok(!lcu.isBlitzPage(null));
  // Die speler se eie bladsy vir Blitzcrank is nie Blitz-app s'n nie
  assert.ok(!lcu.isBlitzPage({ id: 1, name: 'Blitzcrank AP' }));
  assert.ok(lcu.isBlitzPage({ id: 1, name: 'Blitz.gg Senna' }));
});
