// League Client (LCU) koppeling: champ select lees en runes, item sets en summoner spells invoer.
// Die kliënt loop 'n plaaslike HTTPS-API; die poort en wagwoord kom uit die "lockfile"
// in die League-installasie, of uit die LeagueClientUx-proses se opdragreël.

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const POSITIONS = { top: 'TOP', jungle: 'JUNGLE', middle: 'MIDDLE', bottom: 'BOTTOM', utility: 'UTILITY' };

let creds = null;
let lastLookup = 0;

function readLockfile(file) {
  try {
    const [, , port, password] = fs.readFileSync(file, 'utf8').trim().split(':');
    if (port && password) return { port: Number(port), token: password };
  } catch { /* geen lockfile */ }
  return null;
}

function installDirs() {
  const dirs = [];
  try {
    const yaml = fs.readFileSync('C:\\ProgramData\\Riot Games\\Metadata\\league_of_legends.live\\league_of_legends.live.product_settings.yaml', 'utf8');
    const m = /product_install_full_path:\s*"?([^"\r\n]+)"?/.exec(yaml);
    if (m) dirs.push(m[1].trim());
  } catch { /* nie gevind nie */ }
  for (const d of ['C', 'D', 'E', 'F', 'G']) dirs.push(`${d}:\\Riot Games\\League of Legends`);
  return dirs;
}

function fromProcess() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine"],
    { timeout: 6000, windowsHide: true }, (err, stdout) => {
      const out = String(stdout || '');
      const port = /--app-port=(\d+)/.exec(out);
      const token = /--remoting-auth-token=([\w-]+)/.exec(out);
      resolve(port && token ? { port: Number(port[1]), token: token[1] } : null);
    });
  });
}

async function findCreds() {
  if (creds) return creds;
  if (Date.now() - lastLookup < 8000) return null; // moenie elke keer soek as die kliënt toe is nie
  lastLookup = Date.now();
  if (process.env.LCU_LOCKFILE) return (creds = readLockfile(process.env.LCU_LOCKFILE));
  let c = null;
  for (const dir of installDirs()) { c = readLockfile(path.join(dir, 'lockfile')); if (c) break; }
  if (!c) c = await fromProcess();
  return (creds = c);
}

async function request(method, p, body) {
  const c = await findCreds();
  if (!c) return { status: 0, data: null };
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve) => {
    const headers = { Authorization: 'Basic ' + Buffer.from('riot:' + c.token).toString('base64'), Accept: 'application/json' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = https.request({ host: '127.0.0.1', port: c.port, path: p, method, headers, rejectUnauthorized: false, timeout: 4000 }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        let data = null;
        try { data = buf ? JSON.parse(buf) : null; } catch { data = buf; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => { creds = null; lastLookup = 0; resolve({ status: 0, data: null }); });
    if (payload) req.write(payload);
    req.end();
  });
}

const ok = (r) => r.status >= 200 && r.status < 300;

async function state() {
  const ph = await request('GET', '/lol-gameflow/v1/gameflow-phase');
  if (ph.status === 0) return { connected: false, phase: null, champSelect: null };
  const phase = typeof ph.data === 'string' ? ph.data : 'None';
  let champSelect = null;
  if (phase === 'ChampSelect') {
    const s = await request('GET', '/lol-champ-select/v1/session');
    if (s.status === 200 && s.data) {
      const me = (s.data.myTeam || []).find((x) => x.cellId === s.data.localPlayerCellId);
      if (me) {
        const locked = (s.data.actions || []).flat().some((a) => a.actorCellId === me.cellId && a.type === 'pick' && a.completed);
        champSelect = {
          championId: me.championId || me.championPickIntent || 0,
          locked: locked && !!me.championId,
          role: POSITIONS[me.assignedPosition] || '',
          spell1Id: me.spell1Id || 0,
          spell2Id: me.spell2Id || 0,
          // Vyande se champions (sigbaar sodra hulle gekies is)
          enemies: (s.data.theirTeam || []).map((x) => x.championId).filter((id) => id > 0),
          // Spanmaats vir lobby-scouting (in ranked kan Riot name/puuid versteek)
          // Riot se reëls: versteekte name (ranked) word NIE ontmasker nie
          allies: (s.data.myTeam || []).map((x) => {
            const hidden = x.nameVisibilityType === 'HIDDEN' && x.cellId !== s.data.localPlayerCellId;
            return {
            cellId: x.cellId,
            puuid: hidden ? '' : (x.puuid || ''),
            gameName: hidden ? '' : (x.gameName || ''),
            tagLine: hidden ? '' : (x.tagLine || ''),
            championId: x.championId || x.championPickIntent || 0,
            role: POSITIONS[x.assignedPosition] || '',
            me: x.cellId === s.data.localPlayerCellId,
            };
          }),
        };
      }
    }
  }
  return { connected: true, phase, champSelect };
}

