// Item sets in die winkel: League se Config\Global\Recommended-lêers (soos Blitz dit skryf) en die rekening se lys
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lcu = require('../lcu');

const F = lcu._files;
const tmpLeague = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-shop-'));
  fs.mkdirSync(path.join(dir, 'Config'));
  return dir;
};
const blocks = [{ type: 'Starting items', items: [{ id: '1056', count: 1 }, { id: '2003', count: 2 }] }, { type: 'Empty', items: [] }];
// 'n Blitz-oorblyfsel soos die Blitz-app dit in Config\Global\Recommended skryf
const blitzSet = { title: 'Blitz: Crit Miss Fortune', championKey: 'MissFortune', map: 'any', mode: 'any', type: 'custom', priority: true, sortrank: 1000000000,
  blocks: [{ type: 'Starting Items', items: [{ id: '1055', count: 1 }] }] };

test('die winkel-lêer het Blitz se vorm, priority en \'n rang bo Blitz s\'n', () => {
  const s = F.shopSet('Senna', 'RiftScout Senna Support vs Seraphine', blocks);
  assert.equal(s.priority, true);
  assert.equal(s.type, 'custom');
  assert.equal(s.map, 'any');
  assert.equal(s.championKey, 'Senna');
  assert.ok(s.sortrank > blitzSet.sortrank && s.sortrank <= 2147483647, 'binne die 32-bis rang');
  assert.equal(s.blocks.length, 1, 'leë blokke word weggelaat');
  assert.deepEqual(s.blocks[0].items, [{ id: '1056', count: 1 }, { id: '2003', count: 2 }]);
  assert.equal(s.blocks[0].hideIfSummonerSpell, '');
});

test('die winkel-gids kom uit die League-gids (ook op E:), Garena se Game\\Config ook', () => {
  const dir = tmpLeague();
  assert.deepEqual(F.shopFolders(dir), [path.join(dir, 'Config', 'Global', 'Recommended')]);
  assert.deepEqual(F.shopFolders(path.join(dir, 'nope')), [], 'sonder Config-gids: niks');
  assert.deepEqual(F.shopFolders(null), []);
  const garena = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-garena-'));
  fs.mkdirSync(path.join(garena, 'LeagueClient'));
  fs.mkdirSync(path.join(garena, 'Game', 'Config'), { recursive: true });
  assert.deepEqual(F.shopFolders(path.join(garena, 'LeagueClient')), [path.join(garena, 'LeagueClient', '..', 'Game', 'Config', 'Global', 'Recommended')]);
});

test('skryf ons set, haal Blitz se oorblyfsels uit, los die speler en ander apps se lêers', () => {
  const dir = tmpLeague();
  const [folder] = F.shopFolders(dir);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, '!!!blitz-0.json'), JSON.stringify(blitzSet));
  fs.writeFileSync(path.join(folder, 'other-name.json'), JSON.stringify({ ...blitzSet, title: 'Blitz: Lux Support' }));
  fs.writeFileSync(path.join(folder, 'mine.json'), JSON.stringify({ title: 'My own set', blocks: [] }));
  fs.writeFileSync(path.join(folder, 'crank.json'), JSON.stringify({ title: 'Blitzcrank hooks', blocks: [] }));
  fs.writeFileSync(path.join(folder, `${F.SHOP_FILE_PREFIX}3.json`), '{}'); // ou lêer van ons
  // Eers sonder om Blitz uit te haal: ons set wys tog eerste (hoër rang)
  let r = F.writeShopFiles([folder], F.shopSet('Senna', 'RiftScout Senna', blocks), { removeBlitz: false });
  assert.equal(r.written.length, 1);
  assert.equal(r.removedBlitz, 0);
  let st = F.shopFilesStatus([folder]);
  assert.deepEqual(st, { ours: true, first: true, blitz: 2 });
  assert.ok(!fs.existsSync(path.join(folder, `${F.SHOP_FILE_PREFIX}3.json`)), 'ons ou lêers is weg');
  // Met die voorkeur aan: Blitz se twee sets weg (op naam en op titel), alles anders bly
  r = F.writeShopFiles([folder], F.shopSet('Senna', 'RiftScout Senna', blocks), { removeBlitz: true });
  assert.equal(r.removedBlitz, 2);
  assert.deepEqual(fs.readdirSync(folder).sort(), [`${F.SHOP_FILE_PREFIX}0.json`, 'crank.json', 'mine.json']);
  const saved = JSON.parse(fs.readFileSync(path.join(folder, `${F.SHOP_FILE_PREFIX}0.json`), 'utf8'));
  assert.equal(saved.title, 'RiftScout Senna');
  assert.ok(!fs.readdirSync(folder).some((n) => n.endsWith('.tmp')), 'geen halwe lêers bly oor nie');
  st = F.shopFilesStatus([folder]);
  assert.deepEqual(st, { ours: true, first: true, blitz: 0 });
});

