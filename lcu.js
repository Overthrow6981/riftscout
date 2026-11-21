// League Client (LCU) koppeling: champ select lees en runes, item sets en summoner spells invoer.
// Die kliënt loop 'n plaaslike HTTPS-API; die poort en wagwoord kom uit die "lockfile"
// in die League-installasie, of uit die LeagueClientUx-proses se opdragreël.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const POSITIONS = { top: 'TOP', jungle: 'JUNGLE', middle: 'MIDDLE', bottom: 'BOTTOM', utility: 'UTILITY' };

let creds = null;
let lastLookup = 0;
let lastProcessLookup = 0;

// lockfile: "LeagueClient:<pid>:<port>:<wagwoord>:<protokol>" (die regte kliënt is altyd https)
function readLockfile(file) {
  try {
    const [, , port, password, protocol] = fs.readFileSync(file, 'utf8').trim().split(':');
    if (port && password) return { port: Number(port), token: password, protocol: protocol === 'http' ? 'http' : 'https', dir: path.dirname(file) };
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
      // Die League-gids (bv. E:\Riot Games\League of Legends) vir die winkel se item set-lêers
      const dir = /"--install-directory=([^"]+)"/.exec(out) || /--install-directory=(\S+)/.exec(out);
      resolve(port && token ? { port: Number(port[1]), token: token[1], protocol: 'https', dir: dir ? dir[1].replace(/[\\/]+$/, '') : null } : null);
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
  // PowerShell kos 'n bietjie CPU: as League toe is, hoogstens elke 30 s
  if (!c && Date.now() - lastProcessLookup >= 30000) { lastProcessLookup = Date.now(); c = await fromProcess(); }
  return (creds = c);
}

// Antwoord: { status, data }. status 0 = League is toe / onbereikbaar.
// 'n Stadige antwoord (bv. wedstrydgeskiedenis wat die kliënt eers by Riot moet haal) is NIE "League is toe" nie:
// dan { status: 408, timeout: true } en die verbinding bly.
const LCU_TIMEOUT_MS = Number(process.env.LCU_TIMEOUT_MS) || 4000;
async function request(method, p, body, { timeout = LCU_TIMEOUT_MS } = {}) {
  const c = await findCreds();
  if (!c) return { status: 0, data: null };
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const headers = { Authorization: 'Basic ' + Buffer.from('riot:' + c.token).toString('base64'), Accept: 'application/json' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const lib = c.protocol === 'http' ? http : https;
    const req = lib.request({ host: '127.0.0.1', port: c.port, path: p, method, headers, rejectUnauthorized: false, timeout }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        let data = null;
        try { data = buf ? JSON.parse(buf) : null; } catch { data = buf; }
        finish({ status: res.statusCode, data });
      });
      // Afgebreekte antwoord: sonder hierdie luisteraar sou 'n 'error' op res die hele app laat val
      res.on('error', () => finish({ status: 408, data: null, timeout: true }));
      res.on('aborted', () => finish({ status: 408, data: null, timeout: true }));
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error('LCU timeout'), { code: 'LCU_TIMEOUT' })); });
    req.on('error', (err) => {
      if (err && err.code === 'LCU_TIMEOUT') return finish({ status: 408, data: null, timeout: true });
      creds = null; lastLookup = 0; finish({ status: 0, data: null });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

const ok = (r) => r.status >= 200 && r.status < 300;

async function state() {
  const ph = await request('GET', '/lol-gameflow/v1/gameflow-phase');
  if (ph.status === 0) return { connected: false, phase: null, champSelect: null };
  // Kliënt is net besig (stadige antwoord): hierdie keer oorslaan, nie "League is toe" of "fase None" nie
  if (ph.timeout) return { connected: true, phase: null, champSelect: null, stale: true };
  const phase = typeof ph.data === 'string' ? ph.data : 'None';
  let champSelect = null;
  if (phase === 'ChampSelect') {
    const s = await request('GET', '/lol-champ-select/v1/session');
    if (s.timeout) return { connected: true, phase, champSelect: null, stale: true };
    if (s.status === 200 && s.data) {
      const me = (s.data.myTeam || []).find((x) => x.cellId === s.data.localPlayerCellId);
      // Vyandige picks: uit theirTeam én uit die voltooide pick-aksies (wat ook al eerste opdaag)
      const theirCells = new Set((s.data.theirTeam || []).map((x) => x.cellId));
      const enemyIds = new Set((s.data.theirTeam || []).map((x) => x.championId).filter((id) => id > 0));
      for (const a of (s.data.actions || []).flat()) {
        if (a && a.type === 'pick' && a.completed && a.championId > 0 && theirCells.has(a.actorCellId)) enemyIds.add(a.championId);
      }
      if (me) {
        const locked = (s.data.actions || []).flat().some((a) => a.actorCellId === me.cellId && a.type === 'pick' && a.completed);
        champSelect = {
          championId: me.championId || me.championPickIntent || 0,
          locked: locked && !!me.championId,
          role: POSITIONS[String(me.assignedPosition || '').toLowerCase()] || '',
          spell1Id: me.spell1Id || 0,
          spell2Id: me.spell2Id || 0,
          // Vyande se champions (sigbaar sodra hulle gekies is)
          enemies: [...enemyIds],
          // Gebande champions (kan nie meer gekies word nie)
          bans: [...new Set((s.data.actions || []).flat()
            .filter((a) => a && a.type === 'ban' && a.completed && a.championId > 0).map((a) => a.championId))],
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
            role: POSITIONS[String(x.assignedPosition || '').toLowerCase()] || '',
            me: x.cellId === s.data.localPlayerCellId,
            };
          }),
        };
      }
    }
  }
  return { connected: true, phase, champSelect };
}

