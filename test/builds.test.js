// Toetse vir die build-data logika (builds.js). Loop met: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const b = require('../builds');

const cls = { isCompleted: (id) => id >= 3000, isBoots: (id) => id === 3020 };
const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const PAGE = { styles: [{ style: 8100, selections: [{ perk: 8112 }, { perk: 8139 }, { perk: 8138 }, { perk: 8135 }] }, { style: 8200, selections: [{ perk: 8226 }, { perk: 8210 }] }], statPerks: { offense: 5008, flex: 5008, defense: 5001 } };

// Een wedstryd: blou mid (champ 103) teen rooi mid (champ 238); goud op 15:00 bepaal wie die lane wen
function match({ blueWin = true, midGoldDiff = 0, frames = true } = {}) {
  const participants = Array.from({ length: 10 }, (_, i) => ({
    participantId: i + 1, championId: i === 2 ? 103 : i === 7 ? 238 : 500 + i, teamPosition: ROLES[i % 5],
    teamId: i < 5 ? 100 : 200, win: i < 5 ? blueWin : !blueWin, summoner1Id: 4, summoner2Id: 14, perks: PAGE,
  }));
  const fr = [];
  if (frames) {
    for (let m = 0; m <= 20; m++) {
      const pf = {};
      for (let p = 1; p <= 10; p++) pf[String(p)] = { totalGold: 500 + m * 300 + (p === 3 && m === 15 ? midGoldDiff : 0) };
      fr.push({ timestamp: m * 60000 + 40, participantFrames: pf, events: m === 1 ? [{ type: 'ITEM_PURCHASED', participantId: 3, itemId: 3089, timestamp: 50000 }] : [] });
    }
  }
  return [{ info: { participants } }, { info: { frames: fr } }];
}

test('runeKey en parseRuneKey gaan heen en terug', () => {
  const key = b.runeKey(PAGE);
  assert.equal(key, '8100:8112,8139,8138,8135|8200:8226,8210|5008,5008,5001');
  assert.deepEqual(b.parseRuneKey(key), { primaryStyleId: 8100, subStyleId: 8200, primary: [8112, 8139, 8138, 8135], secondary: [8226, 8210], shards: [5008, 5008, 5001] });
});

test('lane-oorwinning kom uit die goud op 15 minute teen die lane-teenstander', () => {
  const ahead = b.analyzeMatch(...match({ midGoldDiff: 250 }), cls);
  assert.equal(ahead.find((r) => r.championId === 103).laneWin, true);
  assert.equal(ahead.find((r) => r.championId === 238).laneWin, false);
  const even = b.analyzeMatch(...match({ midGoldDiff: 0 }), cls);
  assert.equal(even.find((r) => r.championId === 103).laneWin, null, 'gelyk = geen lane-uitslag');
  const none = b.analyzeMatch(...match({ frames: false }), cls);
  assert.equal(none.find((r) => r.championId === 103).laneWin, null, 'sonder tydlyn = geen lane-uitslag');
});

function freshDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rs-test-')), 'builds.json');
  return new b.BuildDB(file);
}

test('matchup stoor games, wins en lane; counterPicks keer dit om vir die ander kant', () => {
  const db = freshDb();
  // 103 wen 3 van 4 teen 238, en is 2 keer voor op 15 min
  db.addMatch('16.23', b.analyzeMatch(...match({ blueWin: true, midGoldDiff: 100 }), cls));
  db.addMatch('16.23', b.analyzeMatch(...match({ blueWin: true, midGoldDiff: 100 }), cls));
  db.addMatch('16.23', b.analyzeMatch(...match({ blueWin: true, midGoldDiff: -100 }), cls));
  db.addMatch('16.23', b.analyzeMatch(...match({ blueWin: false, midGoldDiff: -100 }), cls));
  const ahri = db.statsFor(103, 'MIDDLE').stats;
  assert.deepEqual([ahri.vs[238].games, ahri.vs[238].wins], [4, 3]);
  assert.deepEqual(ahri.vs[238].lane, [4, 2]);
  const counters = b.counterPicks(db.statsFor(238, 'MIDDLE').stats, 1, 5);
  assert.equal(counters[0].championId, 103);
  assert.equal(counters[0].wr, 0.75);
  assert.equal(counters[0].laneWr, 0.5);
  assert.equal(counters[0].games, 4);
});

test('counterPicks sorteer met min games na 50% toe getrek (3 uit 3 klop nie 60 uit 100 nie)', () => {
  const enemy = { vs: { 1: { games: 3, wins: 0 }, 2: { games: 100, wins: 40 }, 3: { games: 2, wins: 0 } } };
  const list = b.counterPicks(enemy, 3, 10);
  assert.deepEqual(list.map((x) => x.championId), [2, 1], 'minder as minGames word uitgelaat');
  assert.equal(list[1].wr, 1);
  assert.equal(list[0].laneWr, null, 'geen lane-data = null, nie 0 nie');
});

