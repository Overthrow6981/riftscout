// Sekuriteit: die Riot-sleutel versleuteld gestoor (en 'n ou gewone-teks-sleutel oorgeskuif), nooit in die log of
// antwoorde nie; Content-Security-Policy; versoeke van ander werwe (ook GET) geweier.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMock, call } = require('./helpers');

// Nagemaakte sleutels in Riot se vorm (nie regte sleutels nie)
const OLD_KEY = 'RGAPI-00000000-aaaa-bbbb-cccc-111111111111';
const NEW_KEY = 'RGAPI-00000000-dddd-eeee-ffff-222222222222';
// Nagemaakte "Windows-versleuteling" (in die app doen Electron safeStorage / DPAPI dit)
const fakeSecrets = (on = true) => ({
  available: () => on,
  encrypt: (t) => 'enc:' + Buffer.from(String(t).split('').reverse().join('')).toString('base64'),
  decrypt: (b) => { if (!String(b).startsWith('enc:')) throw new Error('bad'); return Buffer.from(String(b).slice(4), 'base64').toString().split('').reverse().join(''); },
});

let mock;
let port;
let dataDir;
before(async () => {
  mock = await startMock();
  const base = `http://127.0.0.1:${mock.port}`;
  process.env.LCU_LOCKFILE = path.join(os.tmpdir(), 'no-such-lockfile');
  process.env.DDRAGON_BASE = `${base}/dd`;
  process.env.REMOTE_BUILDS_URL = `${base}/builds.json`;
  process.env.RIOT_HOST_TEMPLATE = `${base}/riot/{route}`;
  process.env.LIVE_CLIENT_URL = 'https://127.0.0.1:1/liveclientdata/allgamedata';
  process.env.CRAWL_PACE_MS = '100000000';
  delete process.env.RIOT_API_KEY;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-sec-'));
  // 'n Ouer weergawe het die sleutel as gewone teks gestoor
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ apiKey: OLD_KEY, prefs: { collectBuilds: false } }));
  // 'n Ou log-reël (van 'n ouer weergawe) met 'n sleutel daarin
  fs.writeFileSync(path.join(dataDir, 'riftscout.log'), `2026-11-20T10:00:00.000Z Old line with ${OLD_KEY}\n`);
  port = await require('../server').startServer({ port: 0, dataDir, secrets: fakeSecrets() });
});
after(() => { mock.server.close(); setTimeout(() => process.exit(0), 50); });

const cfgText = () => fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');

test('Riot-sleutel: ou gewone-teks-sleutel word met die begin versleutel; nuwe sleutel ook', async () => {
  let st = (await call(port, 'GET', '/api/status')).json;
  assert.equal(st.hasKey, true);
  assert.equal(st.keyStorage, 'encrypted');
  assert.ok(!cfgText().includes(OLD_KEY), 'die sleutel staan nie meer as gewone teks in config.json nie');
  assert.ok(JSON.parse(cfgText()).apiKeyEnc);
  assert.equal(JSON.parse(cfgText()).prefs.collectBuilds, false, 'ander instellings bly');

  const r = await call(port, 'POST', '/api/settings', { body: { apiKey: NEW_KEY } });
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(NEW_KEY), 'die antwoord bevat nie die sleutel nie');
  assert.ok(!cfgText().includes(NEW_KEY));
  st = (await call(port, 'GET', '/api/status')).json;
  assert.equal(st.keyStorage, 'encrypted');
  assert.ok(!JSON.stringify(st).includes('RGAPI'));

  const rm = await call(port, 'POST', '/api/settings', { body: { apiKey: '' } });
  assert.equal(rm.json.hasKey, false);
  const cfg = JSON.parse(cfgText());
  assert.ok(!('apiKey' in cfg) && !('apiKeyEnc' in cfg), 'verwyder is heeltemal weg');
});

test('sleutels kom nie in die aktiwiteit-lys of riftscout.log nie', async () => {
  const { logEvent, redact } = require('../server')._test;
  logEvent(`Something failed with ${NEW_KEY} in it`);
  const act = (await call(port, 'GET', '/api/activity')).json.events.map((e) => e.msg).join('\n');
  assert.ok(!act.includes(NEW_KEY));
  assert.match(act, /RGAPI-\*\*\*/);
  assert.ok(!fs.readFileSync(path.join(dataDir, 'riftscout.log'), 'utf8').includes(NEW_KEY));
  assert.equal(redact(`a ${OLD_KEY} b`), 'a RGAPI-*** b');
  assert.ok(!act.includes(OLD_KEY), 'ook ou log-reëls word gefilter');
  assert.match(act, /Old line with RGAPI-\*\*\*/);
});

test('Content-Security-Policy en ander kopstukke op die blad', async () => {
  const r = await call(port, 'GET', '/');
  assert.equal(r.status, 200);
  const csp = await new Promise((resolve) => {
    require('http').get({ host: '127.0.0.1', port, path: '/', headers: { Host: `127.0.0.1:${port}` } }, (res) => { res.resume(); resolve(res.headers); });
  });
  assert.match(csp['content-security-policy'], /script-src 'self'/);
  assert.match(csp['content-security-policy'], /object-src 'none'/);
  assert.match(csp['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(csp['x-frame-options'], 'DENY');
  assert.equal(csp['referrer-policy'], 'no-referrer');
});

test('versoeke van ander werwe (ook GET, ook \'n ander plaaslike poort) word geweier; eie blad en Electron nie', async () => {
  assert.equal((await call(port, 'GET', '/api/status', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await call(port, 'GET', '/api/status', { headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403);
  assert.equal((await call(port, 'GET', '/api/status', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal((await call(port, 'GET', '/', { headers: { 'Sec-Fetch-Site': 'none' } })).status, 200);
  assert.equal((await call(port, 'GET', '/api/status')).status, 200, 'sonder die kopstuk (ou blaaier, toetse)');
});

test('sonder Windows-versleuteling: gewone teks (soos voorheen), en die app sê so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-sec2-'));
  const p2 = await require('../server').startServer({ port: 0, dataDir: dir, secrets: fakeSecrets(false) });
  await call(p2, 'POST', '/api/settings', { body: { apiKey: NEW_KEY } });
  const st = (await call(p2, 'GET', '/api/status')).json;
  assert.equal(st.keyStorage, 'plain');
  // 'n Versleutelde sleutel wat nie meer gelees kan word nie (ander Windows-rekening): duidelike boodskap, geen sleutel
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-sec3-'));
  fs.writeFileSync(path.join(dir3, 'config.json'), JSON.stringify({ apiKeyEnc: 'garbage' }));
  const p3 = await require('../server').startServer({ port: 0, dataDir: dir3, secrets: fakeSecrets() });
  const st3 = (await call(p3, 'GET', '/api/status')).json;
  assert.equal(st3.hasKey, false);
  assert.match(st3.keyError, /could not be read/);
});