// rune = { primaryStyleId, subStyleId, primary[4], secondary[2], shards[3] }
async function importRunes(rune, name, replaceCurrent) {
  const body = {
    name: name.slice(0, 25),
    primaryStyleId: rune.primaryStyleId,
    subStyleId: rune.subStyleId,
    selectedPerkIds: [...rune.primary, ...rune.secondary, ...rune.shards],
    current: true,
  };
  const pages = await request('GET', '/lol-perks/v1/pages');
  if (pages.status !== 200) return { ok: false, error: 'League client not reachable.' };
  for (const p of pages.data || []) {
    if (String(p.name || '').startsWith('RiftScout') && p.isDeletable) await request('DELETE', `/lol-perks/v1/pages/${p.id}`);
  }
  let r = await request('POST', '/lol-perks/v1/pages', body);
  if (ok(r)) return { ok: true };
  if (replaceCurrent) {
    const cur = await request('GET', '/lol-perks/v1/currentpage');
    if (cur.status === 200 && cur.data && cur.data.isDeletable) {
      await request('DELETE', `/lol-perks/v1/pages/${cur.data.id}`);
      r = await request('POST', '/lol-perks/v1/pages', body);
      if (ok(r)) return { ok: true, replaced: cur.data.name };
    }
  }
  return { ok: false, error: 'No free rune page. Delete one in the client, or turn on "Replace current rune page" in Settings.' };
}

async function importItemSet(championId, title, blocks) {
  const me = await request('GET', '/lol-summoner/v1/current-summoner');
  if (me.status !== 200 || !me.data || !me.data.summonerId) return { ok: false, error: 'Not logged in to the League client.' };
  const url = `/lol-item-sets/v1/item-sets/${me.data.summonerId}/sets`;
  const cur = await request('GET', url);
  if (cur.status !== 200 || !cur.data) return { ok: false, error: 'Could not read item sets.' };
  const itemSets = (cur.data.itemSets || []).filter(
    (s) => !(String(s.title || '').startsWith('RiftScout') && (s.associatedChampions || []).includes(championId)));
  itemSets.unshift({
    title: title.slice(0, 75),
    associatedChampions: [championId],
    associatedMaps: [11],
    blocks,
    map: 'any',
    mode: 'any',
    preferredItemSlots: [],
    sortrank: 0,
    startedFrom: 'blank',
    type: 'custom',
    uid: crypto.randomUUID(),
  });
  const put = await request('PUT', url, { ...cur.data, itemSets });
  return ok(put) ? { ok: true } : { ok: false, error: `Item set import failed (${put.status}).` };
}

async function setSpells(spell1Id, spell2Id) {
  const r = await request('PATCH', '/lol-champ-select/v1/session/my-selection', { spell1Id, spell2Id });
  return ok(r) ? { ok: true } : { ok: false, error: 'Could not set summoner spells.' };
}

// Wie is ingeteken, en op watter bediener (bv. "na1")
// LoginDataPacket gee die bediener-ID (NA1, EUW1, KR ...); region-locale is die rugsteun (NA, EUW, ...).
const REGION_TO_PLATFORM = {
  NA: 'na1', EUW: 'euw1', EUNE: 'eun1', KR: 'kr', BR: 'br1', LA1: 'la1', LAN: 'la1', LA2: 'la2', LAS: 'la2',
  OC1: 'oc1', OCE: 'oc1', TR: 'tr1', RU: 'ru', JP: 'jp1', ME1: 'me1', SG2: 'sg2', SEA: 'sg2', PH2: 'sg2', TH2: 'sg2', TW2: 'tw2', VN2: 'vn2',
};
function normPlatform(id) {
  const v = String(id || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'ph2' || v === 'th2') return 'sg2'; // SEA-bedieners is saamgevoeg
  return v;
}
async function identity() {
  const me = await request('GET', '/lol-summoner/v1/current-summoner');
  if (me.status !== 200 || !me.data || !me.data.puuid) return null;
  let platform = null;
  const plat = await request('GET', '/lol-platform-config/v1/namespaces/LoginDataPacket/platformId').catch(() => null);
  if (plat && plat.status === 200 && typeof plat.data === 'string') platform = normPlatform(plat.data);
  if (!platform) {
    const rl = await request('GET', '/riotclient/region-locale').catch(() => null);
    const r = rl && rl.status === 200 && rl.data ? String(rl.data.region || rl.data.webRegion || '').toUpperCase() : '';
    platform = REGION_TO_PLATFORM[r] || null;
  }
  return {
    puuid: me.data.puuid,
    riotId: me.data.gameName ? `${me.data.gameName}#${me.data.tagLine}` : null,
    platform,
    level: me.data.summonerLevel || null,
    profileIconId: me.data.profileIconId != null ? me.data.profileIconId : null,
  };
}

