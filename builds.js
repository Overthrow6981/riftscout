// RiftScout build-data
// Versamel high-elo ranked wedstryde (Challenger/Grandmaster/Master), tel watter runes, items,
// skills en spells gespeel en gewen word per champion en rol, en gee aanbevelings.
// Word gebruik deur die app (server.js) en deur tools/collect.js (GitHub Actions).

const fs = require('fs');
const path = require('path');

const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const SLOT = { 1: 'Q', 2: 'W', 3: 'E', 4: 'R' };
const MAP_KEYS = ['runes', 'spells', 'start', 'core', 'boots', 'items', 'item4', 'item5', 'item6', 'maxOrder', 'skills'];
// Per lane-teenstander hou ons 'n kleiner stel by (genoeg vir 'n matchup-build)
const VS_KEYS = ['runes', 'spells', 'start', 'core', 'boots', 'items', 'maxOrder'];
const VS_MAP_LIMIT = 8;   // matchup-data klein hou sodat die gedeelde lêer nie te groot word nie
const LANE_MS = 15 * 60000; // lane-oorwinning = meer goud as jou lane-teenstander op 15 minute
const MATCHUP_MIN = 8;   // minimum wedstryde teen 'n champion voor ons 'n matchup-build gee
const SECTION_MIN = 3;   // minimum wedstryde vir 'n spesifieke keuse binne 'n matchup
const MAX_AGE_MS = 21 * 24 * 3600 * 1000; // net wedstryde van die laaste 3 weke
const KEEP_PATCHES = 3;
const MAP_LIMIT = 60;

