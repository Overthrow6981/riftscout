// RiftScout - League of Legends companion app
// Backend: hou die Riot API-sleutel geheim, cache wedstryde, respekteer rate limits,
// versamel build-data, praat met die League-kliënt (champ select) en lees die Live Client Data API.

// Loop as desktop-app (main.js roep startServer) of los: `node server.js`.

try { require('dotenv').config({ path: require('path').join(__dirname, '.env') }); } catch { /* opsioneel */ }
const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const builds = require('./builds');
const lcu = require('./lcu');

const HOST_TEMPLATE = process.env.RIOT_HOST_TEMPLATE || 'https://{route}.api.riotgames.com';
const LIVE_URL = process.env.LIVE_CLIENT_URL || 'https://127.0.0.1:2999/liveclientdata/allgamedata';
const DDRAGON = process.env.DDRAGON_BASE || 'https://ddragon.leagueoflegends.com';
const REMOTE_BUILDS_URL = process.env.REMOTE_BUILDS_URL || 'https://github.com/Overthrow6981/riftscout/releases/download/build-data/builds.json';
const CRAWL_PACE_MS = process.env.CRAWL_PACE_MS != null ? Number(process.env.CRAWL_PACE_MS) : 1700;
const APP_VERSION = require('./package.json').version;
const MIN_GAMES = 10;

// Word in startServer() gestel: waar instellings en cache gestoor word
let DATA_DIR = __dirname;
let CACHE_DIR = path.join(__dirname, 'cache', 'matches');
let CONFIG_FILE = path.join(__dirname, 'config.json');
let API_KEY = (process.env.RIOT_API_KEY || '').trim();
let CONFIG = null;

function loadConfig() {
  if (!CONFIG) {
    try { CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { CONFIG = {}; }
  }
  return CONFIG;
}
function saveConfig(cfg) {
  CONFIG = cfg;
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

const DEFAULT_PREFS = {
  collectBuilds: true,      // versamel build-data in die agtergrond
  crawlRegion: '',          // leeg = streek van jou laaste soektog
  autoImport: true,         // sit runes en items outomaties in sodra jy 'n champion kies
  autoSpells: true,         // sit ook summoner spells outomaties (net op Summoner's Rift)
  replacePages: true,       // as al die rune pages vol is: vervang die huidige een (soos Blitz)
  openOnChampSelect: true,  // bring RiftScout na vore sodra champ select begin
  overlay: true,            // wys die oorleg in die spel
  overlayPosition: 'right', // right | left | top-right
};
function getPrefs() { return { ...DEFAULT_PREFS, ...(loadConfig().prefs || {}) }; }

// ---------- Streke ----------
// platform (vir summoner/league/mastery) -> regional route (vir match-v5)
const PLATFORMS = builds.PLATFORM_ROUTE;
const matchRoute = (platform) => PLATFORMS[platform];
// account-v1 ondersteun net americas/europe/asia
const accountRoute = (platform) => (PLATFORMS[platform] === 'sea' ? 'asia' : PLATFORMS[platform]);

// ---------- Hulpfunksies ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------- Rate limiter (sliding windows) ----------
const WINDOWS = [
  { limit: Number(process.env.RATE_PER_SECOND) || 20, ms: 1000 },
  { limit: Number(process.env.RATE_PER_2MIN) || 100, ms: 120000 },
];
const stamps = [];
let queue = Promise.resolve();
function takeSlot() {
  const slot = queue.then(async () => {
    for (;;) {
      const now = Date.now();
      while (stamps.length && now - stamps[0] >= 120000) stamps.shift();
      let wait = 0;
      for (const w of WINDOWS) {
        const recent = stamps.filter((t) => now - t < w.ms);
        if (recent.length >= w.limit) wait = Math.max(wait, w.ms - (now - recent[0]) + 10);
      }
      if (!wait) { stamps.push(now); return; }
      await sleep(wait);
    }
  });
  queue = slot.catch(() => {});
  return slot;
}

// ---------- Riot API ----------
async function riot(route, apiPath, attempt = 0) {
  if (!API_KEY) throw httpError(400, 'No Riot API key yet. Click Settings (top right) and paste your key from developer.riotgames.com.');
  await takeSlot();
  const url = HOST_TEMPLATE.replace('{route}', route) + apiPath;
  let res;
  try {
    res = await fetch(url, { headers: { 'X-Riot-Token': API_KEY } });
  } catch (err) {
    throw httpError(502, 'Could not reach the Riot API: ' + err.message);
  }
  if (res.status === 429 && attempt < 3) {
    const retry = Number(res.headers.get('retry-after')) || 2;
    await sleep(retry * 1000);
    return riot(route, apiPath, attempt + 1);
  }
  if (!res.ok) {
    const messages = {
      400: 'Bad request to the Riot API.',
      401: 'API key missing or invalid. Development keys expire every 24 hours - paste a new one under Settings.',
      403: 'API key rejected (expired or wrong). Development keys expire every 24 hours - paste a new one under Settings.',
      404: 'Not found. Check the Riot ID (Name#TAG) and the region.',
      429: 'Rate limit reached. Wait a minute and try again.',
    };
    throw httpError(res.status, messages[res.status] || `Riot API error (${res.status}).`);
  }
  return res.json();
}

// Die versamelaar gebruik net wat oor is: hou altyd 'n reserwe vir die speler se eie soektogte
const USER_RESERVE = Number(process.env.USER_RESERVE) || 40;
async function riotBackground(route, apiPath) {
  for (;;) {
    const now = Date.now();
    const used = stamps.filter((t) => now - t < 120000).length;
    if (used < WINDOWS[1].limit - USER_RESERVE) break;
    await sleep(2000);
  }
  return riot(route, apiPath);
}

// Kort geheue-cache vir dinge wat verander (profiel, rank)
const memCache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = memCache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  memCache.set(key, { t: Date.now(), v });
  return v;
}

// Wedstryde verander nooit nie -> stoor permanent op skyf
async function getMatch(route, matchId) {
  const safeId = matchId.replace(/[^A-Za-z0-9_]/g, '');
  const file = path.join(CACHE_DIR, safeId + '.json');
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* lees weer van API */ }
  }
  const data = await riot(route, `/lol/match/v5/matches/${encodeURIComponent(matchId)}`);
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}

function simplifyParticipant(p, teamKills) {
  const styles = (p.perks && p.perks.styles) || [];
  return {
    puuid: p.puuid,
    championId: p.championId,
    placement: p.placement || 0,           // Arena: 1-8
    subteam: p.playerSubteamId || 0,       // Arena: span-nommer
    name: p.riotIdGameName || p.summonerName || 'Unknown',
    tag: p.riotIdTagline || '',
    teamId: p.teamId,
    championName: p.championName,
    champLevel: p.champLevel,
    kills: p.kills, deaths: p.deaths, assists: p.assists,
    cs: (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0),
    gold: p.goldEarned,
    damage: p.totalDamageDealtToChampions,
    vision: p.visionScore,
    position: p.teamPosition || p.individualPosition || '',
    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6],
    spells: [p.summoner1Id, p.summoner2Id],
    keystone: styles[0] && styles[0].selections && styles[0].selections[0] ? styles[0].selections[0].perk : null,
    secondaryStyle: styles[1] ? styles[1].style : null,
    killParticipation: teamKills ? (p.kills + p.assists) / teamKills : 0,
    largestMultiKill: p.largestMultiKill || 0,
    win: !!p.win,
  };
}