// Velde wat die kliënt self uit die runes aflei: nie terugstuur nie (dit sou die ou runes beskryf)
const DERIVED_PAGE_FIELDS = ['uiPerks', 'pageKeystone', 'primaryStyleName', 'primaryStyleIconPath', 'secondaryStyleName',
  'secondaryStyleIconPath', 'tooltipBgPath', 'autoModifiedSelections'];
const isOurPage = (p) => !!p && String(p.name || '').startsWith('RiftScout');

// Maak seker die bladsy is die een wat in League gekies is (en kyk dit na)
async function selectPage(id, name) {
  const cur = await request('GET', '/lol-perks/v1/currentpage');
  if (ok(cur) && cur.data && (cur.data.id === id || (id == null && cur.data.name === name))) return true;
  if (id == null) return false;
  await request('PUT', '/lol-perks/v1/currentpage', id);
  const again = await request('GET', '/lol-perks/v1/currentpage');
  return ok(again) && !!again.data && again.data.id === id;
}

// rune = { primaryStyleId, subStyleId, primary[4], secondary[2], shards[3] }
// RiftScout hou een eie bladsy en skryf dit oor (soos ander apps doen): uitvee en weer maak het 'n oomblik
// gelaat waarin League 'n ander bladsy kies, en 'n nuwe bladsy kan "Max pages reached" gee.
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
  const ours = (pages.data || []).filter((p) => isOurPage(p) && p.isDeletable && p.isEditable !== false);
  let id = null;
  let r;
  if (ours[0]) {
    const page = { ...ours[0] };
    for (const f of DERIVED_PAGE_FIELDS) delete page[f];
    r = await request('PUT', `/lol-perks/v1/pages/${ours[0].id}`, { ...page, ...body });
    if (ok(r)) id = ours[0].id;
  }
  // Ekstra RiftScout-bladsye (van ouer weergawes) weg; as die oorskryf misluk het, ook die eerste een
  for (const p of ours.slice(id == null ? 0 : 1)) await request('DELETE', `/lol-perks/v1/pages/${p.id}`);
  let replaced;
  if (id == null) {
    r = await request('POST', '/lol-perks/v1/pages', body);
    if (ok(r)) id = r.data && r.data.id != null ? r.data.id : null;
    else if (replaceCurrent) {
      // Alle bladsye vol: vervang die huidige bladsy (of anders die laaste een wat jy kan uitvee)
      const cur = await request('GET', '/lol-perks/v1/currentpage');
      const left = await request('GET', '/lol-perks/v1/pages');
      const own = ((left.status === 200 && left.data) || []).filter((p) => p.isDeletable);
      const target = (cur.status === 200 && cur.data && cur.data.isDeletable) ? cur.data : own[own.length - 1];
      if (target) {
        await request('DELETE', `/lol-perks/v1/pages/${target.id}`);
        r = await request('POST', '/lol-perks/v1/pages', body);
        if (ok(r)) { id = r.data && r.data.id != null ? r.data.id : null; replaced = target.name; }
      }
    }
    if (!ok(r)) {
      return {
        ok: false,
        error: replaceCurrent
          ? 'All your rune pages are full and none of them can be replaced. Delete one in the League client.'
          : 'No free rune page. Delete one in the client, or turn on "Replace a rune page when all are full" in Settings.',
      };
    }
  }
  const selected = await selectPage(id, body.name);
  return { ok: true, ...(replaced ? { replaced } : {}), ...(selected ? {} : { notSelected: true }) };
}