const PLATFORM_ROUTE = {
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe', me1: 'europe',
  kr: 'asia', jp1: 'asia',
  oc1: 'sea', sg2: 'sea', tw2: 'sea', vn2: 'sea',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Items ----------
// items: { id: { name, gold, tags, into, requiredAlly } } (van Data Dragon item.json)
function itemsFromDDragon(itemJson) {
  const items = {};
  for (const [id, it] of Object.entries((itemJson && itemJson.data) || {})) {
    items[id] = {
      name: it.name,
      gold: (it.gold && it.gold.total) || 0,
      tags: it.tags || [],
      into: it.into || [],
      requiredAlly: it.requiredAlly || '',
    };
  }
  return items;
}

function itemClassifier(items) {
  const get = (id) => items[String(id)];
  const isBoots = (id) => {
    const it = get(id);
    return !!it && it.tags.includes('Boots') && Number(id) !== 1001 && it.gold >= 500;
  };
  const isCompleted = (id) => {
    const it = get(id);
    if (!it || isBoots(id)) return false;
    if (it.tags.includes('Consumable') || it.tags.includes('Trinket')) return false;
    const upgrades = it.into.filter((x) => { const u = get(x); return u && !u.requiredAlly; });
    return it.gold >= 1400 && upgrades.length === 0;
  };
  return { isBoots, isCompleted };
}

// ---------- Een wedstryd ontleed ----------
function patchOf(gameVersion) {
  const p = String(gameVersion || '').split('.');
  return p.length >= 2 ? `${p[0]}.${p[1]}` : 'unknown';
}

function comparePatch(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  return (pa[0] - pb[0]) || (pa[1] - pb[1]);
}

function runeKey(perks) {
  if (!perks || !perks.styles || perks.styles.length < 2) return null;
  const [pri, sub] = perks.styles;
  const sel = (s) => (s.selections || []).map((x) => x.perk);
  const p = sel(pri);
  const s = sel(sub);
  const sp = perks.statPerks || {};
  if (p.length !== 4 || s.length !== 2 || !sp.offense) return null;
  return `${pri.style}:${p.join(',')}|${sub.style}:${s.join(',')}|${sp.offense},${sp.flex},${sp.defense}`;
}

function parseRuneKey(key) {
  const [a, b, c] = key.split('|');
  const [ps, pp] = a.split(':');
  const [ss, sp] = b.split(':');
  return {
    primaryStyleId: Number(ps),
    subStyleId: Number(ss),
    primary: pp.split(',').map(Number),
    secondary: sp.split(',').map(Number),
    shards: c.split(',').map(Number),
  };
}

// Volgorde waarin Q/W/E gemax word, bv. "Q>E>W"
function maxOrder(seq) {
  if (seq.length < 9) return null;
  const count = { Q: 0, W: 0, E: 0 };
  const reach = {};
  seq.forEach((s, i) => {
    if (s in count) {
      count[s]++;
      if (count[s] === 5 && reach[s] == null) reach[s] = i;
    }
  });
  const score = (k) => (reach[k] != null ? reach[k] : 100 - count[k]);
  return ['Q', 'W', 'E'].sort((a, b) => score(a) - score(b)).join('>');
}

function analyzeMatch(match, timeline, cls) {
  const info = match.info;
  const purchases = {};
  const skills = {};
  const frames = (timeline && timeline.info && timeline.info.frames) || [];
  // Raam naaste aan 15:00 (raampies is elke minuut) vir die lane-goud
  let laneFrame = null;
  for (const f of frames) if (f.participantFrames && (f.timestamp || 0) <= LANE_MS + 30000) laneFrame = f;
  if (laneFrame && (laneFrame.timestamp || 0) < LANE_MS - 60000) laneFrame = null;
  const goldAt = (pid) => {
    const pf = laneFrame && laneFrame.participantFrames[pid];
    return pf && typeof pf.totalGold === 'number' ? pf.totalGold : null;
  };
  for (const frame of frames) {
    for (const ev of frame.events || []) {
      const pid = ev.participantId;
      if (ev.type === 'ITEM_PURCHASED') {
        (purchases[pid] || (purchases[pid] = [])).push({ id: ev.itemId, t: ev.timestamp });
      } else if (ev.type === 'ITEM_UNDO') {
        const list = purchases[pid] || [];
        for (let i = list.length - 1; i >= 0; i--) if (list[i].id === ev.beforeId) { list.splice(i, 1); break; }
      } else if (ev.type === 'SKILL_LEVEL_UP' && ev.levelUpType === 'NORMAL' && SLOT[ev.skillSlot]) {
        (skills[pid] || (skills[pid] = [])).push(SLOT[ev.skillSlot]);
      }
    }
  }
  const rows = [];
  const parts = info.participants || [];
  for (const p of parts) {
    const role = p.teamPosition;
    if (!ROLES.includes(role) || !p.championId) continue;
    const opp = parts.find((q) => q.teamId !== p.teamId && q.teamPosition === role);
    const buys = purchases[p.participantId] || [];
    const start = buys.filter((b) => b.t < 70000).map((b) => b.id).sort((a, b) => a - b);
    const completed = [];
    for (const b of buys) if (cls.isCompleted(b.id) && !completed.includes(b.id)) completed.push(b.id);
    const firstBoots = buys.find((b) => cls.isBoots(b.id));
    const seq = skills[p.participantId] || [];
    const g1 = goldAt(p.participantId);
    const g2 = opp ? goldAt(opp.participantId) : null;
    rows.push({
      championId: p.championId,
      role,
      vs: opp && opp.championId ? opp.championId : null,
      win: !!p.win,
      laneWin: g1 != null && g2 != null && g1 !== g2 ? g1 > g2 : null,
      runes: runeKey(p.perks),
      spells: [p.summoner1Id, p.summoner2Id].sort((a, b) => a - b).join(','),
      start: start.length ? start.join(',') : null,
      completed,
      boots: firstBoots ? firstBoots.id : null,
      maxOrder: maxOrder(seq),
      skills: seq.length >= 11 ? seq.slice(0, 15).join('') : null,
    });
  }
  return rows;
}

// ---------- Databasis ----------
function emptyRole() {
  const r = { games: 0, wins: 0, vs: {} };
  for (const k of MAP_KEYS) r[k] = {};
  return r;
}
function emptyMatchup() {
  const r = { games: 0, wins: 0 };
  for (const k of VS_KEYS) r[k] = {};
  return r;
}

function bump(map, key, win, n = 1, w = win ? 1 : 0) {
  if (key == null || key === '') return;
  const e = map[key] || (map[key] = [0, 0]);
  e[0] += n;
  e[1] += w;
}

function mergeRole(target, src) {
  target.games += src.games || 0;
  target.wins += src.wins || 0;
  if (src.lane) bump(target, 'lane', false, src.lane[0], src.lane[1]);
  for (const k of MAP_KEYS) for (const [key, [n, w]] of Object.entries(src[k] || {})) bump(target[k], key, false, n, w);
  for (const [opp, m] of Object.entries(src.vs || {})) {
    const t = target.vs[opp] || (target.vs[opp] = emptyMatchup());
    t.games += m.games || 0;
    t.wins += m.wins || 0;
    if (m.lane) bump(t, 'lane', false, m.lane[0], m.lane[1]);
    for (const k of VS_KEYS) for (const [key, [n, w]] of Object.entries(m[k] || {})) bump(t[k], key, false, n, w);
  }
}

function prune(map, limit = MAP_LIMIT) {
  const keys = Object.keys(map);
  if (keys.length <= limit * 2) return map;
  const out = {};
  for (const [k, v] of Object.entries(map).sort((a, b) => b[1][0] - a[1][0]).slice(0, limit)) out[k] = v;
  return out;
}

class BuildDB {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, matches: 0, updated: 0, patches: {} };
    this.remote = null; // gedeelde data (van GitHub)
    this.dirty = 0;
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d && d.patches) this.data = d;
    } catch { /* nuwe databasis */ }
  }

  addMatch(patch, rows) {
    const P = this.data.patches[patch] || (this.data.patches[patch] = { matches: 0, champs: {} });
    P.matches++;
    this.data.matches++;
    for (const r of rows) {
      const C = P.champs[r.championId] || (P.champs[r.championId] = {});
      const s = C[r.role] || (C[r.role] = emptyRole());
      s.games++;
      if (r.win) s.wins++;
      if (r.laneWin != null) bump(s, 'lane', r.laneWin);
      bump(s.runes, r.runes, r.win);
      bump(s.spells, r.spells, r.win);
      bump(s.start, r.start, r.win);
      bump(s.boots, r.boots, r.win);
      bump(s.maxOrder, r.maxOrder, r.win);
      bump(s.skills, r.skills, r.win);
      if (r.completed.length >= 3) bump(s.core, r.completed.slice(0, 3).join('-'), r.win);
      r.completed.forEach((id) => bump(s.items, id, r.win));
      ['item4', 'item5', 'item6'].forEach((k, i) => bump(s[k], r.completed[3 + i], r.win));
      if (r.vs) {
        if (!s.vs) s.vs = {};
        const m = s.vs[r.vs] || (s.vs[r.vs] = emptyMatchup());
        m.games++;
        if (r.win) m.wins++;
        if (r.laneWin != null) bump(m, 'lane', r.laneWin);
        bump(m.runes, r.runes, r.win);
        bump(m.spells, r.spells, r.win);
        bump(m.start, r.start, r.win);
        bump(m.boots, r.boots, r.win);
        bump(m.maxOrder, r.maxOrder, r.win);
        if (r.completed.length >= 3) bump(m.core, r.completed.slice(0, 3).join('-'), r.win);
        r.completed.forEach((id) => bump(m.items, id, r.win));
      }
    }
    this.dirty++;
  }

  // Die nuutste patches oor plaaslike en gedeelde data saam
  recentPatches(n = 2) {
    const all = new Set(Object.keys(this.data.patches));
    if (this.remote) Object.keys(this.remote.patches || {}).forEach((p) => all.add(p));
    return [...all].filter((p) => p !== 'unknown').sort(comparePatch).reverse().slice(0, n);
  }

  statsFor(championId, role, nPatches = 2) {
    const patches = this.recentPatches(nPatches);
    const acc = emptyRole();
    for (const src of [this.data, this.remote]) {
      if (!src) continue;
      for (const p of patches) {
        const s = src.patches && src.patches[p] && src.patches[p].champs[championId] && src.patches[p].champs[championId][role];
        if (s) mergeRole(acc, s);
      }
    }
    return { stats: acc, patches };
  }

  // Een champion se games oor verskeie rolle saam (bv. Darius in Top + Jungle + Mid) – items hang meer van die champion af as van die rol
  statsForRoles(championId, roles, nPatches = 2) {
    const acc = emptyRole();
    for (const r of roles) mergeRole(acc, this.statsFor(championId, r, nPatches).stats);
    return acc;
  }

  // Alle champions in 'n rol met hul algehele wen- en lane-syfers (vir 'n "beste keuses"-lys)
  roleTable(role, nPatches = 2) {
    const patches = this.recentPatches(nPatches);
    const out = {};
    for (const src of [this.data, this.remote]) {
      if (!src) continue;
      for (const p of patches) {
        const champs = (src.patches && src.patches[p] && src.patches[p].champs) || {};
        for (const [id, C] of Object.entries(champs)) {
          const s = C[role];
          if (!s) continue;
          const o = out[id] || (out[id] = { championId: Number(id), games: 0, wins: 0, laneGames: 0, laneWins: 0 });
          o.games += s.games || 0;
          o.wins += s.wins || 0;
          if (s.lane) { o.laneGames += s.lane[0]; o.laneWins += s.lane[1]; }
        }
      }
    }
    return Object.values(out);
  }

  rolesFor(championId) {
    const patches = this.recentPatches();
    const games = {};
    for (const src of [this.data, this.remote]) {
      if (!src) continue;
      for (const p of patches) {
        const c = src.patches && src.patches[p] && src.patches[p].champs[championId];
        if (c) for (const [role, s] of Object.entries(c)) games[role] = (games[role] || 0) + (s.games || 0);
      }
    }
    return Object.entries(games).map(([role, g]) => ({ role, games: g })).sort((a, b) => b.games - a.games);
  }

  save() {
    const patches = Object.keys(this.data.patches).sort(comparePatch).reverse();
    for (const p of patches.slice(KEEP_PATCHES)) delete this.data.patches[p];
    // Builds gebruik net die nuutste 2 patches; ouer patches hou net matchup-wenkoerse (kleiner lêer)
    const fullVs = new Set(patches.filter((p) => p !== 'unknown').slice(0, 2));
    for (const [name, P] of Object.entries(this.data.patches)) {
      for (const C of Object.values(P.champs)) {
        for (const s of Object.values(C)) {
          for (const k of MAP_KEYS) s[k] = prune(s[k]);
          for (const m of Object.values(s.vs || {})) {
            for (const k of VS_KEYS) {
              if (fullVs.has(name)) m[k] = prune(m[k], VS_MAP_LIMIT);
              else delete m[k];
            }
          }
        }
      }
    }
    this.data.updated = Date.now();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
    this.dirty = 0;
  }
}

