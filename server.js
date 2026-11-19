// RiftScout - eenvoudige League of Legends companion app
// Backend: hou die Riot API-sleutel geheim, cache wedstryde, respekteer rate limits,
// en lees die Live Client Data API (slegs beskikbaar op die rekenaar waar LoL speel).

// Loop as desktop-app (main.js roep startServer) of los: `node server.js`.

try { require('dotenv').config({ path: require('path').join(__dirname, '.env') }); } catch { /* opsioneel */ }
const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');

const HOST_TEMPLATE = process.env.RIOT_HOST_TEMPLATE || 'https://{route}.api.riotgames.com';
const LIVE_URL = process.env.LIVE_CLIENT_URL || 'https://127.0.0.1:2999/liveclientdata/allgamedata';
const APP_VERSION = require('./package.json').version;

// Word in startServer() gestel: waar instellings en cache gestoor word
let DATA_DIR = __dirname;
let CACHE_DIR = path.join(__dirname, 'cache', 'matches');
let CONFIG_FILE = path.join(__dirname, 'config.json');
let API_KEY = (process.env.RIOT_API_KEY || '').trim();

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ---------- Streke ----------
// platform (vir summoner/league/mastery) -> regional route (vir match-v5)
const PLATFORMS = {
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe', me1: 'europe',
  kr: 'asia', jp1: 'asia',
  oc1: 'sea', sg2: 'sea', tw2: 'sea', vn2: 'sea',
};
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

// ---------- Data Dragon (statiese data: weergawe, spells, runes, champions) ----------
async function getDDragon() {
  return cached('ddragon', 60 * 60 * 1000, async () => {
    const base = 'https://ddragon.leagueoflegends.com';
    const versions = await (await fetch(`${base}/api/versions.json`)).json();
    const v = versions[0];
    const [spellsRaw, runesRaw, champsRaw] = await Promise.all([
      fetch(`${base}/cdn/${v}/data/en_US/summoner.json`).then((r) => r.json()),
      fetch(`${base}/cdn/${v}/data/en_US/runesReforged.json`).then((r) => r.json()),
      fetch(`${base}/cdn/${v}/data/en_US/champion.json`).then((r) => r.json()),
    ]);
    const spells = {};
    for (const s of Object.values(spellsRaw.data)) spells[s.key] = { name: s.name, image: s.image.full };
    const runes = {};
    for (const style of runesRaw) {
      runes[style.id] = { name: style.name, icon: style.icon };
      for (const slot of style.slots) for (const r of slot.runes) runes[r.id] = { name: r.name, icon: r.icon };
    }
    const champions = {};
    for (const c of Object.values(champsRaw.data)) champions[c.key] = { id: c.id, name: c.name };
    return { version: v, spells, runes, champions };
  });
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

app.use(express.json({ limit: '10kb' }));

app.get('/api/status', (req, res) => res.json({ hasKey: !!API_KEY, version: APP_VERSION }));

// Stoor die speler se eie Riot API-sleutel plaaslik (nooit in die app self ingebou nie)
app.post('/api/settings', wrap(async (req, res) => {
  if (!req.is('application/json')) throw httpError(415, 'Expected JSON.');
  const key = String((req.body && req.body.apiKey) || '').trim();
  if (key && !/^RGAPI-[0-9a-f-]{36}$/i.test(key)) throw httpError(400, 'That does not look like a Riot API key (it starts with RGAPI-).');
  const cfg = loadConfig();
  cfg.apiKey = key;
  saveConfig(cfg);
  API_KEY = key;
  memCache.clear();
  res.json({ hasKey: !!API_KEY });
}));

app.get('/api/profile', wrap(async (req, res) => {
  const region = readRegion(req);
  const riotId = String(req.query.riotId || '').trim();
  const hash = riotId.lastIndexOf('#');
  if (hash < 1 || hash === riotId.length - 1) throw httpError(400, 'Enter a Riot ID like Name#TAG.');
  const gameName = riotId.slice(0, hash).trim();
  const tagLine = riotId.slice(hash + 1).trim();

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
  const puuid = String(req.query.puuid || '');
  if (!/^[A-Za-z0-9_-]{20,}$/.test(puuid)) throw httpError(400, 'Invalid puuid.');
  const start = Math.max(0, Number(req.query.start) || 0);
  const count = Math.min(20, Math.max(1, Number(req.query.count) || 10));
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

app.get('/api/ddragon', wrap(async (req, res) => {
  try { res.json(await getDDragon()); }
  catch { throw httpError(502, 'Could not load Data Dragon.'); }
}));

// ---------- Begin ----------
function startServer({ port = 3000, dataDir = __dirname } = {}) {
  DATA_DIR = dataDir;
  CACHE_DIR = path.join(DATA_DIR, 'cache', 'matches');
  CONFIG_FILE = path.join(DATA_DIR, 'config.json');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const saved = loadConfig().apiKey;
  if (saved) API_KEY = saved;
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      LISTEN_PORT = server.address().port;
      resolve(LISTEN_PORT);
    });
    server.on('error', reject);
  });
}

module.exports = { startServer };

if (require.main === module) {
  startServer({ port: Number(process.env.PORT) || 3000 }).then((port) => {
    console.log(`\n  RiftScout is running:  http://localhost:${port}\n`);
    if (!API_KEY) console.log('  No Riot API key yet - add it under Settings in the app (Live Game works without it).\n');
  });
}