// Die rune page wat nou in League gekies is (naam en id)
async function currentRunePage() {
  const r = await request('GET', '/lol-perks/v1/currentpage');
  return r.status === 200 && r.data ? { id: r.data.id, name: String(r.data.name || '') } : null;
}
const isBlitzPage = (p) => !!p && /\bblitz\b/i.test(p.name) && !/^riftscout/i.test(p.name);

// Loop die Blitz-app op hierdie PC? (Blitz se X-knoppie sit dit net in die taakbalk by die horlosie.)
let blitzCache = { at: 0, running: false };
function isBlitzRunning() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  if (Date.now() - blitzCache.at < 15000) return Promise.resolve(blitzCache.running);
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq Blitz.exe', '/FO', 'CSV', '/NH'], { timeout: 5000, windowsHide: true }, (err, out) => {
      const running = !err && /"blitz\.exe"/i.test(String(out || ''));
      blitzCache = { at: Date.now(), running };
      resolve(running);
    });
  });
}
// Maak Blitz toe (net as die gebruiker op die knoppie in RiftScout klik)
function closeBlitz() {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'Only on Windows.' });
  return new Promise((resolve) => {
    execFile('taskkill', ['/IM', 'Blitz.exe', '/T', '/F'], { timeout: 10000, windowsHide: true }, (err) => {
      blitzCache = { at: 0, running: false };
      resolve(err ? { ok: false, error: 'Could not close Blitz. Right-click the Blitz icon by the clock and choose Quit.' } : { ok: true });
    });
  });
}

// ---------- Item sets ----------
// League kry item sets van twee plekke:
//  1. Die rekening se lys (/lol-item-sets/v1/item-sets/{summonerId}/sets). Die kliënt se skema vir 'n set het
//     GEEN "priority"-veld nie (dit word weggegooi), so so 'n set kan nie bo 'n "priority"-lêer kom nie.
//  2. Lêers in <League>\Config\Global\Recommended\*.json, wat die spel lees as dit laai, vir ELKE champion.
//     Die Blitz-app skryf sy sets net hier ("!!!blitz-0.json" ens., "Blitz: Crit Miss Fortune") met priority en
//     'n sortrank van 1 000 000 000, en haal dit eers ná die game uit. As Blitz toegemaak (of geforseer gestop)
//     word voor dit opruim, bly sy set agter en maak die winkel vir elke champion daarop oop.
// Daarom skryf RiftScout sy set ook as so 'n lêer, met 'n hoër rang, en haal dit ná die game uit.
const SHOP_FILE_PREFIX = '!!!riftscout-';
const SHOP_RANK = 2100000000; // bo Blitz (1e9) en ander apps (2e9), binne die spel se 32-bis sortrank
const MAX_SET_FILE = 512 * 1024;