class SeenSet {
  constructor(file, limit = 150000) {
    this.file = file;
    this.limit = limit;
    this.set = new Set();
    try { for (const id of JSON.parse(fs.readFileSync(file, 'utf8'))) this.set.add(id); } catch { /* leeg */ }
  }
  has(id) { return this.set.has(id); }
  add(id) { this.set.add(id); }
  get size() { return this.set.size; }
  save() {
    let arr = [...this.set];
    if (arr.length > this.limit) { arr = arr.slice(-this.limit); this.set = new Set(arr); }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(arr));
  }
}

// ---------- Aanbevelings ----------
function top(map, k = 3) {
  return Object.entries(map || {})
    .map(([key, [n, w]]) => ({ key, n, w }))
    .sort((a, b) => b.n - a.n || b.w / b.n - a.w / a.n)
    .slice(0, k);
}
const nums = (key, sep = ',') => key.split(sep).map(Number);

// Opsies vir die 4de–6de item (die eerste 8; ná die kern-build word dit tot 3 gesny)
const lateOptions = (map) => top(map, 8).map((e) => ({ ...e, id: Number(e.key) }));

function recommend(s, vsId) {
  const rec = {
    games: s.games,
    wins: s.wins,
    lane: s.lane || null,
    runes: top(s.runes, 3).map((e) => ({ ...e, page: parseRuneKey(e.key) })),
    spells: top(s.spells, 2).map((e) => ({ ...e, ids: nums(e.key) })),
    start: top(s.start, 2).map((e) => ({ ...e, ids: nums(e.key) })),
    boots: top(s.boots, 3).map((e) => ({ ...e, id: Number(e.key) })),
    core: top(s.core, 3).map((e) => ({ ...e, ids: nums(e.key, '-') })),
    item4: lateOptions(s.item4),
    item5: lateOptions(s.item5),
    item6: lateOptions(s.item6),
    items: top(s.items, 10).map((e) => ({ ...e, id: Number(e.key) })),
    maxOrder: top(s.maxOrder, 2),
    skills: top(s.skills, 1),
    vs: null,
    fromMatchup: [],
  };
  // Matchup-build: gebruik die keuses teen hierdie spesifieke teenstander waar daar genoeg data is
  const m = vsId && s.vs ? s.vs[vsId] : null;
  if (m) {
    rec.vs = { championId: Number(vsId), games: m.games, wins: m.wins, lane: m.lane || null };
    if (m.games >= MATCHUP_MIN) {
      const use = (key, list) => {
        if (list.length && list[0].n >= SECTION_MIN) { rec[key] = list; rec.fromMatchup.push(key); }
      };
      use('runes', top(m.runes, 3).map((e) => ({ ...e, page: parseRuneKey(e.key) })));
      use('spells', top(m.spells, 2).map((e) => ({ ...e, ids: nums(e.key) })));
      use('start', top(m.start, 2).map((e) => ({ ...e, ids: nums(e.key) })));
      use('boots', top(m.boots, 3).map((e) => ({ ...e, id: Number(e.key) })));
      use('core', top(m.core, 3).map((e) => ({ ...e, ids: nums(e.key, '-') })));
      use('items', top(m.items, 10).map((e) => ({ ...e, id: Number(e.key) })));
      use('maxOrder', top(m.maxOrder, 2));
    }
  }
  // Items wat reeds in die kern-build is, koop jy nie weer as 4de–6de item nie
  const inCore = new Set(rec.core[0] ? rec.core[0].ids : []);
  for (const k of ['item4', 'item5', 'item6']) rec[k] = rec[k].filter((e) => !inCore.has(e.id)).slice(0, 3);
  return rec;
}

