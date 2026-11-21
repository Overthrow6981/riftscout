// Bediener-toetse sonder Riot-sleutel en met League toe. Loop met: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMock, call, until } = require('./helpers');

let mock;
let port;
before(async () => {
  mock = await startMock();
  const base = `http://127.0.0.1:${mock.port}`;
  process.env.LCU_LOCKFILE = path.join(os.tmpdir(), 'no-such-lockfile');
  process.env.DDRAGON_BASE = `${base}/dd`;
  process.env.REMOTE_BUILDS_URL = `${base}/builds.json`;
  process.env.RIOT_HOST_TEMPLATE = `${base}/riot/{route}`;
  process.env.LIVE_CLIENT_URL = 'https://127.0.0.1:1/liveclientdata/allgamedata';
  delete process.env.RIOT_API_KEY;
  const server = require('../server');
  port = await server.startServer({ port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rs-srv-')) });
});
after(() => { mock.server.close(); setTimeout(() => process.exit(0), 50); });

test('ander webwerwe en DNS-rebinding word geblokkeer', async () => {
  assert.equal((await call(port, 'GET', '/api/status', { headers: { Host: 'evil.example:80' } })).status, 403);
  const r = await call(port, 'POST', '/api/prefs', { body: { autoImport: false }, headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('POST moet JSON wees; stukkende JSON gee 400 sonder stack trace', async () => {
  assert.equal((await call(port, 'POST', '/api/prefs', { body: 'autoImport=false', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  const bad = await call(port, 'POST', '/api/lcu/import', { body: 'not json' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json, { error: 'Invalid JSON.' });
  assert.ok(!/node_modules|at JSON\.parse/.test(bad.text), 'geen stack trace na buite');
});

test('onbekende API-roete gee JSON 404', async () => {
  const r = await call(port, 'GET', '/api/does-not-exist');
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { error: 'Not found.' });
});

test('invoer word nagegaan: import, profiel en bediener', async () => {
  const imp = await call(port, 'POST', '/api/lcu/import', { body: { championId: 103, what: 'runes' } });
  assert.equal(imp.status, 400, '"what" moet \'n lys wees');
  assert.equal((await call(port, 'GET', '/api/profile?region=xx&riotId=A%23B')).status, 400);
  assert.equal((await call(port, 'GET', '/api/profile?region=na1&riotId=NoTag')).status, 400);
  assert.equal((await call(port, 'GET', '/api/matches?region=na1&puuid=..%2F..%2Fetc')).status, 400);
  const closed = await call(port, 'GET', '/api/profile?region=na1&riotId=Someone%23NA1');
  assert.equal(closed.status, 409, 'sonder sleutel en met League toe: vra om League oop te maak');
  assert.match(closed.json.error, /League client/);
});

test('instellings: verkeerde sleutel word geweier, voorkeure word gestoor', async () => {
  const k = await call(port, 'POST', '/api/settings', { body: { apiKey: 'nope' } });
  assert.equal(k.status, 400);
  const p = await call(port, 'POST', '/api/prefs', { body: { autoSpells: false, overlay: true, crawlRegion: 'zz' } });
  assert.equal(p.json.autoSpells, false);
  assert.equal(p.json.overlay, undefined, 'die in-game oorleg bestaan nie meer nie');
  assert.equal(p.json.crawlRegion, '', 'onbekende streek word geïgnoreer');
  const st = await call(port, 'GET', '/api/status');
  assert.equal(st.json.hasKey, false);
  assert.ok(!('apiKey' in st.json), 'die sleutel self word nooit teruggestuur nie');
});

test('gedeelde build-data (saamgepak) laai, en counters wys game- en lane-%', async () => {
  assert.ok(await until(async () => (await call(port, 'GET', '/api/builds/status')).json.sharedMatches > 0), 'gedeelde data gelaai');
  const st = (await call(port, 'GET', '/api/builds/status')).json;
  assert.deepEqual(st.sharedRegions, ['EUW', 'KR']);
  const c = (await call(port, 'GET', '/api/builds/counters/238?role=MIDDLE')).json;
  const annie = c.counters.find((x) => x.championId === 1);
  assert.equal(annie.games, 8);
  assert.equal(annie.wr, 0.75);
  assert.equal(annie.laneWr, 5 / 8);
  const best = (await call(port, 'GET', '/api/builds/best?role=MIDDLE')).json.best;
  assert.ok(best.some((x) => x.championId === 1));
  // Ná lock-in: hoe vaar jou eie champion (Annie) teen die vyand (Zed)
  const mine = (await call(port, 'GET', '/api/builds/counters/238?role=MIDDLE&me=1')).json.mine;
  assert.deepEqual([mine.games, mine.wr, mine.laneWr], [8, 0.75, 5 / 8]);
  const none = (await call(port, 'GET', '/api/builds/counters/238?role=MIDDLE&me=99999')).json.mine;
  assert.equal(none.games, 0, 'geen games = 0, nie \'n fout nie');
  const build = (await call(port, 'GET', '/api/builds/champion/1?role=MIDDLE&vs=238')).json;
  assert.equal(build.rec.vs.games, 8);
  assert.deepEqual(build.rec.vs.lane, [8, 5]);
});

test('Data Dragon gee volle rune-bome vir die rune-bladsy', async () => {
  const d = (await call(port, 'GET', '/api/ddragon')).json;
  assert.deepEqual(d.trees, [{ id: 8100, name: 'Domination', icon: 'd.png', slots: [[8112]] }]);
});

test('items vir champions met te min eie games in die rol', async () => {
  assert.ok(await until(async () => (await call(port, 'GET', '/api/builds/status')).json.sharedMatches > 0));
  // Darius het 0 games in Mid maar 12 in Top: sy eie items (items verskil skaars tussen rolle), begin-items van Mid
  const dar = (await call(port, 'GET', '/api/builds/champion/122?role=MIDDLE&strict=1')).json;
  assert.equal(dar.items.kind, 'own');
  assert.equal(dar.items.games, 12);
  assert.deepEqual(dar.items.core[0].ids, [3071, 3053, 6333]);
  assert.equal(dar.items.boots[0].id, 3047);
  assert.deepEqual(dar.items.start[0].ids, [1056, 2003], 'begin-items uit die rol self');
  assert.deepEqual(dar.items.similar, []);
  // Zed het net 8 games: sy eie games plus die champions wat die naaste aan hom items koop
  const zed = (await call(port, 'GET', '/api/builds/champion/238?role=MIDDLE')).json;
  assert.equal(zed.items.kind, 'mixed');
  assert.equal(zed.items.games, 8);
  assert.deepEqual(zed.items.similar.map((c) => c.name).sort(), ['Annie', 'Lux']);
  // Syndra het geen games nie: champions wat volgens Riot se data die naaste aan haar is (die mages)
  const syn = (await call(port, 'GET', '/api/builds/champion/134?role=MIDDLE')).json;
  assert.equal(syn.items.kind, 'similar');
  assert.deepEqual(syn.items.similar.slice(0, 2).map((c) => c.name).sort(), ['Annie', 'Lux'], 'die mages eerste');
  assert.deepEqual(syn.items.core[0].ids, [3089, 3157, 3135]);
  // Cassiopeia kan nie boots koop nie
  const cass = (await call(port, 'GET', '/api/builds/champion/69?role=MIDDLE')).json;
  assert.deepEqual(cass.items.boots, []);
  // Sonder rol en sonder Riot se posisies is daar niks om op te bou nie: geen items, geen fout
  const none = await call(port, 'GET', '/api/builds/champion/134');
  assert.equal(none.status, 200);
  assert.equal(none.json.items, undefined);
});