function simplifyMatch(match, puuid) {
  const info = match.info;
  const teamKills = {};
  for (const p of info.participants) teamKills[p.teamId] = (teamKills[p.teamId] || 0) + p.kills;
  const players = info.participants.map((p) => simplifyParticipant(p, teamKills[p.teamId]));
  // gameDuration is sekondes vir moderne wedstryde (millisekondes vir baie oues)
  const duration = info.gameEndTimestamp ? info.gameDuration : Math.round(info.gameDuration / 1000);
  return {
    id: match.metadata.matchId,
    queueId: info.queueId,
    gameMode: info.gameMode,
    duration,
    endedAt: info.gameEndTimestamp || info.gameStartTimestamp + duration * 1000,
    remake: info.participants.some((p) => p.gameEndedInEarlySurrender),
    me: players.find((p) => p.puuid === puuid) || null,
    players,
  };
}

// ---------- Wedstryde uit die League-kliënt (sonder sleutel) ----------
const LANE_TO_POS = { TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MIDDLE', MID: 'MIDDLE' };
function lcuPosition(t) {
  const lane = String((t && t.lane) || '').toUpperCase();
  const role = String((t && t.role) || '').toUpperCase();
  if (LANE_TO_POS[lane]) return LANE_TO_POS[lane];
  if (lane === 'BOTTOM' || lane === 'BOT') return role.includes('SUPPORT') ? 'UTILITY' : 'BOTTOM';
  return '';
}

// Skakel die kliënt se wedstrydformaat om na dieselfde vorm as simplifyMatch
function simplifyLcuGame(g, puuid) {
  const who = {};
  for (const pi of g.participantIdentities || []) who[pi.participantId] = pi.player || {};
  const teamKills = {};
  for (const p of g.participants || []) teamKills[p.teamId] = (teamKills[p.teamId] || 0) + ((p.stats && p.stats.kills) || 0);
  const players = (g.participants || []).map((p) => {
    const st = p.stats || {};
    const pl = who[p.participantId] || {};
    const kills = st.kills || 0;
    const assists = st.assists || 0;
    return {
      puuid: pl.puuid || '',
      championId: p.championId,
      placement: st.subteamPlacement || 0,
      subteam: st.playerSubteamId || 0,
      name: pl.gameName || pl.summonerName || 'Unknown',
      tag: pl.tagLine || '',
      teamId: p.teamId,
      championName: '',
      champLevel: st.champLevel || 0,
      kills, deaths: st.deaths || 0, assists,
      cs: (st.totalMinionsKilled || 0) + (st.neutralMinionsKilled || 0),
      gold: st.goldEarned || 0,
      damage: st.totalDamageDealtToChampions || 0,
      vision: st.visionScore || 0,
      position: lcuPosition(p.timeline),
      items: [st.item0, st.item1, st.item2, st.item3, st.item4, st.item5, st.item6].map((x) => x || 0),
      spells: [p.spell1Id, p.spell2Id],
      keystone: st.perk0 || null,
      secondaryStyle: st.perkSubStyle || null,
      killParticipation: teamKills[p.teamId] ? (kills + assists) / teamKills[p.teamId] : 0,
      largestMultiKill: st.largestMultiKill || 0,
      win: !!st.win,
    };
  });
  const duration = g.gameDuration > 20000 ? Math.round(g.gameDuration / 1000) : (g.gameDuration || 0);
  return {
    id: `${g.platformId || 'LCU'}_${g.gameId}`,
    queueId: g.queueId,
    gameMode: g.gameMode,
    duration,
    endedAt: (g.gameCreation || 0) + duration * 1000,
    remake: (g.participants || []).some((p) => p.stats && p.stats.gameEndedInEarlySurrender),
    me: players.find((p) => p.puuid === puuid) || null,
    players,
  };
}

// Volledige wedstryd uit die kliënt; verander nooit nie -> stoor op skyf
async function getClientGame(gameId) {
  const file = path.join(CACHE_DIR, `LCU_${Number(gameId)}.json`);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* lees weer */ }
  }
  const g = await lcu.game(gameId);
  if (g && (g.participants || []).length > 1) fs.writeFileSync(file, JSON.stringify(g));
  return g;
}

// Die kliënt se puuid's is gewone UUID's; Riot se API gee lang versleutelde ID's
const isClientPuuid = (p) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p);
const REGION_NAMES = { na1: 'NA', euw1: 'EUW', eun1: 'EUNE', kr: 'KR', br1: 'BR', la1: 'LAN', la2: 'LAS', oc1: 'OCE', tr1: 'TR', ru: 'RU', jp1: 'JP', me1: 'ME', sg2: 'SEA', tw2: 'TW', vn2: 'VN' };

// Sonder sleutel: die League-kliënt moet oop wees, en net spelers op jou eie bediener
async function requireClient(region) {
  const m = await whoAmI();
  if (!m.connected) throw httpError(409, 'Open the League client to look up players – no API key needed. (Or add an optional Riot API key in Settings.)');
  if (region && m.region && region !== m.region) {
    throw httpError(400, `Without a Riot API key RiftScout can look up players on your own server (${REGION_NAMES[m.region] || m.region}) only. Add an optional key in Settings to search other servers.`);
  }
  return m;
}

// ---------- Live Client Data API ----------
function getLiveData() {
  return new Promise((resolve) => {
    const req = https.get(LIVE_URL, { rejectUnauthorized: false, timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ inGame: false, loading: res.statusCode === 404 });
        try { resolve({ inGame: true, data: JSON.parse(body) }); } catch { resolve({ inGame: false }); }
      });
    });
    req.on('timeout', () => { req.destroy(); });
    req.on('error', () => resolve({ inGame: false }));
  });
}

// ---------- Data Dragon (statiese data: weergawe, spells, runes, champions, items) ----------
let DD = null;        // laaste suksesvolle Data Dragon data
let itemCls = null;   // item-klassifiseerder vir build-data
async function getDDragon() {
  return cached('ddragon', 60 * 60 * 1000, async () => {
    const versions = await (await fetch(`${DDRAGON}/api/versions.json`)).json();
    const v = versions[0];
    const [spellsRaw, runesRaw, champsRaw, itemsRaw] = await Promise.all([
      fetch(`${DDRAGON}/cdn/${v}/data/en_US/summoner.json`).then((r) => r.json()),
      fetch(`${DDRAGON}/cdn/${v}/data/en_US/runesReforged.json`).then((r) => r.json()),
      fetch(`${DDRAGON}/cdn/${v}/data/en_US/champion.json`).then((r) => r.json()),
      fetch(`${DDRAGON}/cdn/${v}/data/en_US/item.json`).then((r) => r.json()),
    ]);
    const spells = {};
    for (const s of Object.values(spellsRaw.data)) spells[s.key] = { name: s.name, image: s.image.full };
    const runes = {};
    const trees = []; // volle rune-bome (vir die Blitz-agtige rune-bladsy met alle opsies)
    for (const style of runesRaw) {
      runes[style.id] = { name: style.name, icon: style.icon };
      for (const slot of style.slots) for (const r of slot.runes) runes[r.id] = { name: r.name, icon: r.icon };
      trees.push({ id: style.id, name: style.name, icon: style.icon, slots: style.slots.map((sl) => sl.runes.map((r) => r.id)) });
    }
    const champions = {};
    for (const c of Object.values(champsRaw.data)) champions[c.key] = { id: c.id, name: c.name, tags: c.tags || [] };
    const full = builds.itemsFromDDragon(itemsRaw);
    const items = {};
    for (const [id, it] of Object.entries(full)) items[id] = { name: it.name, gold: it.gold };
    itemCls = builds.itemClassifier(full);
    DD = { version: v, spells, runes, trees, champions, items };
    return DD;
  });
}

// ---------- Build-data ----------
let db = null;
let seen = null;
let crawler = null;
let remoteInfo = { matches: 0, updated: 0, regions: [] };
let lastUserActivity = 0;