// ---------- Items vir champions met min eie games ----------
// 'n Champion se item-profiel: hoe gereeld hy elke voltooide item koop (0..1)
function itemProfile(s) {
  const v = {};
  let norm = 0;
  for (const [id, [n]] of Object.entries(s.items || {})) {
    const f = n / Math.max(1, s.games);
    v[id] = f;
    norm += f * f;
  }
  return { v, norm: Math.sqrt(norm), games: s.games || 0 };
}

// Hoe eenders twee champions items koop (cosinus, 0..1)
function profileSimilarity(a, b) {
  if (!a || !b || !a.norm || !b.norm) return 0;
  let dot = 0;
  for (const [k, x] of Object.entries(a.v)) if (b.v[k]) dot += x * b.v[k];
  return dot / a.norm / b.norm;
}

// Vir 'n heeltemal nuwe champion sonder enige games: eenderse klas, reikafstand, mana en AD/AP
function metaSimilarity(A, B) {
  if (!A || !B) return 0;
  const ta = A.tags || [], tb = B.tags || [];
  let s = 0;
  if (ta[0] && ta[0] === tb[0]) s += 3;
  else if (ta.includes(tb[0]) || tb.includes(ta[0])) s += 1.5;
  if (ta[1] && ta[1] === tb[1]) s += 1.5;
  if (A.range != null && B.range != null && (A.range >= 300) === (B.range >= 300)) s += 2;
  if ((A.partype === 'Mana') === (B.partype === 'Mana')) s += 1;
  const lean = (c) => (c.info && c.info.attack + c.info.magic ? (c.info.attack - c.info.magic) / (c.info.attack + c.info.magic) : 0);
  s += 2 * (1 - Math.abs(lean(A) - lean(B)) / 2);
  return s;
}

