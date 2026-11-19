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

module.exports = { state, importRunes, importItemSet, setSpells };
