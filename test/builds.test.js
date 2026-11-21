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

test('statsForMany tel die games van verskeie champions saam (vir klas-items)', () => {
  const db = new b.BuildDB(path.join(os.tmpdir(), 'rs-many-never-saved.json'));
  const row = (c, win) => ({ championId: c, role: 'MIDDLE', vs: 0, win, laneWin: null, runes: '8100:8112,8139,8138,8135|8200:8226,8210|5008,5008,5001',
    spells: '4,14', start: '1056,2003', completed: [3089, 3157, 3135], boots: 3020, maxOrder: 'Q>W>E', skills: 'QWEQQRQWQWRWWEE' });
  for (let i = 0; i < 4; i++) db.addMatch('16.23', [row(1, true)]);
  for (let i = 0; i < 6; i++) db.addMatch('16.23', [row(99, i < 3)]);
  const s = db.statsForMany([1, 99, 555], 'MIDDLE');
  assert.equal(s.games, 10);
  assert.equal(s.wins, 7);
  const rec = b.recommend(s, null);
  assert.deepEqual(rec.core[0].ids, [3089, 3157, 3135]);
  assert.equal(db.statsForMany([], 'MIDDLE').games, 0);
});