// ---------- Spelerdata uit die kliënt (geen Riot API-sleutel nodig nie) ----------
// Die kliënt kan net spelers op jou eie bediener opsoek.
const EMPTY_PUUID = '00000000-0000-0000-0000-000000000000';
const okPuuid = (p) => typeof p === 'string' && p.length > 20 && p !== EMPTY_PUUID;

async function get(p) {
  const r = await request('GET', p);
  if (r.status === 0) { const e = new Error('The League client is not open.'); e.status = 503; e.lcuClosed = true; throw e; }
  if (!ok(r)) { const e = new Error((r.data && r.data.message) || `League client error ${r.status}`); e.status = r.status === 404 ? 404 : 502; throw e; }
  return r.data;
}

async function lookupRiotId(gameName, tagLine) {
  const r = await request('POST', '/lol-summoner/v1/summoners/aliases', [{ gameName, tagLine }]);
  if (r.status === 0) { const e = new Error('The League client is not open.'); e.status = 503; e.lcuClosed = true; throw e; }
  let s = ok(r) && Array.isArray(r.data) ? r.data.find((x) => x && okPuuid(x.puuid)) : null;
  if (!s) {
    const g = await request('GET', `/lol-summoner/v1/summoners?name=${encodeURIComponent(`${gameName}#${tagLine}`)}`);
    if (ok(g) && g.data && okPuuid(g.data.puuid)) s = g.data;
  }
  return s || null;
}

const summonerByPuuid = (puuid) => get(`/lol-summoner/v2/summoners/puuid/${encodeURIComponent(puuid)}`);

// Rank in dieselfde vorm as Riot se league-v4 (queueType, tier, rank, leaguePoints, wins, losses)
async function ranked(puuid) {
  const d = await get(`/lol-ranked/v1/ranked-stats/${encodeURIComponent(puuid)}`);
  const map = (d && d.queueMap) || {};
  const list = Array.isArray(d && d.queues) ? d.queues : [];
  const out = [];
  for (const q of ['RANKED_SOLO_5x5', 'RANKED_FLEX_SR']) {
    const e = map[q] || list.find((x) => x && x.queueType === q);
    if (!e || !e.tier || e.tier === 'NONE' || e.tier === 'UNRANKED') continue;
    const apex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(e.tier);
    out.push({
      queueType: q, tier: e.tier, rank: apex || !e.division || e.division === 'NA' ? 'I' : e.division,
      leaguePoints: e.leaguePoints || 0, wins: e.wins || 0, losses: e.losses || 0, hotStreak: false,
    });
  }
  return out;
}

async function masteries(puuid) {
  const d = await get(`/lol-champion-mastery/v1/${encodeURIComponent(puuid)}/champion-mastery`);
  const list = Array.isArray(d) ? d : (d && Array.isArray(d.masteries) ? d.masteries : []);
  return list.map((m) => ({ championId: m.championId, level: m.championLevel || 0, points: m.championPoints || 0 }))
    .sort((a, b) => b.points - a.points);
}

async function matchList(puuid, begIndex, endIndex) {
  const d = await get(`/lol-match-history/v1/products/lol/${encodeURIComponent(puuid)}/matches?begIndex=${begIndex}&endIndex=${endIndex}`);
  return (d && d.games && Array.isArray(d.games.games)) ? d.games.games : [];
}

const game = (gameId) => get(`/lol-match-history/v1/games/${Number(gameId)}`);

// Wie is in jou huidige spel (vanaf die laaiskerm)
async function gameSession() {
  const r = await request('GET', '/lol-gameflow/v1/session');
  if (!ok(r) || !r.data || !r.data.gameData) return null;
  const gd = r.data.gameData;
  const picks = {};
  const spells = {};
  for (const p of gd.playerChampionSelections || []) {
    if (!okPuuid(p.puuid)) continue;
    picks[p.puuid] = p.championId;
    if (p.spell1Id || p.spell2Id) spells[p.puuid] = [p.spell1Id || 0, p.spell2Id || 0];
  }
  const team = (list, teamId) => (list || []).filter((m) => okPuuid(m.puuid)).map((m) => ({
    puuid: m.puuid,
    championId: m.championId || picks[m.puuid] || 0,
    teamId,
    position: POSITIONS[String(m.selectedPosition || '').toLowerCase()] || '',
    spells: spells[m.puuid] || null,
  }));
  return {
    gameId: gd.gameId || null,
    queueId: gd.queue ? gd.queue.id : null,
    mapId: r.data.map ? r.data.map.id : null,
    isCustom: !!gd.isCustomGame,
    players: [...team(gd.teamOne, 100), ...team(gd.teamTwo, 200)],
  };
}

module.exports = {
  state, importRunes, importItemSet, setSpells, identity,
  lookupRiotId, summonerByPuuid, ranked, masteries, matchList, game, gameSession, okPuuid,
};