const forChamp = (s, championId) => (s.associatedChampions || []).includes(championId);
const isRiftScoutSet = (s, championId) => String(s.title || '').startsWith('RiftScout') && (championId == null || forChamp(s, championId));
// Blitz noem sy sets "Blitz: Crit Miss Fortune" ens. (nie "Blitzcrank ..." nie)
const isBlitzTitle = (t) => /^blitz\b/i.test(String(t || '').trim());
const isBlitzSet = (s, championId, champName) => isBlitzTitle(s.title)
  && (forChamp(s, championId) || (!(s.associatedChampions || []).length && !!champName && String(s.title).includes(champName)));
const isBlitzFile = (name, set) => /^!*blitz[-_ ]/i.test(name) || (!!set && isBlitzTitle(set.title));

// Waar is League geïnstalleer (bv. E:\Riot Games\League of Legends)? Die kliënt sê self; anders die lockfile se gids.
let installCache = { at: 0, dir: null };
async function installDir() {
  if (installCache.dir && Date.now() - installCache.at < 10 * 60e3) return installCache.dir;
  let dir = null;
  const r = await request('GET', '/data-store/v1/install-dir');
  if (ok(r) && typeof r.data === 'string' && r.data.trim()) dir = r.data.trim();
  if (!dir && creds && creds.dir) dir = creds.dir;
  if (dir) installCache = { at: Date.now(), dir };
  return dir || installCache.dir; // League toe: die laaste bekende gids (om ná die game op te ruim)
}

// Die gidse waar die spel item set-lêers lees (Garena/Tencent hou Config in 'n "Game"-gids langsaan)
function shopFolders(dir) {
  if (!dir) return [];
  const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
  return [path.join(dir, 'Config'), path.join(dir, '..', 'Game', 'Config')].filter(isDir)
    .map((c) => path.join(c, 'Global', 'Recommended'));
}
function readSetFile(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_SET_FILE) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch { return null; }
}
function listSetFiles(folder) {
  let names = [];
  try { names = fs.readdirSync(folder); } catch { return []; }
  return names.filter((n) => n.toLowerCase().endsWith('.json')).map((n) => ({ name: n, file: path.join(folder, n) }));
}
const fileRank = (s) => (s && s.priority === true ? 1e10 : 0) + (Number(s && s.sortrank) || 0);

// Die set in die vorm wat Blitz (en ander apps) in Config\Global\Recommended skryf
function shopSet(championKey, title, blocks) {
  return {
    title: String(title).slice(0, 75),
    championKey: championKey || '',
    map: 'any',
    mode: 'any',
    type: 'custom',
    priority: true,
    sortrank: SHOP_RANK,
    blocks: blocks.map((b) => ({
      recMath: false, minSummonerLevel: -1, maxSummonerLevel: -1, showIfSummonerSpell: '', hideIfSummonerSpell: '',
      type: String(b.type || 'Items').slice(0, 60),
      items: (b.items || []).map((it) => ({ id: String(it.id), count: Number(it.count) || 1 })),
    })).filter((b) => b.items.length),
  };
}