// Tel syfers saam met 'n gewig per bron; die tellings word weer heelgetalle
const ITEM_KEYS = ['start', 'core', 'boots', 'items', 'item4', 'item5', 'item6'];
function weightedMerge(list) {
  const acc = emptyRole();
  for (const { s, w } of list) {
    if (!s || !w) continue;
    acc.games += (s.games || 0) * w;
    acc.wins += (s.wins || 0) * w;
    for (const k of ITEM_KEYS) for (const [key, [n, ww]] of Object.entries(s[k] || {})) {
      const e = acc[k][key] || (acc[k][key] = [0, 0]);
      e[0] += n * w;
      e[1] += ww * w;
    }
  }
  acc.games = Math.round(acc.games);
  acc.wins = Math.round(acc.wins);
  for (const k of ITEM_KEYS) for (const [key, e] of Object.entries(acc[k])) {
    e[0] = Math.round(e[0]); e[1] = Math.round(e[1]);
    if (e[0] < 1) delete acc[k][key];
  }
  return acc;
}

// Hoe goed doen hierdie champion teen elke lane-teenstander
function matchups(s, minGames = 5) {
  return Object.entries(s.vs || {})
    .filter(([, m]) => m.games >= minGames)
    .map(([id, m]) => ({
      championId: Number(id), games: m.games, wins: m.wins, wr: m.wins / m.games,
      laneGames: m.lane ? m.lane[0] : 0, laneWins: m.lane ? m.lane[1] : 0,
    }));
}

