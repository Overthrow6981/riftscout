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

test('rune page vervang: eers \'n rugsteun van die volle bladsy; sonder rugsteun word niks uitgevee nie', async () => {
  const full = (id, name, current) => ({ id, name, current, isDeletable: true, isEditable: true, primaryStyleId: 8000, subStyleId: 8400, selectedPerkIds: [8010, 9111, 9104, 8299, 8444, 8242, 5005, 5008, 5001] });
  fake.st.pages = [full(1, 'A', false), full(2, 'My Darius', true), full(3, 'C', false)];
  // Die rugsteun misluk: die bladsy bly, en die fout sê so
  let r = await lcu.importRunes(rune, 'RiftScout Annie', true, { backup: () => null });
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not save a backup of your rune page "My Darius"/);
  assert.deepEqual(fake.st.pages.map((p) => p.name), ['A', 'My Darius', 'C'], 'niks uitgevee nie');
  // Die rugsteun werk: dit kry die volle bladsy voor dit uitgevee word
  const saved = [];
  r = await lcu.importRunes(rune, 'RiftScout Annie', true, { backup: (p) => { saved.push({ ...p, stillThere: fake.st.pages.some((x) => x.id === p.id) }); return { id: 'bk1' }; } });
  assert.equal(r.ok, true);
  assert.equal(r.replaced, 'My Darius');
  assert.equal(r.backupId, 'bk1');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].stillThere, true, 'die rugsteun kom voor die uitvee');
  assert.deepEqual(saved[0].selectedPerkIds, [8010, 9111, 9104, 8299, 8444, 8242, 5005, 5008, 5001]);
  // Met "Replace" af: niks word vervang nie (en geen rugsteun nodig nie)
  fake.st.pages = [full(1, 'A', false), full(2, 'B', true), full(3, 'C', false)];
  r = await lcu.importRunes(rune, 'RiftScout Annie', false, { backup: () => { throw new Error('mag nie geroep word nie'); } });
  assert.equal(r.ok, false);
  assert.deepEqual(fake.st.pages.map((p) => p.name), ['A', 'B', 'C']);
});

test('rune page terugsit: as \'n nuwe bladsy (nie gekies nie); vol -> net RiftScout se eie bladsy maak plek', async () => {
  const saved = { name: 'My Darius', primaryStyleId: 8000, subStyleId: 8400, selectedPerkIds: [8010, 9111, 9104, 8299, 8444, 8242, 5005, 5008, 5001] };
  fake.st.pages = [{ id: 1, name: 'A', current: true, isDeletable: true, isEditable: true }];
  let r = await lcu.restoreRunePage(saved);
  assert.equal(r.ok, true);
  const back = fake.st.pages.find((p) => p.name === 'My Darius');
  assert.deepEqual(back.selectedPerkIds, saved.selectedPerkIds);
  assert.equal(fake.st.pages.find((p) => p.current).name, 'A', 'jou huidige keuse bly');
  // Vol, met RiftScout se bladsy: dié gaan weg
  fake.st.pages = [{ id: 1, name: 'A', current: true, isDeletable: true }, { id: 2, name: 'RiftScout Zed', isDeletable: true }, { id: 3, name: 'C', isDeletable: true }];
  r = await lcu.restoreRunePage(saved);
  assert.equal(r.ok, true);
  assert.equal(r.freed, 'RiftScout Zed');
  assert.deepEqual(fake.st.pages.map((p) => p.name), ['A', 'C', 'My Darius']);
  // Vol, sonder RiftScout se bladsy: niks word uitgevee nie
  fake.st.pages = [{ id: 1, name: 'A', current: true, isDeletable: true }, { id: 2, name: 'B', isDeletable: true }, { id: 3, name: 'C', isDeletable: true }];
  r = await lcu.restoreRunePage(saved);
  assert.equal(r.ok, false);
  assert.match(r.error, /No free rune page/);
  assert.deepEqual(fake.st.pages.map((p) => p.name), ['A', 'B', 'C']);
  assert.equal((await lcu.restoreRunePage({ name: 'x', primaryStyleId: 8000, selectedPerkIds: [1] })).ok, false, 'onvolledige rugsteun');
  // In champ select: RiftScout se bladsy is gekies en word nie weggevat nie (freeSelected af)
  fake.st.pages = [{ id: 1, name: 'A', isDeletable: true }, { id: 2, name: 'RiftScout Zed', current: true, isDeletable: true }, { id: 3, name: 'C', isDeletable: true }];
  r = await lcu.restoreRunePage(saved, { freeSelected: false });
  assert.equal(r.ok, false);
  assert.deepEqual(fake.st.pages.map((p) => p.name), ['A', 'RiftScout Zed', 'C'], 'die gekose bladsy bly');
  r = await lcu.restoreRunePage(saved, { freeSelected: true });
  assert.equal(r.ok, true, 'buite champ select mag dit');
});