test('bestInRole gee net champions met genoeg games', () => {
  const list = b.bestInRole([
    { championId: 1, games: 50, wins: 30, laneGames: 50, laneWins: 20 },
    { championId: 2, games: 5, wins: 5, laneGames: 0, laneWins: 0 },
    { championId: 3, games: 40, wins: 18, laneGames: 0, laneWins: 0 },
  ], 20, 10, [3]);
  assert.deepEqual(list.map((x) => x.championId), [1]);
  assert.equal(list[0].laneWr, 0.4);
});

test('stoor: ouer patches hou net matchup-syfers (kleiner lêer), nuutste 2 hou alles', () => {
  const db = freshDb();
  for (const p of ['16.21', '16.22', '16.23']) db.addMatch(p, b.analyzeMatch(...match({ midGoldDiff: 50 }), cls));
  db.save();
  const saved = JSON.parse(fs.readFileSync(db.file, 'utf8'));
  assert.deepEqual(Object.keys(saved.patches['16.21'].champs[103].MIDDLE.vs[238]).sort(), ['games', 'lane', 'wins']);
  assert.ok(saved.patches['16.23'].champs[103].MIDDLE.vs[238].runes, 'nuutste patch hou runes per matchup');
  // Oor 3 patches saamgevoeg bly die syfers reg
  const all = new b.BuildDB(db.file).statsFor(103, 'MIDDLE', 3).stats.vs[238];
  assert.equal(all.games, 3);
  assert.deepEqual(all.lane, [3, 3]);
});

test('recommend gebruik matchup-runes eers as daar genoeg games teen die vyand is', () => {
  const db = freshDb();
  for (let i = 0; i < 9; i++) db.addMatch('16.23', b.analyzeMatch(...match({ midGoldDiff: 10 }), cls));
  const rec = b.recommend(db.statsFor(103, 'MIDDLE').stats, 238);
  assert.equal(rec.vs.championId, 238);
  assert.ok(rec.fromMatchup.includes('runes'));
  assert.deepEqual(rec.lane, [9, 9]);
});

test('guessRoles gee elke champion in die span sy beste rol', () => {
  const g = b.guessRoles([
    { championId: 1, roles: { MIDDLE: 10 } }, { championId: 2, roles: { JUNGLE: 10 } },
    { championId: 3, roles: { BOTTOM: 10 } }, { championId: 4, roles: { UTILITY: 10, MIDDLE: 2 } }, { championId: 5, roles: { TOP: 10 } },
  ]);
  assert.deepEqual(g, { 1: 'MIDDLE', 2: 'JUNGLE', 3: 'BOTTOM', 4: 'UTILITY', 5: 'TOP' });
});

test('items vir champions met min games: rolle saam, item-profiel, gewigte', () => {
  const db = new b.BuildDB(path.join(os.tmpdir(), 'rs-many-never-saved.json'));
  const row = (c, role, win, completed) => ({ championId: c, role, vs: 0, win, laneWin: null, runes: '8100:8112,8139,8138,8135|8200:8226,8210|5008,5008,5001',
    spells: '4,14', start: '1056,2003', completed, boots: 3020, maxOrder: 'Q>W>E', skills: 'QWEQQRQWQWRWWEE' });
  for (let i = 0; i < 4; i++) db.addMatch('16.23', [row(1, 'MIDDLE', true, [3089, 3157, 3135])]);
  for (let i = 0; i < 6; i++) db.addMatch('16.23', [row(1, 'TOP', i < 3, [3089, 3157, 3135])]);
  for (let i = 0; i < 5; i++) db.addMatch('16.23', [row(99, 'MIDDLE', true, [3089, 3135, 3157])]);
  for (let i = 0; i < 5; i++) db.addMatch('16.23', [row(122, 'TOP', true, [3071, 3053, 6333])]);
  const s = db.statsForRoles(1, ['TOP', 'MIDDLE']);
  assert.equal(s.games, 10);
  assert.equal(s.wins, 7);
  assert.deepEqual(b.recommend(s, null).core[0].ids, [3089, 3157, 3135]);
  // Annie en Lux koop dieselfde items, Darius heeltemal ander
  const p1 = b.itemProfile(s), p99 = b.itemProfile(db.statsFor(99, 'MIDDLE').stats), p122 = b.itemProfile(db.statsFor(122, 'TOP').stats);
  assert.ok(Math.abs(b.profileSimilarity(p1, p99) - 1) < 1e-9);
  assert.equal(b.profileSimilarity(p1, p122), 0);
  assert.equal(b.profileSimilarity(p1, b.itemProfile({ games: 0, items: {} })), 0);
  // Gewigte: 1 game ×3 + 2 games ×1, tellings bly heelgetalle
  const m = b.weightedMerge([{ s: db.statsFor(122, 'TOP').stats, w: 0.2 }, { s: db.statsFor(99, 'MIDDLE').stats, w: 1 }]);
  assert.equal(m.games, 6);
  assert.deepEqual(m.items['3071'], [1, 1]);
  assert.deepEqual(m.items['3089'], [5, 5]);
  assert.equal(b.weightedMerge([]).games, 0);
  // Nuwe champion sonder games: klas, reikafstand en AD/AP tel
  const mage = { tags: ['Mage'], partype: 'Mana', range: 550, info: { attack: 2, magic: 9 } };
  const mage2 = { tags: ['Mage', 'Support'], partype: 'Mana', range: 525, info: { attack: 1, magic: 10 } };
  const fighter = { tags: ['Fighter', 'Tank'], partype: 'None', range: 175, info: { attack: 9, magic: 1 } };
  assert.ok(b.metaSimilarity(mage, mage2) > b.metaSimilarity(mage, fighter));
  assert.equal(b.metaSimilarity(mage, null), 0);
});

