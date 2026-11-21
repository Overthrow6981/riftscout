// Die hele pad teen 'n nagemaakte League-kliënt: champ select -> runes, spells en die item set in die winkel
// (Config\Global\Recommended, bo Blitz se oorblyfsel), ná die game weer uit; en wedstrydgeskiedenis.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMock, call, until } = require('./helpers');
const { startFakeLcu, champSelect, ME } = require('./fakelcu');

let mock;
let fake;
let port;
let shopDir;
const shopFile = () => path.join(shopDir, '!!!riftscout-0.json');
before(async () => {
  mock = await startMock();
  fake = await startFakeLcu({ games: 25, badGames: new Set([1, 3]) });
  const base = `http://127.0.0.1:${mock.port}`;
  process.env.LCU_LOCKFILE = fake.lockfile;
  process.env.DDRAGON_BASE = `${base}/dd`;
  process.env.REMOTE_BUILDS_URL = `${base}/builds.json`;
  process.env.RIOT_HOST_TEMPLATE = `${base}/riot/{route}`;
  process.env.LIVE_CLIENT_URL = 'https://127.0.0.1:1/liveclientdata/allgamedata';
  process.env.CRAWL_PACE_MS = '100000000';
  delete process.env.RIOT_API_KEY;
  shopDir = path.join(fake.install, 'Config', 'Global', 'Recommended');
  fs.mkdirSync(shopDir, { recursive: true });
  // Blitz is toe, maar sy laaste set (vir 'n ander champion) staan nog in League se winkel-gids
  fs.writeFileSync(path.join(shopDir, '!!!blitz-0.json'), JSON.stringify({ title: 'Blitz: Crit Miss Fortune', championKey: 'MissFortune', priority: true, sortrank: 1000000000, type: 'custom', map: 'any', mode: 'any', blocks: [] }));
  fake.st.sets.itemSets = [
    { uid: 'u', title: 'My own Annie set', associatedChampions: [1], blocks: [] },
    { uid: 'o', title: 'RiftScout Lux Support', associatedChampions: [99], blocks: [] },
  ];
  const server = require('../server');
  port = await server.startServer({ port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rs-auto-')) });
  assert.ok(await until(async () => (await call(port, 'GET', '/api/builds/status')).json.sharedMatches > 0, 10000), 'gedeelde data gelaai');
  assert.ok(await until(async () => (await call(port, 'GET', '/api/ddragon')).status === 200, 10000));
});
after(() => { mock.server.close(); fake.server.close(); setTimeout(() => process.exit(0), 50); });

test('champ select: runes, spells en die item set in die winkel; Blitz se oorblyfsel uit', async () => {
  fake.st.session = champSelect(1, 'middle', { enemies: [238] });
  fake.st.phase = 'ChampSelect';
  assert.ok(await until(() => fs.existsSync(shopFile()), 12000), 'winkel-lêer geskryf');
  const set = JSON.parse(fs.readFileSync(shopFile(), 'utf8'));
  assert.match(set.title, /^RiftScout Annie Mid/);
  assert.equal(set.priority, true);
  assert.ok(set.blocks.length >= 2);
  assert.ok(!fs.existsSync(path.join(shopDir, '!!!blitz-0.json')), 'Blitz se oorblyfsel is weg');
  assert.ok(await until(() => fake.st.selection && fake.st.pages.some((p) => p.current && p.name === 'RiftScout Annie'), 5000), 'runes en spells');
  assert.ok(await until(() => !fake.st.sets.itemSets.some((s) => s.title.startsWith('RiftScout')), 5000), 'ou RiftScout-sets uit die rekening');
  assert.deepEqual(fake.st.sets.itemSets.map((s) => s.title), ['My own Annie set'], 'die speler se eie set bly');
  const act = (await call(port, 'GET', '/api/activity')).json.events.map((e) => e.msg).join('\n');
  assert.match(act, /Auto-import for Annie Mid.*items ok \(shop file, removed 1 Blitz set\)/);
});

test('in die game bly die set; ná die game gaan dit uit die winkel', async () => {
  fake.st.phase = 'GameStart';
  await new Promise((r) => setTimeout(r, 2500));
  fake.st.phase = 'InProgress';
  await new Promise((r) => setTimeout(r, 4500));
  assert.ok(fs.existsSync(shopFile()), 'bly terwyl die game loop');
  fake.st.phase = 'EndOfGame';
  fake.st.session = null;
  assert.ok(await until(() => !fs.existsSync(shopFile()), 9000), 'weg ná die game');
  const act = (await call(port, 'GET', '/api/activity')).json.events.map((e) => e.msg).join('\n');
  assert.match(act, /Took RiftScout's item set out of the shop \(the game ended\)/);
});

test('champ select sonder game (dodge): die set gaan ook uit', async () => {
  fake.st.session = champSelect(1, 'middle');
  fake.st.phase = 'ChampSelect';
  assert.ok(await until(() => fs.existsSync(shopFile()), 12000));
  fake.st.phase = 'Lobby';
  fake.st.session = null;
  assert.ok(await until(() => !fs.existsSync(shopFile()), 9000));
});

test('wedstrydgeskiedenis van jou profiel: wys games ook as die kliënt sommige nie volledig gee nie', async () => {
  const r1 = await call(port, 'GET', `/api/matches?region=na1&puuid=${ME}&start=0&count=10`);
  assert.equal(r1.status, 200, r1.text);
  assert.equal(r1.json.matches.length, 10);
  assert.equal(r1.json.matches.filter((m) => m.partial).length, 2, 'twee games net uit die lys');
  assert.ok(r1.json.matches.every((m) => m.me && m.me.championId === 1));
  assert.equal(r1.json.hasMore, true);
  const r2 = await call(port, 'GET', `/api/matches?region=na1&puuid=${ME}&start=10&count=10`);
  const ids1 = new Set(r1.json.matches.map((m) => m.id));
  assert.ok(r2.json.matches.length === 10 && r2.json.matches.every((m) => !ids1.has(m.id)), 'bladsy 2 is nuwe games');
  const r3 = await call(port, 'GET', `/api/matches?region=na1&puuid=${ME}&start=20&count=10`);
  assert.equal(r3.json.matches.length, 5);
  assert.equal(r3.json.hasMore, false);
});
