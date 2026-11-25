// Toetse vir die versamelaar (tools/collect.js): sleutel-toets, statuslêer, net publiseer met nuwe games,
// en geen Riot-sleutel in die uitvoer nie. Die integrasietoetse loop collect.js teen 'n nagemaakte Riot API.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const b = require('../builds');
const { redact, publicText, classifyKeyCheck, buildStatus, exitCodeFor } = require('../tools/collect');

// 'n Nagemaakte sleutel in Riot se vorm (nie 'n regte sleutel nie)
const FAKE_KEY = 'RGAPI-00000000-1111-2222-3333-444444444444';

test('redact: Riot-sleutels verdwyn uit teks', () => {
  assert.equal(redact(`header ${FAKE_KEY} end`), 'header RGAPI-*** end');
  assert.equal(redact('rgapi-abcdef12-0000'), 'RGAPI-***');
  assert.equal(redact('no key here'), 'no key here');
  assert.equal(redact(null), '');
});

test('classifyKeyCheck: 401/403 is die sleutel, ander foute nie', () => {
  assert.equal(classifyKeyCheck(200), 'ok');
  assert.equal(classifyKeyCheck(401), 'key_invalid');
  assert.equal(classifyKeyCheck(403), 'key_invalid');
  assert.equal(classifyKeyCheck(429), 'riot_unreachable');
  assert.equal(classifyKeyCheck(500), 'riot_unreachable');
  assert.equal(classifyKeyCheck(0), 'riot_unreachable');
});

test('buildStatus: lastSuccess net met nuwe games; anders oorgedra van die vorige status', () => {
  const prev = { lastSuccess: 1000, lastMatchAt: 900, totalMatches: 50, patches: ['16.22'] };
  const fail = buildStatus({ prev, now: 5000, newMatches: 0, error: 'key_invalid' });
  assert.equal(fail.ok, false);
  assert.equal(fail.lastRun, 5000);
  assert.equal(fail.lastSuccess, 1000);
  assert.equal(fail.lastMatchAt, 900);
  assert.equal(fail.totalMatches, 50);
  assert.deepEqual(fail.patches, ['16.22']);
  assert.equal(fail.error, 'key_invalid');
  assert.match(fail.message, /expired or invalid/);
  assert.equal(exitCodeFor(fail), 2);

  const none = buildStatus({ prev, now: 6000, newMatches: 0 });
  assert.equal(none.error, 'no_new_matches');
  assert.equal(exitCodeFor(none), 1);

  const good = buildStatus({ prev, now: 7000, newMatches: 12, data: { matches: 62, lastMatchAt: 6900, patches: { '16.22': {}, '16.23': {} } } });
  assert.equal(good.ok, true);
  assert.equal(good.lastSuccess, 7000);
  assert.equal(good.lastMatchAt, 6900);
  assert.equal(good.totalMatches, 62);
  assert.deepEqual(good.patches, ['16.23', '16.22']);
  assert.equal(good.error, null);
  assert.equal(exitCodeFor(good), 0);

  assert.equal(publicText('Riot API 503 for /lol/match/v5/matches/by-puuid/abc-123/ids?start=0'), 'Riot API 503 for /lol/…');
  assert.ok(!buildStatus({ error: 'riot_unreachable', message: 'Riot API 500 for /lol/match/v5/matches/by-puuid/SECRETPUUID/ids' }).message.includes('SECRETPUUID'), 'geen speler-ID in die publieke status');
  const msg = buildStatus({ error: 'crashed', message: `boom ${FAKE_KEY}` });
  assert.ok(!msg.message.includes(FAKE_KEY));
  assert.equal(buildStatus({ error: 'key_missing' }).lastSuccess, null);
});