// Lêerwerk (los getoets): skryf ons set, haal ons ou lêers uit, en as gevra die Blitz-app se oorblywende sets
function writeShopFiles(folders, set, { removeBlitz = false, extraBlitzFolders = [] } = {}) {
  let removedBlitz = 0;
  const written = [];
  let error = null;
  for (const folder of folders) {
    try {
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, `${SHOP_FILE_PREFIX}0.json`);
      for (const f of listSetFiles(folder)) {
        if (f.name.startsWith(SHOP_FILE_PREFIX)) { if (f.file !== file) fs.rmSync(f.file, { force: true }); continue; }
        if (removeBlitz && isBlitzFile(f.name, readSetFile(f.file))) { fs.rmSync(f.file, { force: true }); removedBlitz++; }
      }
      const tmp = path.join(folder, `.riftscout-${process.pid}-${Date.now()}.tmp`); // nie .json nie: die spel lees dit nooit half
      fs.writeFileSync(tmp, JSON.stringify(set));
      fs.renameSync(tmp, file);
      written.push(file);
    } catch (e) { error = e; }
  }
  if (removeBlitz) {
    for (const folder of extraBlitzFolders) {
      for (const f of listSetFiles(folder)) {
        const s = readSetFile(f.file);
        if (s && isBlitzTitle(s.title)) { try { fs.rmSync(f.file, { force: true }); removedBlitz++; } catch { /* gesluit */ } }
      }
    }
  }
  return { written, removedBlitz, error: written.length ? null : error };
}
function removeShopFiles(folders, { ours = true, blitz = false } = {}) {
  let removed = 0;
  for (const folder of folders) {
    for (const f of listSetFiles(folder)) {
      const mine = f.name.startsWith(SHOP_FILE_PREFIX);
      if ((ours && mine) || (blitz && !mine && isBlitzFile(f.name, readSetFile(f.file)))) {
        try { fs.rmSync(f.file, { force: true }); removed++; } catch { /* Windows hou dit dalk gesluit: volgende keer weer */ }
      }
    }
  }
  return removed;
}
// Is ons lêer daar, en wys die winkel dit eerste (geen ander lêer met priority en 'n hoër of gelyke rang)?
function shopFilesStatus(folders) {
  let ours = false;
  let first = true;
  let blitz = 0;
  for (const folder of folders) {
    for (const f of listSetFiles(folder)) {
      const s = readSetFile(f.file);
      if (f.name.startsWith(SHOP_FILE_PREFIX)) { if (s) ours = true; continue; }
      if (isBlitzFile(f.name, s)) blitz++;
      if (s && fileRank(s) >= fileRank({ priority: true, sortrank: SHOP_RANK })) first = false;
    }
  }
  return { ours, first: ours && first, blitz };
}

let shopFoldersUsed = new Set();
const champFolder = (dir, championKey) => (dir && championKey ? path.join(dir, 'Config', 'Champions', championKey, 'Recommended') : null);

// Sit RiftScout se set in die winkel (Config\Global\Recommended). removeBlitz: haal Blitz se oorblywende sets uit.
async function writeShopItemSet({ championKey, title, blocks, removeBlitz = false }) {
  const dir = await installDir();
  const folders = shopFolders(dir);
  if (!folders.length) {
    return { ok: false, error: dir ? `League's Config folder was not found in ${dir}.` : 'Could not find the League install folder.' };
  }
  const extra = removeBlitz && champFolder(dir, championKey) ? [champFolder(dir, championKey)] : [];
  const r = writeShopFiles(folders, shopSet(championKey, title, blocks), { removeBlitz, extraBlitzFolders: extra });
  for (const f of folders) shopFoldersUsed.add(f);
  if (!r.written.length) return { ok: false, error: `Could not write the item set file (${(r.error && r.error.code) || 'error'}).` };
  return { ok: true, method: 'shop', files: r.written, removedBlitz: r.removedBlitz };
}
async function shopItemSetStatus() {
  const folders = shopFolders(await installDir());
  return folders.length ? shopFilesStatus(folders) : null;
}
// Ná die game (of as champ select sonder 'n game eindig): ons set uit die winkel, anders wys dit vir elke champion
async function clearShopItemSets({ blitz = false } = {}) {
  const folders = new Set(shopFoldersUsed);
  try { for (const f of shopFolders(await installDir())) folders.add(f); } catch { /* League toe */ }
  return removeShopFiles([...folders], { ours: true, blitz });
}
// By afsluit van RiftScout (sinchroon): net die gidse wat ons al ken
function clearShopItemSetsSync() {
  const folders = new Set(shopFoldersUsed);
  for (const f of shopFolders(installCache.dir)) folders.add(f);
  return removeShopFiles([...folders], { ours: true });
}
async function removeBlitzShopFiles() {
  return removeShopFiles(shopFolders(await installDir()), { ours: false, blitz: true });
}