// Wenkoers getrek na 50% as daar min games is, sodat 'n paar gelukkige games nie bo 'n bewese wenkoers eindig nie
const SMOOTH = 20; // soos 20 ekstra games op 50%: 3 uit 3 kom nie bo 60 uit 100 nie
const smoothed = (wins, games) => (wins + SMOOTH / 2) / (games + SMOOTH);

// Watter champions wen die meeste teen 'n vyand in 'n rol (counter-picks), met game- en lane-wenkoers
function counterPicks(enemyStats, minGames = 5, k = 8) {
  return matchups(enemyStats, minGames)
    .map((x) => {
      const wins = x.games - x.wins;
      const laneWins = x.laneGames - x.laneWins;
      return {
        championId: x.championId, games: x.games, wins, wr: wins / x.games, score: smoothed(wins, x.games),
        laneGames: x.laneGames, laneWr: x.laneGames ? laneWins / x.laneGames : null,
        laneScore: x.laneGames ? smoothed(laneWins, x.laneGames) : null,
      };
    })
    .sort((a, b) => b.score - a.score || b.games - a.games)
    .slice(0, k);
}

// Sterkste champions in 'n rol oor die algemeen (as daar nog te min data teen 'n spesifieke vyand is)
function bestInRole(table, minGames = 20, k = 10, exclude = []) {
  return table
    .filter((x) => x.games >= minGames && !exclude.includes(x.championId))
    .map((x) => ({
      championId: x.championId, games: x.games, wins: x.wins, wr: x.wins / x.games, score: smoothed(x.wins, x.games),
      laneGames: x.laneGames, laneWr: x.laneGames ? x.laneWins / x.laneGames : null,
      laneScore: x.laneGames ? smoothed(x.laneWins, x.laneGames) : null,
    }))
    .sort((a, b) => b.score - a.score || b.games - a.games)
    .slice(0, k);
}

// Raai elke vyand se rol uit hoe gereeld die champion elke rol speel (beste algehele toewysing)
function guessRoles(roleGames) { // roleGames: [{ championId, roles: { TOP: n, ... } }]
  const champs = roleGames.slice(0, 5);
  let best = null;
  const used = new Set();
  const assign = {};
  const prob = (c, role) => {
    const total = Object.values(c.roles).reduce((a, b) => a + b, 0);
    return total ? (c.roles[role] || 0) / total : 0.2;
  };
  (function search(i, score) {
    if (i === champs.length) {
      if (!best || score > best.score) best = { score, assign: { ...assign } };
      return;
    }
    for (const role of ROLES) {
      if (used.has(role)) continue;
      used.add(role);
      assign[champs[i].championId] = role;
      search(i + 1, score + Math.log(prob(champs[i], role) + 0.001));
      used.delete(role);
      delete assign[champs[i].championId];
    }
  })(0, 0);
  return best ? best.assign : {};
}

// Volle bou-volgorde vir die oorleg en die item set: kern-items met stewels na die eerste item
function buildPath(rec) {
  const core = rec.core[0] ? rec.core[0].ids : rec.items.slice(0, 3).map((e) => e.id);
  const order = [];
  const add = (id) => { if (id && !order.includes(id)) order.push(id); };
  add(core[0]);
  if (rec.boots[0]) add(rec.boots[0].id);
  core.slice(1).forEach(add);
  for (const k of ['item4', 'item5', 'item6']) {
    const pick = (rec[k] || []).find((e) => !order.includes(e.id));
    if (pick) order.push(pick.id);
  }
  return order;
}

