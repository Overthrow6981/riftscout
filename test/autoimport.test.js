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
  assert.deepEqual(set.associatedChampions, [1], 'die regte champion');
  assert.equal(set.championKey, 'Annie');
  assert.ok(set.blocks.some((b) => b.items.some((it) => it.id === '3089')), 'Annie se eie kern-item (uit die data)');
  // Ekstra build-keuses (as daar is) het nie priority nie, en is vir dieselfde champion
  for (const n of fs.readdirSync(shopDir).filter((x) => /^!!!riftscout-[12]\.json$/.test(x))) {
    const extra = JSON.parse(fs.readFileSync(path.join(shopDir, n), 'utf8'));
    assert.equal(extra.priority, false);
    assert.deepEqual(extra.associatedChampions, [1]);
  }
  assert.ok(set.blocks.length >= 2);
  assert.ok(!fs.existsSync(path.join(shopDir, '!!!blitz-0.json')), 'Blitz se oorblyfsel is uit die winkel');
  const backups = (await call(port, 'GET', '/api/backups')).json;
  assert.equal(backups.blitz.length, 1, 'maar in RiftScout se rugsteun');
  assert.equal(backups.blitz[0].title, 'Blitz: Crit Miss Fortune');
  assert.ok(await until(() => fake.st.selection && fake.st.pages.some((p) => p.current && p.name === 'RiftScout Annie'), 5000), 'runes en spells');
  assert.ok(await until(() => !fake.st.sets.itemSets.some((s) => s.title.startsWith('RiftScout')), 5000), 'ou RiftScout-sets uit die rekening');
  assert.deepEqual(fake.st.sets.itemSets.map((s) => s.title), ['My own Annie set'], 'die speler se eie set bly');
  const act = (await call(port, 'GET', '/api/activity')).json.events.map((e) => e.msg).join('\n');
  assert.match(act, /Auto-import for Annie Mid.*items ok \(shop file, moved 1 Blitz set to RiftScout's backup\)/);
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

test('ARAM: runes (uit Summoner\'s Rift-data, en die log sê so), geen item set nie', async () => {
  fake.st.flow = { map: { id: 12 }, gameData: { queue: { id: 450, gameMode: 'ARAM' } } };
  fake.st.session = champSelect(1, '');
  fake.st.phase = 'ChampSelect';
  assert.ok(await until(async () => (await call(port, 'GET', '/api/activity')).json.events.some((e) => /Auto-import for Annie: .*ARAM – runes are from Summoner's Rift/.test(e.msg)), 12000), 'ARAM in die log');
  const st = (await call(port, 'GET', '/api/lcu/state')).json;
  assert.equal(st.champSelect.aram, true);
  assert.equal(st.champSelect.mapId, 12);
  assert.ok(!fs.existsSync(shopFile()), 'geen winkel-set in ARAM nie');
  fake.st.phase = 'Lobby';
  fake.st.session = null;
  fake.st.flow = null;
  await new Promise((r) => setTimeout(r, 2500));
});

test('rune page-rugsteun: vervang as al die bladsye vol is, en sit dit terug via die app', async () => {
  const perks = [8010, 9111, 9104, 8299, 8444, 8242, 5005, 5008, 5001];
  fake.st.pages = [1, 2, 3].map((id) => ({ id, name: `Mine ${id}`, current: id === 2, isDeletable: true, isEditable: true, primaryStyleId: 8000, subStyleId: 8400, selectedPerkIds: perks }));
  const pref = await call(port, 'POST', '/api/prefs', { body: { replacePages: true } });
  assert.equal(pref.status, 200, pref.text);
  const imp = await call(port, 'POST', '/api/lcu/import', { body: { championId: 1, role: 'MIDDLE', what: ['runes'] } });
  assert.equal(imp.status, 200, imp.text);
  assert.equal(imp.json.results.runes.replaced, 'Mine 2');
  assert.ok(!fake.st.pages.some((p) => p.name === 'Mine 2'));
  const b = (await call(port, 'GET', '/api/backups')).json;
  const e = b.runes.find((x) => x.name === 'Mine 2');
  assert.ok(e, 'in die rugsteun-lys');
  assert.equal(e.keystone, 8010);
  let act = (await call(port, 'GET', '/api/activity')).json.events.map((x) => x.msg).join('\n');
  assert.match(act, /replaced your page "Mine 2" because all pages were full – a backup is in Settings/);
  // Terugsit: al drie bladsye is vol (2 van jou + RiftScout s'n), dus maak RiftScout se eie bladsy plek
  const r = await call(port, 'POST', '/api/runes/restore', { body: { id: e.id } });
  assert.equal(r.json.ok, true, r.text);
  assert.equal(r.json.freed, 'RiftScout Annie');
  const back = fake.st.pages.find((p) => p.name === 'Mine 2');
  assert.deepEqual(back.selectedPerkIds, perks);
  act = (await call(port, 'GET', '/api/activity')).json.events.map((x) => x.msg).join('\n');
  assert.match(act, /Restored your rune page "Mine 2" from RiftScout's backup/);
  assert.ok((await call(port, 'GET', '/api/backups')).json.runes.find((x) => x.id === e.id).restoredAt > 0);
  assert.equal((await call(port, 'POST', '/api/runes/restore', { body: { id: 'nope' } })).status, 404);

  // Gelyktydig: terwyl 'n terugsit op League wag, vervang 'n invoer 'n ander bladsy -> albei rugsteune bly
  fake.st.pages = [1, 2, 3].map((id) => ({ id, name: `Page ${id}`, current: id === 3, isDeletable: true, isEditable: true, primaryStyleId: 8000, subStyleId: 8400, selectedPerkIds: perks }));
  fake.st.delay['POST /lol-perks/v1/pages'] = 1500;
  const slow = call(port, 'POST', '/api/runes/restore', { body: { id: e.id } });
  await new Promise((r) => setTimeout(r, 300));
  const imp2 = await call(port, 'POST', '/api/lcu/import', { body: { championId: 1, role: 'MIDDLE', what: ['runes'] } });
  assert.equal(imp2.json.results.runes.replaced, 'Page 3');
  await slow;
  const names = (await call(port, 'GET', '/api/backups')).json.runes.map((x) => x.name);
  assert.ok(names.includes('Page 3'), `die nuwe rugsteun bly ná die terugsit (${names.join(', ')})`);
  assert.ok(names.includes('Mine 2'));
  await call(port, 'POST', '/api/prefs', { body: { replacePages: false } });
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