test('BuildDB.addMatch onthou wanneer die nuutste game bygekom het', () => {
  const db = new b.BuildDB(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rs-db-')), 'b.json'));
  assert.equal(db.data.lastMatchAt, undefined);
  const t = Date.now();
  db.addMatch('16.23', []);
  assert.ok(db.data.lastMatchAt >= t);
});

// ---------- Integrasie: collect.js teen 'n nagemaakte Riot API ----------
const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const PAGE = { styles: [{ style: 8100, selections: [{ perk: 8112 }, { perk: 8139 }, { perk: 8138 }, { perk: 8135 }] }, { style: 8200, selections: [{ perk: 8226 }, { perk: 8210 }] }], statPerks: { offense: 5008, flex: 5008, defense: 5001 } };
function riotMatch() {
  const participants = Array.from({ length: 10 }, (_, i) => ({
    participantId: i + 1, championId: 500 + i, teamPosition: ROLES[i % 5], teamId: i < 5 ? 100 : 200, win: i < 5,
    summoner1Id: 4, summoner2Id: 14, perks: PAGE,
  }));
  const frames = [];
  for (let m = 0; m <= 16; m++) {
    const pf = {};
    for (let p = 1; p <= 10; p++) pf[String(p)] = { totalGold: 500 + m * 300 };
    frames.push({ timestamp: m * 60000, participantFrames: pf, events: [] });
  }
  return {
    match: { info: { queueId: 420, gameCreation: Date.now() - 3600e3, gameDuration: 1800, gameVersion: '16.23.512.1', participants } },
    timeline: { info: { frames } },
  };
}

let mock;
let keyStatus = 200;
let statusOverride = null; // net die sleutel-toets se antwoord (bv. 503)
before(async () => {
  const { match, timeline } = riotMatch();
  mock = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers['x-riot-token'] !== FAKE_KEY && u.startsWith('/riot/')) return send(401, {});
    if (u === '/dd/api/versions.json') return send(200, ['16.23.1']);
    if (u === '/dd/cdn/16.23.1/data/en_US/item.json') return send(200, { data: { 3089: { name: 'Deathcap', gold: { total: 3600, purchasable: true }, tags: [], maps: { 11: true } } } });
    if (u === '/riot/na1/lol/status/v4/platform-data') return send(statusOverride || keyStatus, {});
    if (keyStatus !== 200) return send(keyStatus, {});
    if (u === '/riot/na1/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5') return send(200, { entries: [{ puuid: 'p1' }] });
    if (u.startsWith('/riot/na1/lol/league/v4/')) return send(200, { entries: [] });
    if (u === '/riot/americas/lol/match/v5/matches/by-puuid/p1/ids') return send(200, ['NA1_1']);
    if (u === '/riot/americas/lol/match/v5/matches/NA1_1') return send(200, match);
    if (u === '/riot/americas/lol/match/v5/matches/NA1_1/timeline') return send(200, timeline);
    send(404, {});
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
});
after(() => mock.close());

function runCollect(dir, { key = FAKE_KEY, env = {} } = {}) {
  const base = `http://127.0.0.1:${mock.address().port}`;
  return new Promise((resolve) => {
    const out = fs.openSync(path.join(dir, 'github-output.txt'), 'a');
    fs.closeSync(out);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'collect.js'), '--region', 'na1', '--minutes', '0.05',
      '--file', path.join(dir, 'builds.json'), '--seen', path.join(dir, 'seen.json'), '--status', path.join(dir, 'build-status.json')], {
      env: { ...process.env, RIOT_API_KEY: key, RIOT_HOST_TEMPLATE: `${base}/riot/{route}`, DDRAGON_BASE: `${base}/dd`, GITHUB_OUTPUT: path.join(dir, 'github-output.txt'), ...env },
    });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    child.on('close', (code) => resolve({ code, text, status: JSON.parse(fs.readFileSync(path.join(dir, 'build-status.json'), 'utf8')), output: fs.readFileSync(path.join(dir, 'github-output.txt'), 'utf8') }));
  });
}

test('versamelaar: nuwe games -> builds.json en status ok; daarna vervalde sleutel -> status sê so, data onveranderd', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-collect-'));
  keyStatus = 200;
  const ok = await runCollect(dir);
  assert.equal(ok.code, 0, ok.text);
  assert.equal(ok.status.ok, true);
  assert.equal(ok.status.newMatches, 1);
  assert.ok(ok.status.lastSuccess > 0 && ok.status.lastMatchAt > 0);
  assert.deepEqual(ok.status.patches, ['16.23']);
  assert.match(ok.output, /published=true/);
  const data = fs.readFileSync(path.join(dir, 'builds.json'), 'utf8');
  assert.ok(JSON.parse(data).lastMatchAt > 0);
  assert.ok(!ok.text.includes(FAKE_KEY), 'geen sleutel in die uitvoer');

  // Die sleutel verval: geen nuwe games, builds.json bly presies dieselfde, status wys die fout
  keyStatus = 403;
  const bad = await runCollect(dir);
  assert.equal(bad.code, 2);
  assert.equal(bad.status.ok, false);
  assert.equal(bad.status.error, 'key_invalid');
  assert.equal(bad.status.lastSuccess, ok.status.lastSuccess, 'laaste suksesvolle run bly bekend');
  assert.equal(bad.status.lastMatchAt, ok.status.lastMatchAt);
  assert.match(bad.output, /published=false/);
  assert.equal(fs.readFileSync(path.join(dir, 'builds.json'), 'utf8'), data, 'builds.json nie weer geskryf nie');
  assert.ok(!bad.text.includes(FAKE_KEY));
});

test('versamelaar sonder sleutel: status key_missing, uitgangskode 2', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-collect-'));
  const r = await runCollect(dir, { key: '' });
  assert.equal(r.code, 2);
  assert.equal(r.status.error, 'key_missing');
  assert.ok(!fs.existsSync(path.join(dir, 'builds.json')));
});

test('versamelaar: Riot besig (503 op die sleutel-toets) stop nie die run nie', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-collect-'));
  keyStatus = 200;
  statusOverride = 503;
  const r = await runCollect(dir, { env: { KEY_CHECK_RETRIES: '1', KEY_CHECK_WAIT_MS: '50' } });
  statusOverride = null;
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /collecting anyway/);
  assert.equal(r.status.ok, true);
});