// ---------- Versamelaar ----------
class Crawler {
  constructor({ riot, db, seen, getRegion, getClassifier, hasKey, isUserBusy, paceMs = 1700, autoSave = true, log = () => {} }) {
    Object.assign(this, { riot, db, seen, getRegion, getClassifier, hasKey, isUserBusy, paceMs, autoSave, log });
    this.running = false;
    this.state = 'idle';
    this.lastError = null;
    this.session = 0;
    this.players = [];
    this.queue = [];
    this.region = null;
    this.loopPromise = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastError = null;
    this.loopPromise = this.loop();
  }

  async stop() {
    this.running = false;
    this.state = 'stopped';
    // Wag kort vir die huidige versoek; moenie vashaak as die rate limiter nog wag nie
    if (this.loopPromise) await Promise.race([this.loopPromise, sleep(5000)]);
  }

  status() {
    return {
      running: this.running, state: this.state, lastError: this.lastError,
      session: this.session, region: this.region, analysed: this.db.data.matches,
    };
  }

  async call(route, p) {
    if (this.paceMs) await sleep(this.paceMs);
    return this.riot(route, p);
  }

  async loop() {
    while (this.running) {
      try {
        if (!this.hasKey()) { this.state = 'waiting for API key'; await sleep(5000); continue; }
        const cls = this.getClassifier();
        if (!cls) { this.state = 'loading item data'; await sleep(5000); continue; }
        if (this.isUserBusy()) { this.state = 'paused while you search'; await sleep(2000); continue; }
        const region = this.getRegion();
        if (region !== this.region) { this.region = region; this.players = []; this.queue = []; }
        if (!this.queue.length) { await this.refill(); continue; }
        this.state = 'collecting';
        await this.processMatch(this.queue.shift(), cls);
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          this.lastError = 'Riot API key expired or invalid - paste a new key under Settings.';
          this.running = false;
          this.state = 'stopped';
          break;
        }
        if (err.status === 404) continue;
        this.lastError = err.message;
        this.log('crawler: ' + err.message);
        await sleep(10000);
      }
    }
    if (this.autoSave) this.save();
  }

  async refill() {
    if (!this.players.length) {
      this.state = 'finding top players';
      const list = [];
      for (const tier of ['challengerleagues', 'grandmasterleagues', 'masterleagues']) {
        const lg = await this.call(this.region, `/lol/league/v4/${tier}/by-queue/RANKED_SOLO_5x5`);
        for (const e of (lg && lg.entries) || []) if (e.puuid) list.push(e.puuid);
        if (list.length >= 400) break;
      }
      for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
      this.players = list;
      if (!list.length) throw new Error('No ranked players found for this region.');
    }
    const puuid = this.players.shift();
    const ids = await this.call(PLATFORM_ROUTE[this.region], `/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&type=ranked&start=0&count=20`);
    for (const id of ids || []) if (!this.seen.has(id) && !this.queue.includes(id)) this.queue.push(id);
  }

  async processMatch(id, cls) {
    const route = PLATFORM_ROUTE[this.region];
    this.seen.add(id);
    const match = await this.call(route, `/lol/match/v5/matches/${encodeURIComponent(id)}`);
    const info = (match && match.info) || {};
    if (info.queueId !== 420 || Date.now() - (info.gameCreation || 0) > MAX_AGE_MS || (info.gameDuration || 0) < 900) return;
    const timeline = await this.call(route, `/lol/match/v5/matches/${encodeURIComponent(id)}/timeline`);
    this.db.addMatch(patchOf(info.gameVersion), analyzeMatch(match, timeline, cls));
    const R = this.db.data.regions || (this.db.data.regions = {}); // van watter bedieners die data kom
    R[this.region] = (R[this.region] || 0) + 1;
    this.session++;
    if (this.autoSave && this.db.dirty >= 10) this.save();
  }

  save() {
    try { this.db.save(); this.seen.save(); } catch (err) { this.log('save failed: ' + err.message); }
  }
}

module.exports = {
  ROLES, PLATFORM_ROUTE, itemsFromDDragon, itemClassifier, analyzeMatch, patchOf, comparePatch,
  runeKey, parseRuneKey, maxOrder, BuildDB, SeenSet, Crawler, recommend, buildPath,
  matchups, counterPicks, bestInRole, guessRoles, MATCHUP_MIN, KEEP_PATCHES,
  itemProfile, profileSimilarity, metaSimilarity, weightedMerge,
};
