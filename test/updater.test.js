// Toetse vir die outomatiese opdaterings (updater.js) met 'n nagemaakte electron-updater
const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { setupUpdates } = require('../updater');

function fakeUpdater() {
  const u = new EventEmitter();
  u.checks = 0;
  u.installed = null;
  u.checkForUpdates = () => { u.checks++; return Promise.resolve(); };
  u.quitAndInstall = (silent, runAfter) => { u.installed = { silent, runAfter }; };
  return u;
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('nuwe weergawe ná oopmaak en nie besig nie: installeer stil en maak weer oop', async () => {
  const u = fakeUpdater();
  const states = [];
  let saved = false;
  const h = setupUpdates({ updater: u, isBusy: async () => false, onState: (s) => states.push(s.state), beforeInstall: () => { saved = true; }, log: { error() {} } });
  assert.equal(u.checks, 1, 'soek dadelik');
  u.emit('update-available', { version: '9.9.9' });
  u.emit('download-progress', { percent: 150 });
  u.emit('update-downloaded', { version: '9.9.9' });
  await tick(1700);
  h.stop();
  assert.deepEqual(states, ['downloading', 'downloading', 'installing']);
  assert.ok(saved, 'build-data word eers gestoor');
  assert.deepEqual(u.installed, { silent: true, runAfter: true });
});

test('in champ select of \'n game: installeer nie, wys "ready" met Restart now', async () => {
  const u = fakeUpdater();
  const states = [];
  const h = setupUpdates({ updater: u, isBusy: async () => true, onState: (s) => states.push(s), beforeInstall() {}, log: { error() {} } });
  u.emit('update-downloaded', { version: '9.9.9' });
  await tick(50);
  assert.deepEqual(states.at(-1), { state: 'ready', version: '9.9.9', busy: true });
  assert.equal(u.installed, null);
  assert.equal(h.install(), true, 'Restart now werk wel');
  await tick(1700);
  h.stop();
  assert.ok(u.installed);
});

test('\'n fout tydens soek wys \'n foutstaat, maar nie as daar al \'n weergawe gereed is nie', async () => {
  const u = fakeUpdater();
  const states = [];
  const h = setupUpdates({ updater: u, isBusy: async () => true, onState: (s) => states.push(s.state), beforeInstall() {}, log: { error() {} } });
  u.emit('error', new Error('offline'));
  assert.equal(states.at(-1), 'error');
  u.emit('update-downloaded', { version: '9.9.9' });
  await tick(50);
  u.emit('error', new Error('again'));
  assert.equal(states.at(-1), 'ready');
  h.stop();
});