test('rune page vervang: as League die nuwe bladsy weier ná die uitvee, sê die fout dat daar \'n rugsteun is', async () => {
  const full = (id, name, current) => ({ id, name, current, isDeletable: true, primaryStyleId: 8000, subStyleId: 8400, selectedPerkIds: [8010, 9111, 9104, 8299, 8444, 8242, 5005, 5008, 5001] });
  fake.st.pages = [full(1, 'A', false), full(2, 'My Darius', true), full(3, 'C', false)];
  fake.st.maxPages = 2; // ná die uitvee is daar steeds nie plek nie
  const r = await lcu.importRunes(rune, 'RiftScout Annie', true, { backup: () => ({ id: 'bk9' }) });
  fake.st.maxPages = 3;
  assert.equal(r.ok, false);
  assert.equal(r.backupId, 'bk9');
  assert.match(r.error, /"My Darius" was removed to make room.*Settings → Backups/);
});

test('Blitz-rugsteun terugsit na die regte League-gids; nie oor \'n bestaande lêer nie', async () => {
  const os = require('os');
  lcu.setBackupDir(fs.mkdtempSync(path.join(os.tmpdir(), 'rs-bk-')));
  const folder = path.join(fake.install, 'Config', 'Global', 'Recommended');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, '!!!blitz-0.json');
  const body = JSON.stringify({ title: 'Blitz: Crit Miss Fortune', blocks: [] });
  fs.writeFileSync(file, body);
  assert.equal(await lcu.removeBlitzShopFiles(), 1);
  assert.ok(!fs.existsSync(file));
  const [e] = lcu.listBlitzBackups();
  let r = await lcu.restoreBlitzBackup(e.id);
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.readFileSync(file, 'utf8'), body, 'presies dieselfde lêer op dieselfde plek');
  r = await lcu.restoreBlitzBackup(e.id);
  assert.equal(r.ok, false);
  assert.match(r.error, /already a file/);
  fs.rmSync(file);
  // 'n Gepeuterde lys wat na 'n ander gids wys, word geweier
  const mf = path.join(lcu._backupDirForTest(), 'blitz-backup', 'manifest.json');
  const list = JSON.parse(fs.readFileSync(mf, 'utf8'));
  list[0].from = path.join(fake.install, 'evil.json');
  fs.writeFileSync(mf, JSON.stringify(list));
  r = await lcu.restoreBlitzBackup(e.id);
  assert.equal(r.ok, false);
  assert.ok(!fs.existsSync(path.join(fake.install, 'evil.json')));
});

test('Blitz-rugsteun uit die rekening: terugsit een keer, nie twee keer nie', async () => {
  const os = require('os');
  lcu.setBackupDir(fs.mkdtempSync(path.join(os.tmpdir(), 'rs-bk-')));
  fake.st.sets.itemSets = [{ uid: 'b1', title: 'Blitz: Annie Mid', associatedChampions: [1], blocks: [] }, { uid: 'u', title: 'Mine', associatedChampions: [1], blocks: [] }];
  const r = await lcu.importItemSet(1, 'RiftScout Annie Mid', [{ type: 'Core', items: [{ id: '3089', count: 1 }] }], { removeBlitz: true, champName: 'Annie' });
  assert.equal(r.ok, true);
  assert.equal(r.removedBlitz, 1);
  assert.ok(!fake.st.sets.itemSets.some((x) => x.uid === 'b1'));
  const [e] = lcu.listBlitzBackups();
  assert.equal(e.kind, 'account');
  assert.equal((await lcu.restoreBlitzBackup(e.id)).ok, true);
  assert.equal(fake.st.sets.itemSets.filter((x) => x.uid === 'b1').length, 1);
  const again = await lcu.restoreBlitzBackup(e.id);
  assert.equal(again.ok, false);
  assert.match(again.error, /already in your League account/);
  assert.equal(fake.st.sets.itemSets.filter((x) => x.uid === 'b1').length, 1);
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