test('\'n ander set met priority en \'n hoër rang word raakgesien (nie meer eerste nie)', () => {
  const dir = tmpLeague();
  const [folder] = F.shopFolders(dir);
  F.writeShopFiles([folder], F.shopSet('Senna', 'RiftScout Senna', blocks));
  fs.writeFileSync(path.join(folder, 'zzz.json'), JSON.stringify({ title: 'Other app', priority: true, sortrank: 2147483647, blocks: [] }));
  assert.deepEqual(F.shopFilesStatus([folder]), { ours: true, first: false, blitz: 0 });
});

test('opruim ná die game haal net ons lêer uit', () => {
  const dir = tmpLeague();
  const [folder] = F.shopFolders(dir);
  F.writeShopFiles([folder], F.shopSet('Senna', 'RiftScout Senna', blocks));
  fs.writeFileSync(path.join(folder, '!!!blitz-0.json'), JSON.stringify(blitzSet));
  assert.equal(F.removeShopFiles([folder]), 1);
  assert.deepEqual(fs.readdirSync(folder), ['!!!blitz-0.json']);
  assert.equal(F.removeShopFiles([folder], { ours: false, blitz: true }), 1, '"Close Blitz": Blitz se oorblyfsels');
  assert.deepEqual(fs.readdirSync(folder), []);
});

test('rekening se lys: ons set eerste, ander sets onveranderd, hoogstens 8 van ons sets', () => {
  const user = { uid: 'u1', title: 'My Jhin', associatedChampions: [202], blocks: [], sortrank: 3 };
  const old = Array.from({ length: 12 }, (_, i) => ({ uid: `o${i}`, title: `RiftScout Champ ${i}`, associatedChampions: [500 + i], blocks: [] }));
  const sameChamp = { uid: 'x', title: 'RiftScout Senna Support', associatedChampions: [235], blocks: [] };
  const blitz = { uid: 'b', title: 'Blitz: Senna', associatedChampions: [235], blocks: [] };
  const fresh = { uid: 'new', title: 'RiftScout Senna Support vs Lux', associatedChampions: [235], blocks: [] };
  const { itemSets, removedBlitz } = F.mergeAccountSets([sameChamp, ...old, user, blitz], 235, fresh, { removeBlitz: true, champName: 'Senna' });
  assert.equal(itemSets[0], fresh);
  assert.ok(itemSets.includes(user), 'die speler se set bly');
  assert.ok(!itemSets.includes(sameChamp), 'ons ou set vir dieselfde champion is vervang');
  assert.equal(removedBlitz, 1);
  assert.equal(itemSets.filter((s) => s.title.startsWith('RiftScout')).length, 8);
  assert.deepEqual(itemSets.filter((s) => s.title.startsWith('RiftScout Champ')).map((s) => s.uid), ['o0', 'o1', 'o2', 'o3', 'o4', 'o5', 'o6'], 'die nuutste bly, die oudstes gaan');
});