// ---------- Die rekening se item sets (rugsteun as die lêer nie geskryf kan word nie) ----------
// Volgorde in die winkel: sets met "priority" eerste, dan die hoogste "sortrank" (aflopend)
const setRank = (s) => (s.priority ? 1e9 : 0) + (Number(s.sortrank) || 0);
const visibleFor = (s, championId) => forChamp(s, championId) || !(s.associatedChampions || []).length;
// Die kliënt weier 'n lys groter as ~64 KB (HTTP 413): hou net RiftScout se nuutste paar sets
const MAX_OWN_ACCOUNT_SETS = 8;

async function readItemSets() {
  const me = await request('GET', '/lol-summoner/v1/current-summoner');
  if (me.status !== 200 || !me.data || !me.data.summonerId) return { error: 'Not logged in to the League client.' };
  const url = `/lol-item-sets/v1/item-sets/${me.data.summonerId}/sets`;
  const cur = await request('GET', url);
  if (cur.status !== 200 || !cur.data) return { error: 'Could not read item sets.' };
  return { url, data: cur.data };
}

// Is RiftScout se set nog daar en boaan vir hierdie champion, en is daar Blitz-sets?
async function itemSetStatus(championId, champName) {
  const r = await readItemSets();
  if (r.error) return null;
  const sets = r.data.itemSets || [];
  // Wat die winkel vir hierdie champion wys, in die volgorde wat dit wys (die eerste een is die een wat oopmaak)
  const mine = sets.filter((s) => visibleFor(s, championId)).sort((a, b) => setRank(b) - setRank(a));
  const ours = mine.find((s) => isRiftScoutSet(s, championId));
  return {
    ours: !!ours,
    first: !!ours && !mine.some((s) => s !== ours && setRank(s) >= setRank(ours)),
    blitz: sets.filter((s) => isBlitzSet(s, championId, champName)).length,
  };
}

// Die nuwe lys: ons set vir hierdie champion eerste, ons ou sets vir dieselfde champion weg, hoogstens
// MAX_OWN_ACCOUNT_SETS van ons sets altesaam; elke ander set bly net soos dit was.
function mergeAccountSets(sets, championId, newSet, { removeBlitz = false, champName = '' } = {}) {
  let removed = 0;
  let own = 0;
  const itemSets = [];
  for (const s of sets || []) {
    if (isRiftScoutSet(s, championId)) continue;
    if (isRiftScoutSet(s, null) && ++own >= MAX_OWN_ACCOUNT_SETS) continue;
    if (removeBlitz && isBlitzSet(s, championId, champName)) { removed++; continue; }
    itemSets.push(s);
  }
  itemSets.unshift(newSet);
  return { itemSets, removedBlitz: removed };
}

// removeBlitz: haal die Blitz-app se sets vir hierdie champion uit, sodat RiftScout s'n die een in die winkel is
async function importItemSet(championId, title, blocks, { removeBlitz = false, champName = '' } = {}) {
  const r = await readItemSets();
  if (r.error) return { ok: false, error: r.error };
  const { url } = r;
  const cur = { data: r.data };
  const others = (cur.data.itemSets || []).filter((s) => !isRiftScoutSet(s, championId));
  // Die hoogste sortrank (die kliënt ken nie "priority" nie, so dit word nie gestuur nie)
  const top = others.filter((s) => visibleFor(s, championId)).reduce((m, s) => Math.max(m, Number(s.sortrank) || 0), 0);
  const { itemSets, removedBlitz } = mergeAccountSets(cur.data.itemSets, championId, {
    title: title.slice(0, 75),
    associatedChampions: [championId],
    associatedMaps: [11],
    blocks: blocks.map((b) => ({ hideIfSummonerSpell: '', showIfSummonerSpell: '', ...b })),
    map: 'any',
    mode: 'any',
    preferredItemSlots: [],
    sortrank: Math.min(top + 1, 2147483647),
    startedFrom: 'blank',
    type: 'custom',
    uid: crypto.randomUUID(),
  }, { removeBlitz, champName });
  const put = await request('PUT', url, { ...cur.data, itemSets, timestamp: Date.now() });
  return ok(put) ? { ok: true, method: 'account', removedBlitz } : { ok: false, error: `Item set import failed (${put.status}).` };
}