// Streek vir build-data: jou keuse in Settings, anders jou eie bediener (uit League), anders jou laaste soektog
function crawlRegion() {
  const p = getPrefs();
  if (PLATFORMS[p.crawlRegion]) return p.crawlRegion;
  const cfg = loadConfig();
  if (cfg.me && PLATFORMS[cfg.me.region]) return cfg.me.region;
  return PLATFORMS[cfg.lastRegion] ? cfg.lastRegion : 'na1';
}

function updateCrawler() {
  if (!crawler) return;
  if (getPrefs().collectBuilds && API_KEY) crawler.start();
  else if (crawler.running) crawler.stop();
}

async function loadRemoteBuilds() {
  const file = path.join(DATA_DIR, 'remote-builds.json');
  const use = (d) => {
    if (d && d.patches) {
      db.remote = d;
      remoteInfo = { matches: d.matches || 0, updated: d.updated || 0, regions: Object.keys(d.regions || {}).sort((a, b) => d.regions[b] - d.regions[a]) };
      return true;
    }
    return false;
  };
  if (!db.remote) { try { use(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* nog niks gestoor nie */ } }
  try {
    const text = await fetchRemoteBuilds();
    if (text && use(JSON.parse(text))) fs.writeFileSync(file, text);
  } catch { /* geen gedeelde data beskikbaar nie */ }
}

// Gedeelde data: eers die saamgepakte weergawe (baie kleiner aflaai), anders die gewone JSON
async function fetchRemoteBuilds() {
  try {
    const r = await fetch(REMOTE_BUILDS_URL + '.gz', { signal: AbortSignal.timeout(120000) });
    if (r.ok) return zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8');
  } catch { /* probeer die gewone lêer */ }
  const r = await fetch(REMOTE_BUILDS_URL, { signal: AbortSignal.timeout(120000) });
  return r.ok ? r.text() : null;
}

function buildFor(championId, role, strict, vs) {
  const roles = db.rolesFor(championId);
  let use = role;
  if (!strict || !use) {
    const wanted = roles.find((r) => r.role === role && r.games >= MIN_GAMES);
    use = wanted ? role : (roles[0] ? roles[0].role : role);
  }
  const { stats, patches } = db.statsFor(championId, use);
  const all = use ? builds.matchups(stats, 1) : [];
  const solid = all.filter((m) => m.games >= 5);
  const rec = use ? builds.recommend(stats, vs || null) : null;
  if (rec && vs) {
    // Dieselfde syfers as die counter-lys in champ select (alle gestoorde patches)
    const m = db.statsFor(championId, use, builds.KEEP_PATCHES).stats.vs[vs];
    if (m) rec.vs = { championId: Number(vs), games: m.games, wins: m.wins, lane: m.lane || null };
  }
  return {
    championId, role: use || '', roles, patches, minGames: MIN_GAMES, matchupMin: builds.MATCHUP_MIN,
    rec,
    opponents: all.sort((a, b) => b.games - a.games).map(({ championId: id, games }) => ({ championId: id, games })),
    strongAgainst: solid.filter((m) => m.wr >= 0.5).sort((a, b) => b.wr - a.wr || b.games - a.games).slice(0, 6),
    weakAgainst: solid.filter((m) => m.wr < 0.5).sort((a, b) => a.wr - b.wr || b.games - a.games).slice(0, 6),
  };
}

// Counter-picks teen 'n vyand in 'n rol: game- en lane-wenkoers van elke champion teen hom.
// As daar nog te min matchup-games is, ook die sterkste champions in die rol oor die algemeen.
const COUNTER_MIN = 3;
function countersFor(enemyId, role) {
  const roles = db.rolesFor(enemyId);
  const use = role || (roles[0] ? roles[0].role : '') || (riotPositions.map[enemyId] || [])[0] || '';
  if (!use) return { enemyId, role: '', counters: [], best: [] };
  const enemy = db.statsFor(enemyId, use, builds.KEEP_PATCHES).stats;
  const counters = builds.counterPicks(enemy, COUNTER_MIN, 20);
  const best = counters.length >= 5 ? [] : builds.bestInRole(db.roleTable(use, builds.KEEP_PATCHES), 20, 10,
    [enemyId, ...counters.map((c) => c.championId)]);
  return { enemyId, role: use, enemyGames: enemy.games, minGames: COUNTER_MIN, counters, best };
}

// Riot se eie lys van watter posisies elke champion speel (uit die League-kliënt) – werk sonder build-data
let riotPositions = { at: 0, map: {} };
async function refreshRiotPositions() {
  if (Date.now() - riotPositions.at < 6 * 3600e3 && Object.keys(riotPositions.map).length) return;
  const m = await lcu.recommendedPositions().catch(() => null);
  riotPositions = { at: Date.now(), map: m && Object.keys(m).length ? m : riotPositions.map };
}

// Hoe waarskynlik speel 'n champion elke rol: ons eie data as daar genoeg is, anders Riot se posisies, anders sy tipe
const TAG_PRIOR = {
  Marksman: { BOTTOM: 6 }, Support: { UTILITY: 6 }, Mage: { MIDDLE: 3, UTILITY: 1 },
  Assassin: { MIDDLE: 3, JUNGLE: 1 }, Fighter: { TOP: 3, JUNGLE: 1 }, Tank: { TOP: 2, UTILITY: 1, JUNGLE: 1 },
};
function rolePrior(championId) {
  const data = Object.fromEntries(db.rolesFor(championId).map((r) => [r.role, r.games]));
  if (Object.values(data).reduce((x, y) => x + y, 0) >= 20) return data;
  const rp = riotPositions.map[championId];
  if (rp && rp.length) {
    const m = {};
    rp.forEach((r, i) => { m[r] = (m[r] || 0) + ([6, 3, 1][i] || 1); });
    return m;
  }
  const m = {};
  const tags = (DD && DD.champions[championId] && DD.champions[championId].tags) || [];
  for (const t of tags) for (const [r, w] of Object.entries(TAG_PRIOR[t] || {})) m[r] = (m[r] || 0) + w;
  return m;
}

// Raai die vyand se rolle; gee ook die een in my lane (net as ons redelik seker is)
function enemyRoles(enemyIds) {
  if (!enemyIds.length) return {};
  return builds.guessRoles(enemyIds.map((id) => ({ championId: id, roles: rolePrior(id) })));
}
function enemyLaner(enemyIds, myRole, assign) {
  if (!myRole || !enemyIds.length) return null;
  const hit = Object.entries(assign || enemyRoles(enemyIds)).find(([, r]) => r === myRole);
  if (!hit) return null;
  const id = Number(hit[0]);
  const rg = rolePrior(id);
  const total = Object.values(rg).reduce((x, y) => x + y, 0);
  const share = total ? (rg[myRole] || 0) / total : 0;
  return enemyIds.length >= 5 || share >= 0.5 ? id : null;
}

const ROLE_NAMES = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support' };
const pctText = (e) => (e && e.n ? `${Math.round((e.w / e.n) * 100)}% win` : '');

function itemBlocks(rec) {
  const blk = (type, ids) => {
    const counts = new Map();
    for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
    return { type, items: [...counts].map(([id, count]) => ({ id: String(id), count })) };
  };
  const blocks = [];
  if (rec.start[0]) blocks.push(blk(`Starting items · ${pctText(rec.start[0])}`, rec.start[0].ids));
  if (rec.boots.length) blocks.push(blk('Boots', rec.boots.slice(0, 2).map((e) => e.id)));
  if (rec.core[0]) blocks.push(blk(`Core build · ${pctText(rec.core[0])}`, rec.core[0].ids));
  ['item4', 'item5', 'item6'].forEach((k, i) => {
    if (rec[k].length) blocks.push(blk(`${i + 4}th item options`, rec[k].map((e) => e.id)));
  });
  if (rec.items.length) blocks.push(blk('Popular items', rec.items.slice(0, 8).map((e) => e.id)));
  blocks.push(blk('Consumables', [2003, 2055]));
  return blocks;
}

// Hou spells in die slot waar die speler dit nou het (bv. Flash op D of F); anders Flash op F
function orderSpells(ids, cs) {
  let [a, b] = ids;
  if (cs && (cs.spell2Id === a || cs.spell1Id === b)) [a, b] = [b, a];
  else if (!cs || (cs.spell1Id !== a && cs.spell2Id !== b)) { if (a === 4) [a, b] = [b, a]; }
  return [a, b];
}

async function doImport(championId, role, what, cs, vs) {
  await getDDragon().catch(() => {});
  const b = buildFor(championId, role, false, vs);
  const rec = b.rec;
  const champ = (DD && DD.champions[championId]) || { name: 'Champion' };
  if (!rec || rec.games < MIN_GAMES) {
    // Nog nie genoeg eie data nie: gebruik Riot se aanbevole runes en spells uit die kliënt (dadelik beskikbaar)
    const pos = role || (riotPositions.map[championId] || [])[0] || '';
    const page = await lcu.recommendedPage(championId, pos).catch(() => null);
    if (!page) return { ok: false, retry: true, championId, error: `No runes for ${champ.name} yet – is the League client open?` };
    const results = {};
    if (what.has('runes')) results.runes = await lcu.importRunes(page, `RiftScout ${champ.name}`, getPrefs().replacePages);
    if (what.has('spells') && page.spells.length === 2) results.spells = await lcu.setSpells(...orderSpells(page.spells, cs));
    return {
      ok: Object.values(results).every((r) => r.ok), championId, champion: champ.name, role: pos,
      vs: vs || null, vsName: '', matchupSpecific: false, source: 'riot', results, at: Date.now(),
    };
  }
  const results = {};
  const replace = getPrefs().replacePages;
  if (what.has('runes') && rec.runes[0]) results.runes = await lcu.importRunes(rec.runes[0].page, `RiftScout ${champ.name}`, replace);
  const vsName = rec.vs && DD && DD.champions[rec.vs.championId] ? DD.champions[rec.vs.championId].name : '';
  const setTitle = `RiftScout ${champ.name} ${ROLE_NAMES[b.role] || ''}${vsName && rec.fromMatchup.length ? ` vs ${vsName}` : ''}`.trim();
  if (what.has('items')) results.items = await lcu.importItemSet(championId, setTitle, itemBlocks(rec));
  if (what.has('spells') && rec.spells[0]) results.spells = await lcu.setSpells(...orderSpells(rec.spells[0].ids, cs));
  return {
    ok: Object.values(results).every((r) => r.ok), championId, champion: champ.name, role: b.role,
    vs: vs || null, vsName, matchupSpecific: rec.fromMatchup.length > 0, results, at: Date.now(),
  };
}

// ---------- League-kliënt: champ select dophou en outomaties invoer ----------
let lcuState = { connected: false, phase: null, champSelect: null };
let vsOverride = null; // lane-teenstander wat die speler self gekies het (as ons raaiskoot verkeerd is)
let lastImport = null;
let lastAutoKey = '';
let lastSpellKey = '';
let hoverSince = { key: '', at: 0 };
let prevPhase = null;
const champSelectListeners = [];
function onChampSelectStart(fn) { champSelectListeners.push(fn); }
let lcuBusy = false;
async function lcuTick() {
  if (lcuBusy) return;
  lcuBusy = true;
  try {
    const st = await lcu.state();
    if (st.connected) await refreshRiotPositions();
    if (st.champSelect) {
      const cs = st.champSelect;
      cs.enemyRoles = enemyRoles(cs.enemies || []);
      cs.vsAuto = enemyLaner(cs.enemies || [], cs.role, cs.enemyRoles);
      cs.vsManual = !!vsOverride && (cs.enemies || []).includes(vsOverride);
      cs.vs = cs.vsManual ? vsOverride : cs.vsAuto;
    }
    lcuState = st;
    if (st.phase === 'ChampSelect' && prevPhase !== 'ChampSelect') {
      lastImport = null; // nuwe champ select: ou invoer-boodskap weg
      for (const fn of champSelectListeners) { try { fn(); } catch { /* nie ons probleem nie */ } }
    }
    prevPhase = st.phase;
    // Hou "is League oop?" dadelik op datum (en tel jou rekening en bediener op sodra League oopmaak)
    if (!!st.connected !== !!me.connected) me.at = 0;
    if (st.connected || me.at === 0) whoAmI().catch(() => {});
    if ((API_KEY || st.connected) && ['ChampSelect', 'GameStart', 'InProgress'].includes(st.phase)) getLobby().catch(() => {});
    if (lcuState.phase !== 'ChampSelect') { lastAutoKey = ''; lastSpellKey = ''; vsOverride = null; return; }
    const cs = lcuState.champSelect;
    const prefs = getPrefs();
    if (!cs || !cs.championId || !prefs.autoImport) return;
    // Sodra jy 'n champion kies (hover of lock) en 'n oomblik daarop bly: alles dadelik invoer
    const champKey = `${cs.championId}:${cs.role}`;
    if (hoverSince.key !== champKey) hoverSince = { key: champKey, at: Date.now() };
    if (!cs.locked && Date.now() - hoverSince.at < 1500) return;
    // Sleutel sluit die teenstander in: as die vyand later kies, word die matchup-build ingevoer
    const key = `${champKey}:${cs.vs || ''}`;
    if (key === lastAutoKey) return;
    const what = new Set(['runes', 'items']);
    // Spells een keer per champion (nie weer as net die teenstander verander nie), en net met lanes (nie ARAM nie)
    if (prefs.autoSpells && cs.role && lastSpellKey !== champKey) what.add('spells');
    const result = await doImport(cs.championId, cs.role, what, cs, cs.vs);
    lastImport = { ...result, auto: true };
    if (!result.retry) { // nog te min data: probeer weer sodra daar meer is
      lastAutoKey = key;
      if (what.has('spells')) lastSpellKey = champKey;
    }
  } catch { /* volgende keer weer */ } finally {
    lcuBusy = false;
  }
}

// ---------- Lobby-scouting ----------
// Champ select: spanmaats (as Riot hul name wys). Van die laaiskerm af: al 10 spelers via spectator-v5.
let lobby = { key: '', data: null };
let lobbyPromise = null;
let me = { connected: false, puuid: null, riotId: null, region: null, level: null, profileIconId: null, at: 0 };

// Jou rekening en bediener kom uit die League-kliënt; die laaste een word onthou vir wanneer League toe is
async function whoAmI() {
  if (Date.now() - me.at < (me.connected ? 30e3 : 5e3)) return me;
  const id = await lcu.identity().catch(() => null);
  const cfg = loadConfig();
  if (id) {
    const region = PLATFORMS[id.platform] ? id.platform : null;
    me = { connected: true, puuid: id.puuid, riotId: id.riotId, region, level: id.level, profileIconId: id.profileIconId, at: Date.now() };
    const saved = cfg.me || {};
    if (saved.puuid !== me.puuid || saved.riotId !== me.riotId || saved.region !== region || saved.profileIconId !== me.profileIconId) {
      cfg.me = { puuid: me.puuid, riotId: me.riotId, region, level: me.level, profileIconId: me.profileIconId };
      saveConfig(cfg);
    }
  } else {
    const saved = cfg.me || {};
    me = { connected: false, puuid: saved.puuid || null, riotId: saved.riotId || null, region: saved.region || null,
      level: saved.level || null, profileIconId: saved.profileIconId != null ? saved.profileIconId : null, at: Date.now() };
  }
  return me;
}

// Rolle vir lobby-scouting. Smite (11) beteken jungle; iemand sonder Smite is nie die jungler nie.
function roleMapOf(championId, spells) {
  const known = Array.isArray(spells) && spells.some(Boolean);
  if (known && spells.includes(11)) return { JUNGLE: 1 };
  const m = { ...rolePrior(championId) };
  if (known) delete m.JUNGLE;
  return m;
}
const liveSpells = (lp) => {
  const ss = (lp && lp.summonerSpells) || {};
  const names = [ss.summonerSpellOne, ss.summonerSpellTwo].map((x) => String((x && (x.rawDisplayName || x.displayName)) || ''));
  return names.some(Boolean) ? names.map((n) => (/smite/i.test(n) ? 11 : -1)) : null;
};

// Scouting gebruik die League-kliënt: geen sleutel nodig nie, en sy speler-ID's (puuid) pas by die kliënt se data.
// (Riot se API gebruik ander, versleutelde puuid's – die twee mag nie gemeng word nie.)
// Net as die kliënt toe is en jy 'n sleutel het, scout ons via Riot se API.
const pickQueue = (list, q) => {
  const e = (list || []).find((x) => x.queueType === q);
  return e ? { tier: e.tier, rank: e.rank, lp: e.leaguePoints, wins: e.wins, losses: e.losses, hotStreak: !!e.hotStreak } : null;
};

async function scoutPlayer(region, p, viaClient) {
  lastUserActivity = Date.now(); // die versamelaar wag terwyl ons scout
  const base = await cached(`scout:${viaClient ? 'client' : region}:${p.puuid}`, 10 * 60e3, async () => {
    if (viaClient) {
      const [rk, sm] = await Promise.allSettled([lcu.ranked(p.puuid), lcu.summonerByPuuid(p.puuid)]);
      if (rk.status === 'rejected' && rk.reason && rk.reason.lcuClosed) throw rk.reason;
      // Die kliënt gee nie ander spelers se verliese nie (altyd 0) – dan wys ons net wins, nie 'n win rate nie
      const list = (rk.status === 'fulfilled' ? rk.value : []).map((e) => (p.puuid !== me.puuid && !e.losses ? { ...e, losses: null } : e));
      const sum = sm.status === 'fulfilled' ? sm.value : null;
      return {
        solo: pickQueue(list, 'RANKED_SOLO_5x5'), flex: pickQueue(list, 'RANKED_FLEX_SR'),
        level: sum ? sum.summonerLevel : null,
        riotId: sum && sum.gameName ? `${sum.gameName}#${sum.tagLine}` : '',
      };
    }
    const [entries, summoner] = await Promise.allSettled([
      riot(region, `/lol/league/v4/entries/by-puuid/${p.puuid}`),
      riot(region, `/lol/summoner/v4/summoners/by-puuid/${p.puuid}`),
    ]);
    if (entries.status === 'rejected' && [401, 403].includes(entries.reason.status)) throw entries.reason;
    const list = entries.status === 'fulfilled' ? entries.value : [];
    return { solo: pickQueue(list, 'RANKED_SOLO_5x5'), flex: pickQueue(list, 'RANKED_FLEX_SR'), level: summoner.status === 'fulfilled' ? summoner.value.summonerLevel : null, riotId: '' };
  });
  let mastery = null;
  if (p.championId) {
    if (viaClient) {
      const list = await cached(`cmastery:${p.puuid}`, 10 * 60e3, () => lcu.masteries(p.puuid)).catch(() => null);
      // 'n Leë lys beteken eerder "nie beskikbaar nie" as "nog nooit iets gespeel nie"
      if (list && list.length) {
        const m = list.find((x) => x.championId === p.championId);
        mastery = m ? { level: m.level, points: m.points } : { level: 0, points: 0 };
      }
    } else {
      mastery = await cached(`mastery:${region}:${p.puuid}:${p.championId}`, 10 * 60e3, async () => {
        try {
          const m = await riot(region, `/lol/champion-mastery/v4/champion-masteries/by-puuid/${p.puuid}/by-champion/${p.championId}`);
          return { level: m.championLevel, points: m.championPoints };
        } catch (err) {
          if (err.status === 404) return { level: 0, points: 0 }; // nog nooit gespeel nie
          throw err;
        }
      }).catch(() => null);
    }
  }
  const r = base.solo || base.flex;
  const lossesKnown = !!r && r.losses != null;
  const games = r && lossesKnown ? r.wins + r.losses : 0;
  const wr = games ? r.wins / games : 0;
  const tags = [];
  if (r && r.hotStreak) tags.push('Hot streak');
  if (mastery && mastery.points === 0) tags.push('First time on champ');
  else if (mastery && mastery.points < 10000) tags.push('New on champ');
  else if (mastery && mastery.points >= 300000) tags.push('One-trick');
  if (lossesKnown && base.level != null && base.level < 60 && games >= 15 && wr >= 0.65) tags.push('Possible smurf');
  return { ...p, riotId: p.riotId || base.riotId || '', level: base.level, solo: base.solo, flex: base.flex, mastery, tags };
}

function championIdFromLive(p, dd) {
  const raw = String((p && p.rawChampionName) || '');
  const ddId = raw.startsWith('game_character_displayname_') ? raw.slice(27) : '';
  if (dd) for (const [key, c] of Object.entries(dd.champions)) if (c.id === ddId) return Number(key);
  return 0;
}

const IN_GAME_PHASES = ['GameStart', 'InProgress', 'Reconnect'];

async function computeLobby() {
  const phase = lcuState.phase;
  const viaClient = !!lcuState.connected;
  if (!viaClient && !API_KEY) return { phase, teams: [], error: 'Open the League client – RiftScout scouts the players in your games from there.' };
  const id = await whoAmI();
  const region = id.region || crawlRegion();

  // --- Champ select: my span ---
  if (phase === 'ChampSelect' && lcuState.champSelect) {
    const allies = lcuState.champSelect.allies || [];
    const csEnemies = lcuState.champSelect.enemies || [];
    const key = 'cs:' + allies.map((a) => `${a.puuid}:${a.championId}`).join(',') + '|' + csEnemies.join(',') + '|' + (lcuState.champSelect.vs || '');
    if (lobby.key === key && lobby.data) return lobby.data;
    const players = await Promise.all(allies.map((a) => (a.puuid
      ? scoutPlayer(region, { puuid: a.puuid, riotId: a.gameName ? `${a.gameName}#${a.tagLine}` : '', championId: a.championId, teamId: 100, role: a.role, me: a.me }, true)
      : { hidden: true, championId: a.championId, teamId: 100, role: a.role, me: a.me, tags: [] })));
    // Vyande: Riot wys in champ select net hul champions (nie name nie)
    const er = lcuState.champSelect.enemyRoles || {};
    const enemyPlayers = csEnemies.map((championId) => ({ enemyPick: true, championId, teamId: 200, role: er[championId] || '', opp: championId === lcuState.champSelect.vs, tags: [] }));
    const teams = [{ teamId: 100, mine: true, players }];
    teams.push({ teamId: 200, mine: false, players: enemyPlayers });
    const data = { phase: 'ChampSelect', region, myTeamId: 100, teams, hiddenNames: allies.some((a) => !a.puuid && !a.me), at: Date.now() };
    lobby = { key, data };
    return data;
  }

  // --- In die spel (vanaf die laaiskerm) ---
  const live = await getLiveData();
  if (!IN_GAME_PHASES.includes(phase) && !live.inGame) {
    // Nie in 'n spel nie: wys die laaste lobby (bv. ná die spel) as dit daar is
    return lobby.data && lobby.data.phase === 'InGame' ? { ...lobby.data, phase, stale: true } : { phase, teams: [] };
  }
  const dd = await getDDragon().catch(() => DD);
  let session = null;
  let participants = [];
  if (viaClient) {
    session = await lcu.gameSession().catch(() => null);
    if (session) participants = session.players.map((p) => ({ puuid: p.puuid, riotId: '', championId: p.championId, teamId: p.teamId, position: p.position, spells: p.spells }));
  }
  // Die spel se eie spelerlys vul aan wat ontbreek (bv. custom games, of as die kliënt iemand nie gee nie)
  if (live.inGame) {
    for (const lp of live.data.allPlayers || []) {
      if (lp.isBot) continue;
      const teamId = lp.team === 'CHAOS' ? 200 : 100;
      const championId = championIdFromLive(lp, dd);
      const known = participants.find((p) => p.teamId === teamId && p.championId === championId && championId);
      if (known) { if (!known.spells) known.spells = liveSpells(lp); continue; }
      const riotId = lp.riotId || (lp.riotIdGameName ? `${lp.riotIdGameName}#${lp.riotIdTagLine}` : '');
      const hash = riotId.lastIndexOf('#');
      const livePosition = builds.ROLES.includes(lp.position) ? lp.position : '';
      if (hash < 1) {
        // Naam versteek (bv. streamer mode): wys die speler sonder scouting
        participants.push({ hidden: true, puuid: '', riotId: '', championId, teamId, position: livePosition, spells: liveSpells(lp) });
        continue;
      }
      const gameName = riotId.slice(0, hash);
      const tagLine = riotId.slice(hash + 1);
      try {
        const puuid = await cached(`puuidOf:${viaClient ? 'client' : region}:${riotId.toLowerCase()}`, 60 * 60e3, async () => {
          if (viaClient) { const s = await lcu.lookupRiotId(gameName, tagLine); return s ? s.puuid : null; }
          const acc = await riot(accountRoute(region), `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
          return acc.puuid;
        });
        if (puuid && !participants.some((p) => p.puuid === puuid)) participants.push({ puuid, riotId, championId, teamId, position: livePosition, spells: liveSpells(lp) });
      } catch { /* speler nie gevind nie */ }
    }
  }
  if (!participants.length) return { phase, teams: [], waiting: true };
  const key = `game:${session && session.gameId ? session.gameId : ''}:` + participants.map((p) => p.puuid || `h${p.teamId}:${p.championId}`).sort().join(',');
  if (lobby.key === key && lobby.data) return lobby.data;

  const liveMe = live.inGame && live.data.activePlayer ? String(live.data.activePlayer.riotId || '').toLowerCase() : '';
  const players = await Promise.all(participants.map((p) => (p.hidden ? { ...p, me: false, tags: [] } : scoutPlayer(region, {
    ...p, me: (viaClient && !!id.puuid && p.puuid === id.puuid) || (!!liveMe && !!p.riotId && p.riotId.toLowerCase() === liveMe),
  }, viaClient))));
  // Rolle: wat die spel self sê, anders geraai uit wat elke champion gewoonlik speel
  const livePos = {};
  if (live.inGame) for (const p of live.data.allPlayers || []) if (p.position) livePos[championIdFromLive(p, dd)] = p.position;
  const teamIds = [...new Set(players.map((p) => p.teamId))].sort((a, b) => a - b);
  // Rolle maak net sin op Summoner's Rift met spanne van 5 (nie ARAM/Arena nie)
  const mode = live.inGame && live.data.gameData ? String(live.data.gameData.gameMode || '') : '';
  const laned = !['ARAM', 'CHERRY'].includes(mode)
    && !(session && ([450, 1700, 1710, 2400].includes(session.queueId) || session.mapId === 12 || session.mapId === 30));
  for (const teamId of teamIds) {
    const team = players.filter((p) => p.teamId === teamId);
    if (!laned || team.length > 5) { for (const p of team) p.role = ''; continue; }
    const guess = builds.guessRoles(team.map((p) => ({ championId: p.championId, roles: roleMapOf(p.championId, p.spells) })));
    for (const p of team) {
      p.role = builds.ROLES.includes(p.position) ? p.position
        : builds.ROLES.includes(livePos[p.championId]) ? livePos[p.championId] : (guess[p.championId] || '');
    }
  }
  const mine = players.find((p) => p.me);
  const myTeamId = mine ? mine.teamId : 100;
  if (mine && mine.role) for (const p of players) if (p.teamId !== myTeamId && p.role === mine.role) p.opp = true;
  const data = {
    phase: 'InGame', region, gameId: session ? session.gameId : null, queueId: session ? session.queueId : null, myTeamId,
    teams: teamIds.sort((a, b) => (a === myTeamId ? -1 : b === myTeamId ? 1 : a - b)).map((t) => ({ teamId: t, mine: t === myTeamId, players: players.filter((p) => p.teamId === t) })),
    at: Date.now(),
  };
  lobby = { key, data };
  return data;
}

async function getLobby() {
  if (!lobbyPromise) lobbyPromise = computeLobby().finally(() => { lobbyPromise = null; });
  return lobbyPromise;
}

const tierText = (r) => {
  if (!r) return 'Unranked';
  const t = r.tier.charAt(0) + r.tier.slice(1).toLowerCase();
  return ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(r.tier) ? t : `${t} ${r.rank}`;
};

// ---------- Oorleg: alles wat die oorleg in die spel nodig het ----------
const LIVE_POSITIONS = { TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MIDDLE', BOTTOM: 'BOTTOM', UTILITY: 'UTILITY' };
function nextSkill(rec, abilities, level) {
  const lv = (k) => (abilities && abilities[k] && abilities[k].abilityLevel) || 0;
  const used = lv('Q') + lv('W') + lv('E') + lv('R');
  if (used >= level) return null;
  const seq = rec && rec.skills[0] ? rec.skills[0].key : '';
  if (seq[used]) return seq[used];
  const rCap = level >= 16 ? 3 : level >= 11 ? 2 : level >= 6 ? 1 : 0;
  if (lv('R') < rCap) return 'R';
  const order = rec && rec.maxOrder[0] ? rec.maxOrder[0].key.split('>') : ['Q', 'W', 'E'];
  const cap = Math.min(5, Math.ceil(level / 2));
  return order.find((k) => lv(k) < cap) || order[0];
}

async function overlayData() {
  const live = await getLiveData();
  if (!live.inGame) return { inGame: false };
  const d = live.data || {};
  const ap = d.activePlayer || {};
  const myName = ap.riotIdGameName || ap.summonerName || String(ap.riotId || '').split('#')[0];
  const me = (d.allPlayers || []).find((p) => (p.riotIdGameName || p.summonerName) === myName) || null;
  const dd = await getDDragon().catch(() => DD);
  const raw = me ? String(me.rawChampionName || '') : '';
  const ddId = raw.startsWith('game_character_displayname_') ? raw.slice(27) : '';
  let championId = 0;
  let champion = null;
  if (dd) for (const [key, c] of Object.entries(dd.champions)) if (c.id === ddId) { championId = Number(key); champion = c; }
  const role = me ? LIVE_POSITIONS[me.position] || '' : '';
  const champKey = (p) => {
    const r = String((p && p.rawChampionName) || '');
    const idStr = r.startsWith('game_character_displayname_') ? r.slice(27) : '';
    if (dd) for (const [key, c] of Object.entries(dd.champions)) if (c.id === idStr) return Number(key);
    return 0;
  };
  const opp = me && role ? (d.allPlayers || []).find((p) => p.team !== me.team && LIVE_POSITIONS[p.position] === role) : null;
  const vsId = opp ? champKey(opp) : 0;
  const b = championId ? buildFor(championId, role, false, vsId || null) : null;
  const rec = b && b.rec && b.rec.games >= MIN_GAMES ? b.rec : null;
  const owned = me ? (me.items || []).map((it) => it.itemID) : [];
  const pathIds = rec ? builds.buildPath(rec) : [];
  const next = pathIds.find((id) => !owned.includes(id)) || null;
  const s = (me && me.scores) || {};
  const minutes = (d.gameData && d.gameData.gameTime ? d.gameData.gameTime : 0) / 60;
  return {
    inGame: true,
    ddVersion: dd ? dd.version : null,
    time: d.gameData ? d.gameData.gameTime : 0,
    champion: champion ? { id: champion.id, name: champion.name } : null,
    role,
    level: ap.level || (me && me.level) || 1,
    gold: ap.currentGold || 0,
    kda: [s.kills || 0, s.deaths || 0, s.assists || 0],
    cs: s.creepScore || 0,
    csPerMin: minutes >= 1 ? (s.creepScore || 0) / minutes : 0,
    owned,
    path: pathIds.map((id) => ({ id, name: dd && dd.items[id] ? dd.items[id].name : `Item ${id}`, gold: dd && dd.items[id] ? dd.items[id].gold : 0, owned: owned.includes(id) })),
    next,
    nextSkill: nextSkill(rec, ap.abilities, ap.level || 1),
    maxOrder: rec && rec.maxOrder[0] ? rec.maxOrder[0].key : null,
    games: rec ? rec.games : 0,
    vs: vsId && dd && dd.champions[vsId] ? {
      scout: (() => {
        const enemy = lobby.data && lobby.data.phase === 'InGame'
          ? lobby.data.teams.flatMap((t) => t.players).find((p) => p.championId === vsId && p.teamId !== lobby.data.myTeamId) : null;
        if (!enemy || enemy.hidden) return null;
        const r = enemy.solo || enemy.flex;
        const g = r && r.losses != null ? r.wins + r.losses : 0;
        return {
          rank: tierText(r), wr: g ? r.wins / g : null, games: g,
          mastery: enemy.mastery ? enemy.mastery.points : null, tags: enemy.tags,
        };
      })(),
      id: dd.champions[vsId].id,
      name: dd.champions[vsId].name,
      games: rec && rec.vs ? rec.vs.games : 0,
      wins: rec && rec.vs ? rec.vs.wins : 0,
      specific: !!(rec && rec.fromMatchup.length),
    } : null,
  };
}

// ---------- Roetes ----------
const app = express();
app.disable('x-powered-by');

// Sekuriteit: net ons eie venster mag die plaaslike server gebruik.
// Blokkeer ander webwerwe (CSRF) en DNS-rebinding.
let LISTEN_PORT = 0;
app.use((req, res, next) => {
  const okHosts = [`127.0.0.1:${LISTEN_PORT}`, `localhost:${LISTEN_PORT}`];
  if (!okHosts.includes(req.headers.host)) return res.status(403).send('Forbidden');
  const origin = req.headers.origin;
  if (origin && !okHosts.some((h) => origin === `http://${h}`)) return res.status(403).json({ error: 'Forbidden' });
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => res.status(err.status || 500).json({ error: err.message }));

function readRegion(req) {
  const region = String(req.query.region || '').toLowerCase();
  if (!PLATFORMS[region]) throw httpError(400, 'Unknown region.');
  return region;
}
function requireJson(req) {
  if (!req.is('application/json')) throw httpError(415, 'Expected JSON.');
}

app.use(express.json({ limit: '10kb' }));

app.get('/api/status', (req, res) => res.json({ hasKey: !!API_KEY, version: APP_VERSION, client: !!lcuState.connected }));

// Stoor die speler se eie Riot API-sleutel plaaslik (nooit in die app self ingebou nie)
app.post('/api/settings', wrap(async (req, res) => {
  requireJson(req);
  const key = String((req.body && req.body.apiKey) || '').trim();
  if (key && !/^RGAPI-[0-9a-f-]{36}$/i.test(key)) throw httpError(400, 'That does not look like a Riot API key (it starts with RGAPI-).');
  const cfg = loadConfig();
  cfg.apiKey = key;
  saveConfig(cfg);
  API_KEY = key;
  memCache.clear();
  if (crawler) crawler.lastError = null;
  updateCrawler();
  res.json({ hasKey: !!API_KEY });
}));

app.get('/api/prefs', (req, res) => res.json(getPrefs()));
app.post('/api/prefs', wrap(async (req, res) => {
  requireJson(req);
  const b = req.body || {};
  const cfg = loadConfig();
  const p = { ...(cfg.prefs || {}) };
  for (const k of ['collectBuilds', 'autoImport', 'autoSpells', 'replacePages', 'openOnChampSelect', 'overlay']) if (typeof b[k] === 'boolean') p[k] = b[k];
  if (typeof b.crawlRegion === 'string' && (b.crawlRegion === '' || PLATFORMS[b.crawlRegion])) p.crawlRegion = b.crawlRegion;
  if (['right', 'left', 'top-right'].includes(b.overlayPosition)) p.overlayPosition = b.overlayPosition;
  cfg.prefs = p;
  saveConfig(cfg);
  updateCrawler();
  res.json(getPrefs());
}));

app.get('/api/profile', wrap(async (req, res) => {
  const region = readRegion(req);
  lastUserActivity = Date.now();
  const riotId = String(req.query.riotId || '').trim();
  const hash = riotId.lastIndexOf('#');
  if (hash < 1 || hash === riotId.length - 1) throw httpError(400, 'Enter a Riot ID like Name#TAG.');
  const gameName = riotId.slice(0, hash).trim();
  const tagLine = riotId.slice(hash + 1).trim();
  const cfg = loadConfig();
  if (cfg.lastRegion !== region) { cfg.lastRegion = region; saveConfig(cfg); }

  if (!API_KEY) {
    // Geen sleutel: alles uit die League-kliënt
    const m = await requireClient(region);
    const profile = await cached(`cprofile:${riotId.toLowerCase()}`, 60 * 1000, async () => {
      const mine = m.riotId && m.riotId.toLowerCase() === riotId.toLowerCase();
      const s = mine && m.puuid
        ? await lcu.summonerByPuuid(m.puuid).catch(() => ({ puuid: m.puuid, gameName, tagLine, summonerLevel: m.level, profileIconId: m.profileIconId }))
        : await lcu.lookupRiotId(gameName, tagLine);
      if (!s || !s.puuid) throw httpError(404, `No player called ${riotId} on your server. Check the name and the tag after the #.`);
      const [rk, ms] = await Promise.allSettled([lcu.ranked(s.puuid), lcu.masteries(s.puuid)]);
      return {
        puuid: s.puuid,
        gameName: s.gameName || gameName,
        tagLine: s.tagLine || tagLine,
        level: s.summonerLevel,
        profileIconId: s.profileIconId,
        ranked: (rk.status === 'fulfilled' ? rk.value : []).map((e) => (s.puuid !== m.puuid && !e.losses ? { ...e, losses: null } : e)),
        mastery: ms.status === 'fulfilled' ? ms.value.slice(0, 5) : [],
        source: 'client',
      };
    });
    return res.json(profile);
  }

  const profile = await cached(`profile:${region}:${riotId.toLowerCase()}`, 2 * 60 * 1000, async () => {
    const account = await riot(accountRoute(region),
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
    const puuid = account.puuid;
    const summoner = await riot(region, `/lol/summoner/v4/summoners/by-puuid/${puuid}`);
    const [ranked, mastery] = await Promise.allSettled([
      riot(region, `/lol/league/v4/entries/by-puuid/${puuid}`),
      riot(region, `/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top?count=5`),
    ]);
    return {
      puuid,
      gameName: account.gameName,
      tagLine: account.tagLine,
      level: summoner.summonerLevel,
      profileIconId: summoner.profileIconId,
      ranked: ranked.status === 'fulfilled' ? ranked.value : [],
      mastery: mastery.status === 'fulfilled'
        ? mastery.value.map((m) => ({ championId: m.championId, level: m.championLevel, points: m.championPoints }))
        : [],
    };
  });
  res.json(profile);
}));

app.get('/api/matches', wrap(async (req, res) => {
  const region = readRegion(req);
  lastUserActivity = Date.now();
  const puuid = String(req.query.puuid || '');
  if (!/^[A-Za-z0-9_-]{20,}$/.test(puuid)) throw httpError(400, 'Invalid puuid.');
  const start = Math.max(0, Number(req.query.start) || 0);
  const count = Math.min(20, Math.max(1, Number(req.query.count) || 10));
  if (isClientPuuid(puuid)) {
    // Profiel kom uit die League-kliënt -> wedstryde ook
    await requireClient(region);
    const list = await lcu.matchList(puuid, start, start + count - 1).catch((err) => {
      if (err.lcuClosed) throw err;
      throw httpError(502, "Couldn't load this player's match history from the League client (their profile may be private).");
    });
    const results = await Promise.all(list.map((g) => getClientGame(g.gameId)
      .then((full) => simplifyLcuGame(full, puuid))
      .catch((err) => { if (err.lcuClosed) throw err; return null; })));
    const matches = results.filter(Boolean).sort((a, b) => b.endedAt - a.endedAt);
    return res.json({ matches, hasMore: list.length === count });
  }
  const route = matchRoute(region);
  const ids = await riot(route, `/lol/match/v5/matches/by-puuid/${puuid}/ids?start=${start}&count=${count}`);
  // Parallel (die rate limiter hou steeds by Riot se limiete), volgorde bly behoue
  const results = await Promise.all(ids.map((id) =>
    getMatch(route, id).then((m) => simplifyMatch(m, puuid)).catch((err) => {
      if (err.status === 401 || err.status === 403) throw err;
      return null; // slaan stukkende wedstryd oor
    })));
  res.json({ matches: results.filter(Boolean), hasMore: ids.length === count });
}));

app.get('/api/live', wrap(async (req, res) => res.json(await getLiveData())));
app.get('/api/update', (req, res) => res.json(updateState));
app.post('/api/update/install', wrap(async (req, res) => {
  requireJson(req);
  if (!installHandler || updateState.state !== 'ready') throw httpError(409, 'No update is ready to install.');
  res.json({ ok: !!installHandler() });
}));
app.get('/api/me', wrap(async (req, res) => {
  const m = await whoAmI();
  res.json({ connected: m.connected, riotId: m.riotId, region: m.region, level: m.level, profileIconId: m.profileIconId });
}));
app.get('/api/lobby', wrap(async (req, res) => res.json(await getLobby())));
app.get('/api/overlay', wrap(async (req, res) => res.json(await overlayData())));

app.get('/api/ddragon', wrap(async (req, res) => {
  try { res.json(await getDDragon()); }
  catch { throw httpError(502, 'Could not load Data Dragon.'); }
}));

app.get('/api/builds/status', (req, res) => res.json({
  ...crawler.status(),
  enabled: getPrefs().collectBuilds,
  hasKey: !!API_KEY,
  region: crawlRegion(),
  sharedMatches: remoteInfo.matches,
  sharedUpdated: remoteInfo.updated,
  sharedRegions: remoteInfo.regions.map((r) => REGION_NAMES[r] || r.toUpperCase()),
}));

app.get('/api/builds/champion/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Invalid champion.');
  const role = String(req.query.role || '').toUpperCase();
  const vs = Number(req.query.vs) || null;
  const b = buildFor(id, builds.ROLES.includes(role) ? role : '', req.query.strict === '1', vs);
  if (!b.rec || b.rec.games < MIN_GAMES) {
    if (!b.role) b.role = (riotPositions.map[id] || [])[0] || '';
    b.riot = lcuState.connected ? await lcu.recommendedPage(id, b.role).catch(() => null) : null;
  }
  b.riotRoles = riotPositions.map[id] || [];
  res.json(b);
}));

app.get('/api/builds/counters/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Invalid champion.');
  const role = String(req.query.role || '').toUpperCase();
  res.json(countersFor(id, builds.ROLES.includes(role) ? role : ''));
}));

app.get('/api/builds/best', wrap(async (req, res) => {
  const role = String(req.query.role || '').toUpperCase();
  if (!builds.ROLES.includes(role)) throw httpError(400, 'Invalid role.');
  res.json({ role, best: builds.bestInRole(db.roleTable(role, builds.KEEP_PATCHES), 20, 15) });
}));

// Speler kies self wie sy lane-teenstander is (0 = terug na RiftScout se raaiskoot)
app.post('/api/lcu/vs', wrap(async (req, res) => {
  requireJson(req);
  const id = Number(req.body && req.body.championId) || 0;
  vsOverride = id > 0 ? id : null;
  await lcuTick();
  res.json({ ok: true, vs: lcuState.champSelect ? lcuState.champSelect.vs : null });
}));

app.get('/api/lcu/state', (req, res) => {
  const p = getPrefs();
  res.json({ ...lcuState, lastImport, autoImport: p.autoImport, autoSpells: p.autoSpells });
});
app.post('/api/lcu/import', wrap(async (req, res) => {
  requireJson(req);
  const championId = Number(req.body.championId);
  if (!Number.isInteger(championId) || championId <= 0) throw httpError(400, 'Invalid champion.');
  const what = new Set((req.body.what || []).filter((w) => ['runes', 'items', 'spells'].includes(w)));
  const role = builds.ROLES.includes(req.body.role) ? req.body.role : '';
  const vs = Number(req.body.vs) || null;
  lastImport = await doImport(championId, role, what, lcuState.champSelect, vs);
  res.json(lastImport);
}));

// ---------- Begin ----------
function startServer({ port = 3000, dataDir = __dirname } = {}) {
  DATA_DIR = dataDir;
  CACHE_DIR = path.join(DATA_DIR, 'cache', 'matches');
  CONFIG_FILE = path.join(DATA_DIR, 'config.json');
  CONFIG = null;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const saved = loadConfig().apiKey;
  if (saved) API_KEY = saved;

  if (!db) {
    db = new builds.BuildDB(path.join(DATA_DIR, 'builds', 'builds.json'));
    seen = new builds.SeenSet(path.join(DATA_DIR, 'builds', 'seen.json'));
    crawler = new builds.Crawler({
      riot: riotBackground, db, seen,
      getRegion: crawlRegion,
      getClassifier: () => itemCls,
      hasKey: () => !!API_KEY,
      isUserBusy: () => Date.now() - lastUserActivity < 15000,
      paceMs: CRAWL_PACE_MS,
      log: (m) => console.log(m),
    });
    const loadDD = () => getDDragon().catch(() => setTimeout(loadDD, 60000));
    loadDD();
    loadRemoteBuilds();
    setInterval(loadRemoteBuilds, 3600 * 1000).unref(); // elke uur: nuwe gedeelde data kom vinnig by almal uit
    setInterval(lcuTick, 2000).unref();
    updateCrawler();
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      LISTEN_PORT = server.address().port;
      resolve(LISTEN_PORT);
    });
    server.on('error', reject);
  });
}

function saveBuildData() { if (crawler) crawler.save(); }

// ---------- Updates (main.js meld die stand; die blad wys dit) ----------
let updateState = { state: 'none' };
let installHandler = null;
function setUpdateState(s) { updateState = { ...s, at: Date.now() }; }
function onInstallRequest(fn) { installHandler = fn; }
// Is jy in champ select of 'n spel? Dan herbegin ons nie die app nie.
async function isBusy() {
  if (['ChampSelect', 'GameStart', 'InProgress', 'Reconnect'].includes(lcuState.phase)) return true;
  return (await getLiveData()).inGame;
}

module.exports = { startServer, getLiveData, getPrefs, saveBuildData, setUpdateState, onInstallRequest, isBusy, onChampSelectStart };

if (require.main === module) {
  startServer({ port: Number(process.env.PORT) || 3000 }).then((port) => {
    console.log(`\n  RiftScout is running:  http://localhost:${port}\n`);
    if (!API_KEY) console.log('  No Riot API key yet - add it under Settings in the app (Live Game works without it).\n');
  });
}