test('4de–6de item-opsies wys nie items wat reeds in die kern-build is nie', () => {
  const db = new b.BuildDB(path.join(os.tmpdir(), 'rs-late-never-saved.json'));
  const row = (completed) => ({ championId: 1, role: 'MIDDLE', vs: 0, win: true, laneWin: null, runes: '8100:8112,8139,8138,8135|8200:8226,8210|5008,5008,5001',
    spells: '4,14', start: '1056,2003', completed, boots: 3020, maxOrder: 'Q>W>E', skills: 'QWEQQRQWQWRWWEE' });
  for (let i = 0; i < 5; i++) db.addMatch('16.23', [row([3089, 3157, 3135, 3100])]);
  for (let i = 0; i < 2; i++) db.addMatch('16.23', [row([3157, 3089, 3100, 3135])]);
  const rec = b.recommend(db.statsFor(1, 'MIDDLE').stats, null);
  assert.deepEqual(rec.core[0].ids, [3089, 3157, 3135]);
  assert.deepEqual(rec.item4.map((e) => e.id), [3100], 'Void Staff (3135) is reeds in die kern');
});

test('ná \'n patch: items en runes wat Riot uitgehaal het, word nie meer aanbeveel nie', () => {
  const db = new b.BuildDB(path.join(os.tmpdir(), 'rs-patch-never-saved.json'));
  const row = (completed, runes) => ({ championId: 1, role: 'MIDDLE', vs: 0, win: true, laneWin: null, runes,
    spells: '4,14', start: '1056,2003', completed, boots: 3020, maxOrder: 'Q>W>E', skills: 'QWEQQRQWQWRWWEE' });
  const oldRunes = '8100:8112,8139,8138,8135|8200:8226,8210|5008,5008,5001';
  const newRunes = '8100:8128,8139,8138,8135|8200:8226,8210|5008,5008,5001';
  // Die meeste games is ouer, met item 9999 en rune 8112 wat in die nuwe patch weg is
  for (let i = 0; i < 6; i++) db.addMatch('16.22', [row([9999, 3157, 3135, 3100], oldRunes)]);
  for (let i = 0; i < 3; i++) db.addMatch('16.23', [row([3089, 3157, 3135, 3100], newRunes)]);
  const stats = db.statsFor(1, 'MIDDLE', 2).stats;
  assert.deepEqual(b.recommend(stats, null).core[0].ids, [9999, 3157, 3135], 'sonder Data Dragon: net die data');
  try {
    b.setValidity({
      items: new Set(['1056', '2003', '3020', '3089', '3157', '3135', '3100']),
      runes: new Set(['8100', '8200', '8128', '8139', '8138', '8135', '8226', '8210']),
      spells: new Set(['4', '14']),
    });
    const rec = b.recommend(stats, null);
    assert.deepEqual(rec.core[0].ids, [3089, 3157, 3135], 'die kern-build met die uitgehaalde item val weg');
    assert.ok(!rec.items.some((e) => e.id === 9999));
    assert.deepEqual(rec.runes.map((r) => r.page.primary[0]), [8128], 'die rune page met die uitgehaalde rune val weg');
    assert.deepEqual(rec.start[0].ids, [1056, 2003]);
    assert.deepEqual(rec.spells[0].ids, [4, 14]);
  } finally {
    b.setValidity(null);
  }
});