// RiftScout se sets uit die rekening se lys (ou weergawes het een per champion bygevoeg; die winkel-lêer vervang dit)
async function removeAccountSets() {
  const r = await readItemSets();
  if (r.error) return 0;
  const sets = r.data.itemSets || [];
  const keep = sets.filter((s) => !isRiftScoutSet(s, null));
  if (keep.length === sets.length) return 0;
  const put = await request('PUT', r.url, { ...r.data, itemSets: keep, timestamp: Date.now() });
  return ok(put) ? sets.length - keep.length : 0;
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

// ---------- Riot se eie aanbevelings in die kliënt (werk sonder enige build-data) ----------
const ROLE_ALIASES = { TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MIDDLE', MID: 'MIDDLE', BOTTOM: 'BOTTOM', BOT: 'BOTTOM', ADC: 'BOTTOM', UTILITY: 'UTILITY', SUPPORT: 'UTILITY' };

// Watter posisies elke champion gespeel word: { championId: ['MIDDLE', 'TOP'] }
async function recommendedPositions() {
  const r = await request('GET', '/lol-perks/v1/recommended-champion-positions');
  if (!ok(r) || !r.data || typeof r.data !== 'object') return null;
  const out = {};
  for (const [id, v] of Object.entries(r.data)) {
    const list = (v && v.recommendedPositions) || [];
    const roles = [...new Set(list.map((x) => ROLE_ALIASES[String(x).toUpperCase()]).filter(Boolean))];
    if (roles.length) out[Number(id)] = roles;
  }
  return out;
}

// Riot se aanbevole rune page (en spells) vir 'n champion in 'n posisie
const SHARD = (id) => id >= 5000 && id < 5100;
async function recommendedPage(championId, role) {
  const tries = [...new Set([role, String(role || '').toLowerCase(), role === 'MIDDLE' ? 'MID' : '', role === 'UTILITY' ? 'SUPPORT' : '', 'NONE'].filter(Boolean))];
  for (const pos of tries) {
    const r = await request('GET', `/lol-perks/v1/recommended-pages/champion/${Number(championId)}/position/${encodeURIComponent(pos)}/map/11`);
    if (!ok(r) || !Array.isArray(r.data) || !r.data.length) continue;
    const want = ROLE_ALIASES[String(role || '').toUpperCase()];
    const p = r.data.find((x) => ROLE_ALIASES[String(x.position || '').toUpperCase()] === want) || r.data[0];
    const perks = (p.perks || []).filter((k) => k && k.id);
    const runes = perks.filter((k) => !SHARD(k.id));
    let primary = runes.filter((k) => k.styleId === p.primaryPerkStyleId).map((k) => k.id);
    let secondary = runes.filter((k) => k.styleId !== p.primaryPerkStyleId).map((k) => k.id);
    let shards = perks.filter((k) => SHARD(k.id)).map((k) => k.id);
    if (primary.length !== 4 || secondary.length !== 2 || shards.length !== 3) {
      if (perks.length !== 9) continue;
      const ids = perks.map((k) => k.id); // volgorde: 4 primêr, 2 sekondêr, 3 shards
      primary = ids.slice(0, 4); secondary = ids.slice(4, 6); shards = ids.slice(6, 9);
    }
    return {
      primaryStyleId: p.primaryPerkStyleId, subStyleId: p.secondaryPerkStyleId, primary, secondary, shards,
      spells: Array.isArray(p.summonerSpellIds) ? p.summonerSpellIds.filter(Boolean) : [],
    };
  }
  return null;
}

// ---------- Spelerdata uit die kliënt (geen Riot API-sleutel nodig nie) ----------
// Die kliënt kan net spelers op jou eie bediener opsoek.
const EMPTY_PUUID = '00000000-0000-0000-0000-000000000000';
const okPuuid = (p) => typeof p === 'string' && p.length > 20 && p !== EMPTY_PUUID;

async function get(p) {
  const r = await request('GET', p);
  if (r.status === 0) { const e = new Error('The League client is not open.'); e.status = 503; e.lcuClosed = true; throw e; }
  if (r.timeout) { const e = new Error('The League client took too long to answer.'); e.status = 504; throw e; }
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

// Wedstrydgeskiedenis: die kliënt haal dit eers by Riot, so dit kan stadig wees (langer tydsbeperking).
const HISTORY_TIMEOUT_MS = Number(process.env.LCU_HISTORY_TIMEOUT_MS) || 15000;
async function getSlow(p) {
  const r = await request('GET', p, undefined, { timeout: HISTORY_TIMEOUT_MS });
  if (r.status === 0) { const e = new Error('The League client is not open.'); e.status = 503; e.lcuClosed = true; throw e; }
  if (r.timeout) { const e = new Error('The League client took too long to answer.'); e.status = 504; throw e; }
  if (!ok(r)) { const e = new Error((r.data && r.data.message) || `League client error ${r.status}`); e.status = r.status === 404 ? 404 : 502; e.lcuStatus = r.status; throw e; }
  return r.data;
}
const gamesOf = (d) => (d && d.games && Array.isArray(d.games.games) ? d.games.games
  : d && Array.isArray(d.games) ? d.games : []);

// Die kliënt hou die lys per speler in sy eie geheue: die EERSTE versoek se reeks bepaal hoeveel games dit hou,
// daarna ignoreer dit begIndex/endIndex en gee altyd dieselfde lys. Vra dus altyd die hele venster (0-49)
// en sny self 'n bladsy uit. Vir jouself: as daardie lys leeg is, ook die kliënt se eie "current-summoner"-roete.
const HISTORY_WINDOW = 50;
async function matchWindow(puuid, { self = false } = {}) {
  const q = `begIndex=0&endIndex=${HISTORY_WINDOW - 1}`;
  let games = [];
  let error = null;
  try { games = gamesOf(await getSlow(`/lol-match-history/v1/products/lol/${encodeURIComponent(puuid)}/matches?${q}`)); }
  catch (e) { if (e.lcuClosed || !self) throw e; error = e; }
  if (self && !games.length) {
    try { games = gamesOf(await getSlow(`/lol-match-history/v1/products/lol/current-summoner/matches?${q}`)); }
    catch (e) { throw e.lcuClosed ? e : (error || e); }
  }
  // Nuutste eerste, elke game een keer
  const seen = new Set();
  return games.filter((g) => g && g.gameId && !seen.has(g.gameId) && seen.add(g.gameId))
    .sort((a, b) => (b.gameCreation || 0) - (a.gameCreation || 0));
}
async function matchList(puuid, begIndex, endIndex, opts) {
  return (await matchWindow(puuid, opts)).slice(begIndex, endIndex + 1);
}

const game = (gameId) => getSlow(`/lol-match-history/v1/games/${Number(gameId)}`);

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
  state, importRunes, importItemSet, itemSetStatus, isBlitzSet, setSpells, identity,
  currentRunePage, isBlitzPage, isBlitzRunning, closeBlitz,
  installDir, writeShopItemSet, shopItemSetStatus, clearShopItemSets, clearShopItemSetsSync, removeBlitzShopFiles, removeAccountSets,
  lookupRiotId, summonerByPuuid, ranked, masteries, matchWindow, matchList, game, gameSession, okPuuid,
  recommendedPositions, recommendedPage,
  // vir die toetse
  _files: { shopSet, writeShopFiles, removeShopFiles, shopFilesStatus, shopFolders, mergeAccountSets, SHOP_FILE_PREFIX, SHOP_RANK },
};
