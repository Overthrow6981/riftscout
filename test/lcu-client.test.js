// lcu.js teen 'n nagemaakte League-kliënt: rune page, winkel-lêer via die kliënt se install-gids,
// wedstrydgeskiedenis en 'n stadige kliënt
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startFakeLcu, ME } = require('./fakelcu');

let fake;
let lcu;
before(async () => {
  fake = await startFakeLcu({ games: 25 });
  process.env.LCU_LOCKFILE = fake.lockfile;
  process.env.LCU_TIMEOUT_MS = '600';
  lcu = require('../lcu');
});
after(() => { fake.server.close(); setTimeout(() => process.exit(0), 50); });

const rune = { primaryStyleId: 8100, subStyleId: 8200, primary: [8112, 8139, 8138, 8135], secondary: [8226, 8210], shards: [5008, 5008, 5001] };

test('rune page: een eie bladsy, oorgeskryf (nie uitgevee nie) en gekies in League', async () => {
  let r = await lcu.importRunes(rune, 'RiftScout Annie', true);
  assert.equal(r.ok, true);
  const ours = fake.st.pages.filter((p) => p.name.startsWith('RiftScout'));
  assert.equal(ours.length, 1);
  assert.equal(fake.st.pages.find((p) => p.current).name, 'RiftScout Annie');
  const id = ours[0].id;
  // Die speler kies sy eie bladsy; die volgende invoer skryf dieselfde bladsy oor en kies dit weer
  fake.st.pages.forEach((p) => (p.current = p.id === 50));
  r = await lcu.importRunes({ ...rune, primary: [8128, 8126, 8138, 8135] }, 'RiftScout Zed', true);
  assert.equal(r.ok, true);
  const now = fake.st.pages.filter((p) => p.name.startsWith('RiftScout'));
  assert.equal(now.length, 1, 'steeds een RiftScout-bladsy');
  assert.equal(now[0].id, id, 'dieselfde bladsy, in plek oorgeskryf');
  assert.equal(now[0].selectedPerkIds[0], 8128);
  assert.equal(fake.st.pages.find((p) => p.current).id, id, 'en dit is die gekose bladsy');
  assert.ok(!('uiPerks' in now[0]));
});

test('rune page: alle bladsye vol -> vervang die huidige een (as dit mag)', async () => {
  fake.st.pages = [
    { id: 1, name: 'A', current: false, isDeletable: true, isEditable: true },
    { id: 2, name: 'B', current: true, isDeletable: true, isEditable: true },
    { id: 3, name: 'Swiftplay', current: false, isDeletable: false, isEditable: true },
  ];
  const no = await lcu.importRunes(rune, 'RiftScout Annie', false);
  assert.equal(no.ok, false);
  assert.match(no.error, /No free rune page/);
  const yes = await lcu.importRunes(rune, 'RiftScout Annie', true);
  assert.equal(yes.ok, true);
  assert.equal(yes.replaced, 'B');
  assert.equal(fake.st.pages.find((p) => p.current).name, 'RiftScout Annie');
});

test('winkel-lêer gaan na die gids wat die kliënt gee (/data-store/v1/install-dir), nie C:\\ nie', async () => {
  const r = await lcu.writeShopItemSet({ championKey: 'Annie', title: 'RiftScout Annie Mid', blocks: [{ type: 'Core', items: [{ id: '3089', count: 1 }] }] });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'shop');
  const file = path.join(fake.install, 'Config', 'Global', 'Recommended', '!!!riftscout-0.json');
  assert.ok(fs.existsSync(file));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).title, 'RiftScout Annie Mid');
  assert.deepEqual(await lcu.shopItemSetStatus(), { ours: true, first: true, blitz: 0 });
  assert.equal(await lcu.clearShopItemSets(), 1);
  assert.ok(!fs.existsSync(file));
});

test('rekening se item set: "priority" word deur die kliënt weggegooi, dus nie gestuur nie; ou sets weg', async () => {
  fake.st.sets.itemSets = [{ uid: 'u', title: 'My set', associatedChampions: [1], blocks: [] }, { uid: 'o', title: 'RiftScout Old', associatedChampions: [9], blocks: [] }];
  const r = await lcu.importItemSet(1, 'RiftScout Annie Mid', [{ type: 'Core', items: [{ id: '3089', count: 1 }] }]);
  assert.equal(r.ok, true);
  const sent = fake.st.puts[fake.st.puts.length - 1].itemSets[0];
  assert.ok(!('priority' in sent));
  assert.equal(sent.blocks[0].hideIfSummonerSpell, '');
  assert.equal(await lcu.removeAccountSets(), 2);
  assert.deepEqual(fake.st.sets.itemSets.map((s) => s.title), ['My set']);
});

test('wedstrydgeskiedenis: hele venster een keer, bladsye sonder duplikate (die kliënt ignoreer later reekse)', async () => {
  fake.st.historyCache.clear();
  // 'n Ander app het eerste 'n klein reeks gevra: die kliënt onthou nou net 3 games
  const tiny = await lcu.matchList(ME, 0, 2);
  assert.equal(tiny.length, 3);
  fake.st.historyCache.clear();
  const page1 = await lcu.matchList(ME, 0, 9);
  const page2 = await lcu.matchList(ME, 10, 19);
  assert.equal(page1.length, 10);
  assert.equal(page2.length, 10);
  assert.ok(!page2.some((g) => page1.find((x) => x.gameId === g.gameId)), 'bladsy 2 is nie bladsy 1 weer nie');
  assert.ok(fake.st.historyCalls.every((c) => c.endsWith(':0-49')), fake.st.historyCalls.join(' '));
});

test('wedstrydgeskiedenis: leë lys vir jouself -> ook die kliënt se current-summoner-roete', async () => {
  fake.st.historyCache.set('me', []);
  const calls = fake.st.historyCalls.length;
  const w = await lcu.matchWindow(ME, { self: true });
  assert.equal(w.length, 0);
  assert.ok(fake.st.historyCalls.slice(calls).some((c) => c.startsWith('current-summoner')));
});

test('stadige kliënt: tyd verstreke is nie "League is toe" nie', async () => {
  fake.st.phase = 'ChampSelect';
  fake.st.hang.add('/lol-gameflow/v1/gameflow-phase');
  const slow = await lcu.state();
  assert.equal(slow.connected, true);
  assert.equal(slow.stale, true);
  fake.st.hang.delete('/lol-gameflow/v1/gameflow-phase');
  fake.st.session = null;
  const back = await lcu.state();
  assert.equal(back.connected, true, 'die verbinding (lockfile) is nie weggegooi nie');
  assert.equal(back.phase, 'ChampSelect');
});
