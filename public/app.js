// RiftScout frontend
const CDN = 'https://ddragon.leagueoflegends.com/cdn';
const QUEUES = {
  400: 'Normal Draft', 420: 'Ranked Solo', 430: 'Normal Blind', 440: 'Ranked Flex', 450: 'ARAM',
  480: 'Swiftplay', 490: 'Quickplay', 700: 'Clash', 720: 'ARAM Clash', 900: 'ARURF', 1020: 'One for All',
  1300: 'Nexus Blitz', 1700: 'Arena', 1710: 'Arena', 1900: 'URF', 830: 'Co-op vs AI', 840: 'Co-op vs AI',
  850: 'Co-op vs AI', 870: 'Co-op vs AI', 880: 'Co-op vs AI', 890: 'Co-op vs AI', 0: 'Custom',
};

let dd = null;                 // Data Dragon data
let current = null;            // { region, profile }
let loadedMatches = [];
let nextStart = 0;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

// ---------- Data Dragon ----------
async function loadDDragon() {
  try {
    const r = await fetch('/api/ddragon');
    if (r.ok) { dd = await r.json(); return; }
  } catch { /* val terug na direkte laai */ }
  try {
    const versions = await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json();
    dd = { version: versions[0], spells: {}, runes: {}, champions: {}, items: {} };
  } catch {
    dd = { version: '15.1.1', spells: {}, runes: {}, champions: {}, items: {} };
  }
}
const champImg = (name) => `${CDN}/${dd.version}/img/champion/${encodeURIComponent(name)}.png`;
// Match-data se championName verskil soms van Data Dragon (bv. "FiddleSticks"), so gebruik die ID waar moontlik
const champImgFor = (p) => champImg((dd.champions[p.championId] && dd.champions[p.championId].id) || p.championName);
const ARENA = new Set([1700, 1710]);
const itemImg = (id) => `${CDN}/${dd.version}/img/item/${id}.png`;
const iconImg = (id) => `${CDN}/${dd.version}/img/profileicon/${id}.png`;
const spellImg = (key) => dd.spells[key] ? `${CDN}/${dd.version}/img/spell/${dd.spells[key].image}` : '';
const runeImg = (id) => dd.runes[id] ? `${CDN}/img/${dd.runes[id].icon}` : '';

// ---------- Hulp ----------
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const fmtDur = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const kdaRatio = (k, d, a) => (d === 0 ? 'Perfect' : ((k + a) / d).toFixed(2));
const pct = (x) => `${Math.round(x * 100)}%`;
const ordinal = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
function showMessage(text, isError = false) {
  const m = $('message');
  if (!text) { m.classList.add('hidden'); return; }
  m.textContent = text;
  m.className = 'notice' + (isError ? ' error' : '');
}
async function api(url) {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
  return body;
}

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
  })
);

// ---------- Profiel ----------
$('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const riotId = $('riotId').value.trim();
  // Soek jy iemand anders, laai ons nie later outomaties jou eie profiel oor hulle s'n nie
  viewingOther = !mine || riotId.toLowerCase() !== mine.riotId.toLowerCase() || $('region').value !== mine.region;
  search($('region').value, riotId);
});

// ---------- Jou rekening: naam en bediener kom vanself uit die League-kliënt ----------
let mine = null;          // { riotId, region, connected, ... }
let viewingOther = false;
let autoLoadedKey = '';
const REGION_LABEL = Object.fromEntries([...$('region').options].map((o) => [o.value, o.textContent]));

async function pollMe() {
  let m;
  try { m = await api('/api/me'); } catch { return; }
  $('meHint').classList.toggle('hidden', !!(m.riotId && m.region) && (hasKey || m.connected || !!current));
  if (!m.riotId || !m.region) { $('meChip').classList.add('hidden'); return; }
  mine = m;
  $('meName').textContent = m.riotId;
  $('meRegion').textContent = REGION_LABEL[m.region] || m.region.toUpperCase();
  $('meIcon').src = m.profileIconId != null && dd.version ? iconImg(m.profileIconId) : '';
  $('meDot').classList.toggle('on', !!m.connected);
  $('meChip').title = (m.connected ? 'Signed in to League as ' : 'Last League account: ') + m.riotId + ' — click to open your profile';
  $('meChip').classList.remove('hidden');
  const key = `${m.region}:${m.riotId.toLowerCase()}`;
  if (key === autoLoadedKey || viewingOther) return;
  $('region').value = m.region;
  $('riotId').value = m.riotId;
  // Sonder sleutel kom die profiel uit League self, so wag tot League oop is
  if (!hasKey && !m.connected) return;
  autoLoadedKey = key;
  search(m.region, m.riotId);
}

$('meChip').addEventListener('click', () => {
  if (!mine) return;
  viewingOther = false;
  document.querySelector('.tab[data-tab="profile"]').click();
  $('region').value = mine.region;
  $('riotId').value = mine.riotId;
  search(mine.region, mine.riotId);
});

async function search(region, riotId) {
  if (!riotId.includes('#')) { showMessage('Enter a Riot ID like Name#TAG (the tag is after the #).', true); return; }
  const btn = $('searchForm').querySelector('button');
  btn.disabled = true;
  showMessage('Loading profile…');
  $('profile').innerHTML = $('summary').innerHTML = $('matches').innerHTML = '';
  $('loadMore').classList.add('hidden');
  store.set('lastRegion', region);
  store.set('lastRiotId', riotId);
  location.hash = `${region}/${encodeURIComponent(riotId)}`;
  try {
    const profile = await api(`/api/profile?region=${region}&riotId=${encodeURIComponent(riotId)}`);
    current = { region, profile };
    loadedMatches = [];
    nextStart = 0;
    renderProfile(profile);
    showMessage('Loading matches…');
    await loadMatches();
    showMessage('');
  } catch (err) {
    showMessage(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

function renderProfile(p) {
  const order = { RANKED_SOLO_5x5: 'Ranked Solo/Duo', RANKED_FLEX_SR: 'Ranked Flex' };
  const ranks = Object.keys(order).map((q) => {
    const e = p.ranked.find((r) => r.queueType === q);
    if (!e) return `<div class="rank"><div class="q">${order[q]}</div><div class="tier">Unranked</div></div>`;
    const games = e.wins + e.losses;
    const tier = e.tier.charAt(0) + e.tier.slice(1).toLowerCase();
    const showDiv = !['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(e.tier);
    return `<div class="rank"><div class="q">${order[q]}</div>
      <div class="tier">${tier}${showDiv ? ' ' + e.rank : ''} · ${e.leaguePoints} LP</div>
      <div class="wl">${e.wins}W ${e.losses}L · ${games ? pct(e.wins / games) : '–'} win rate${e.hotStreak ? ' · 🔥 streak' : ''}</div></div>`;
  }).join('');
  const mastery = p.mastery.map((m) => {
    const c = dd.champions[m.championId];
    if (!c) return '';
    return `<div class="m"><img src="${champImg(c.id)}" alt="${esc(c.name)}" title="${esc(c.name)}">
      M${m.level}<br>${(m.points / 1000).toFixed(0)}k</div>`;
  }).join('');

  $('profile').innerHTML = `
    <div class="card">
      <div class="profile-head">
        <div class="profile-icon"><img src="${iconImg(p.profileIconId)}" alt=""><span class="lvl">${p.level}</span></div>
        <div class="profile-name">${esc(p.gameName)} <span>#${esc(p.tagLine)}</span></div>
      </div>
      <div class="grid">${ranks}</div>
    </div>
    ${mastery ? `<div class="card"><h3>Top mastery</h3><div class="mastery">${mastery}</div></div>` : ''}`;
}

async function loadMatches() {
  const { region, profile } = current;
  const btn = $('loadMore');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const data = await api(`/api/matches?region=${region}&puuid=${profile.puuid}&start=${nextStart}&count=10`);
    nextStart += 10;
    loadedMatches.push(...data.matches);
    renderSummary();
    $('matches').insertAdjacentHTML('beforeend', data.matches.map(renderMatch).join(''));
    btn.classList.toggle('hidden', !data.hasMore);
    if (!loadedMatches.length) $('matches').innerHTML = '<div class="notice">No recent matches found.</div>';
  } catch (err) {
    showMessage(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load more';
  }
}
$('loadMore').addEventListener('click', loadMatches);

function renderSummary() {
  const games = loadedMatches.filter((m) => m.me && !m.remake);
  if (!games.length) { $('summary').innerHTML = ''; return; }
  const wins = games.filter((m) => m.me.win).length;
  let k = 0, d = 0, a = 0, kp = 0;
  const champs = {};
  for (const m of games) {
    k += m.me.kills; d += m.me.deaths; a += m.me.assists; kp += m.me.killParticipation;
    const c = (champs[m.me.championName] ||= { games: 0, wins: 0 });
    c.games++; if (m.me.win) c.wins++;
  }
  const n = games.length;
  const top = Object.entries(champs).sort((x, y) => y[1].games - x[1].games).slice(0, 3)
    .map(([name, s]) => [name, s, games.find((m) => m.me.championName === name).me]);
  $('summary').innerHTML = `
    <div class="card"><h3>Last ${n} games</h3>
      <div class="summary">
        <div><div class="big">${wins}W ${n - wins}L</div><div class="sub">${pct(wins / n)} win rate</div></div>
        <div><div class="big">${(k / n).toFixed(1)} / ${(d / n).toFixed(1)} / ${(a / n).toFixed(1)}</div>
          <div class="sub">${kdaRatio(k, d, a)} KDA · ${pct(kp / n)} kill participation</div></div>
        <div class="topchamps">${top.map(([name, s, p]) => `
          <div class="tc"><img src="${champImgFor(p)}" alt="" title="${esc(name)}">
            <div><b>${pct(s.wins / s.games)}</b><div class="sub">${s.wins}W ${s.games - s.wins}L</div></div></div>`).join('')}
        </div>
      </div>
    </div>`;
}

function renderMatch(m) {
  const me = m.me;
  if (!me) return '';
  const arena = ARENA.has(m.queueId);
  const won = arena && me.placement ? me.placement <= 4 : me.win; // Arena: top 4 = wen
  const cls = m.remake ? 'remake' : won ? 'win' : 'loss';
  const result = m.remake ? 'Remake' : arena && me.placement ? `${ordinal(me.placement)} place` : me.win ? 'Victory' : 'Defeat';
  const mins = m.duration / 60;
  const items = me.items.map((id) =>
    `<div class="it">${id ? `<img src="${itemImg(id)}" alt="" loading="lazy">` : ''}</div>`).join('');
  const spells = me.spells.map((s) => `<img src="${spellImg(s)}" alt="" title="${esc(dd.spells[s]?.name || '')}">`).join('');
  const runes = [me.keystone, me.secondaryStyle]
    .map((r) => runeImg(r) ? `<img src="${runeImg(r)}" alt="" title="${esc(dd.runes[r].name)}">` : '<img alt="">').join('');
  const playerRow = (p) => `
    <div class="p ${p.puuid === me.puuid ? 'me' : ''}"><img src="${champImgFor(p)}" alt="" loading="lazy">
      <a data-id="${esc(p.name + '#' + p.tag)}" title="${esc(p.name + '#' + p.tag)}">${esc(p.name)}</a></div>`;
  const team = (id) => m.players.filter((p) => p.teamId === id).map(playerRow).join('');
  // Arena: wys spanne volgens plek (1ste tot 8ste), twee per span
  const arenaTeams = () => {
    const byTeam = {};
    for (const p of m.players) (byTeam[p.subteam] ||= []).push(p);
    const sorted = Object.values(byTeam).sort((a, b) => (a[0].placement || 9) - (b[0].placement || 9));
    const half = Math.ceil(sorted.length / 2);
    const col = (list) => list.map((t) => t.map(playerRow).join('')).join('');
    return `<div>${col(sorted.slice(0, half))}</div><div>${col(sorted.slice(half))}</div>`;
  };
  const multi = { 2: 'Double Kill', 3: 'Triple Kill', 4: 'Quadra Kill', 5: 'Penta Kill' }[Math.min(me.largestMultiKill, 5)];

  return `
    <div class="match ${cls}">
      <div class="meta">
        <div class="queue">${QUEUES[m.queueId] || m.gameMode}</div>
        <div>${timeAgo(m.endedAt)}</div>
        <div class="result">${result}</div>
        <div>${fmtDur(m.duration)}</div>
      </div>
      <div class="mine">
        <div class="champ"><img src="${champImgFor(me)}" alt="${esc(me.championName)}"><span class="clvl">${me.champLevel}</span></div>
        <div class="spells">${spells}${runes}</div>
        <div class="kda">
          <div class="score">${me.kills} / <span class="d">${me.deaths}</span> / ${me.assists}</div>
          <div class="ratio">${kdaRatio(me.kills, me.deaths, me.assists)} KDA${multi ? ' · ' + multi : ''}</div>
        </div>
        <div class="stats">
          ${me.cs} CS (${mins ? (me.cs / mins).toFixed(1) : 0})<br>
          KP ${pct(me.killParticipation)}<br>
          ${me.vision} vision
        </div>
        <div class="items">${items}</div>
      </div>
      <div class="players">${arena ? arenaTeams() : `<div>${team(100)}</div><div>${team(200)}</div>`}</div>
    </div>`;
}

// Klik op 'n speler se naam in 'n wedstryd om hom op te soek
$('matches').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-id]');
  if (!a || !current) return;
  $('riotId').value = a.dataset.id;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  search(current.region, a.dataset.id);
});

// ---------- Live Game ----------
function liveChampId(p) {
  // rawChampionName lyk soos "game_character_displayname_MissFortune"
  const raw = p.rawChampionName || '';
  return raw.startsWith('game_character_displayname_') ? raw.slice('game_character_displayname_'.length) : (p.championName || '').replace(/[^A-Za-z]/g, '');
}

async function pollLive() {
  let state;
  try { state = await api('/api/live'); } catch { state = { inGame: false }; }
  $('liveDot').classList.toggle('on', !!state.inGame);
  if (!state.inGame) {
    $('live').innerHTML = `<div class="notice">${state.loading
      ? 'Game is loading… stats appear as soon as the match starts.'
      : 'Not in a game right now. Start a match (Practice Tool works too) and this page updates automatically.<br><br>Note: the live view only works when RiftScout runs on the same PC as League of Legends.'}</div>`;
    return;
  }
  renderLive(state.data);
}

function renderLive(data) {
  const players = data.allPlayers || [];
  const meName = data.activePlayer?.riotIdGameName || data.activePlayer?.summonerName || '';
  const kills = (team) => players.filter((p) => p.team === team).reduce((s, p) => s + (p.scores?.kills || 0), 0);
  const row = (p) => {
    const name = p.riotIdGameName || p.summonerName || '';
    const s = p.scores || {};
    const items = (p.items || []).sort((a, b) => a.slot - b.slot)
      .map((it) => `<div class="it"><img src="${itemImg(it.itemID)}" alt="" title="${esc(it.displayName)}"></div>`).join('');
    return `<div class="lp ${p.isDead ? 'dead' : ''} ${name === meName ? 'me' : ''}">
      <img class="c" src="${champImg(liveChampId(p))}" alt="">
      <div>
        <div class="n">${esc(name)} <small>${esc(p.championName)} · lvl ${p.level}${p.isDead ? ` · ☠ ${Math.ceil(p.respawnTimer)}s` : ''}</small></div>
        <div class="s">${s.kills ?? 0}/${s.deaths ?? 0}/${s.assists ?? 0} · ${s.creepScore ?? 0} CS · ${Math.round(s.wardScore ?? 0)} ward</div>
        <div class="items">${items}</div>
      </div>
    </div>`;
  };
  const events = (data.events?.Events || []).slice(-8).reverse().map((ev) => {
    const t = fmtDur(ev.EventTime);
    switch (ev.EventName) {
      case 'ChampionKill': return `<li>${t} · <b>${esc(ev.KillerName)}</b> killed <b>${esc(ev.VictimName)}</b></li>`;
      case 'DragonKill': return `<li>${t} · <b>${esc(ev.KillerName)}</b> took ${esc(ev.DragonType)} dragon</li>`;
      case 'BaronKill': return `<li>${t} · <b>${esc(ev.KillerName)}</b> took Baron</li>`;
      case 'HeraldKill': return `<li>${t} · <b>${esc(ev.KillerName)}</b> took Herald</li>`;
      case 'TurretKilled': return `<li>${t} · turret destroyed by <b>${esc(ev.KillerName)}</b></li>`;
      case 'InhibKilled': return `<li>${t} · inhibitor destroyed by <b>${esc(ev.KillerName)}</b></li>`;
      case 'Multikill': return `<li>${t} · <b>${esc(ev.KillerName)}</b> multikill x${ev.KillStreak}</li>`;
      case 'Ace': return `<li>${t} · <b>ACE</b> by ${esc(ev.Acer)}</li>`;
      case 'FirstBlood': return `<li>${t} · <b>First Blood</b> – ${esc(ev.Recipient)}</li>`;
      default: return '';
    }
  }).join('');
  const gold = data.activePlayer?.currentGold;

  $('live').innerHTML = `
    <div class="card live-head">
      <div><div class="sub">${esc(data.gameData?.gameMode || '')} · ${fmtDur(data.gameData?.gameTime || 0)}</div>
        <div class="live-score"><span class="blue">${kills('ORDER')}</span> – <span class="red">${kills('CHAOS')}</span></div></div>
      ${gold != null ? `<div><div class="sub">Your gold</div><div class="big" style="color:var(--gold)">${Math.floor(gold)}</div></div>` : ''}
    </div>
    <div class="teams">
      <div class="card team"><h3 class="blue">Blue team</h3>${players.filter((p) => p.team === 'ORDER').map(row).join('')}</div>
      <div class="card team"><h3 class="red">Red team</h3>${players.filter((p) => p.team === 'CHAOS').map(row).join('')}</div>
    </div>
    ${events ? `<div class="card"><h3>Recent events</h3><ul class="events">${events}</ul></div>` : ''}`;
}

// ---------- Lobby-scouting ----------
const TAG_CLASS = { 'Hot streak': 'hot', 'One-trick': 'otp', 'First time on champ': 'new', 'New on champ': 'new', 'Possible smurf': 'smurf' };
let lastLobbyKey = '';
let lobbyRegion = 'na1';

function rankHtml(p) {
  const r = p.solo || p.flex;
  if (!r) return '<span class="tier">Unranked</span>';
  const tier = r.tier.charAt(0) + r.tier.slice(1).toLowerCase();
  const div = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(r.tier) ? '' : ' ' + r.rank;
  const g = r.wins + r.losses;
  return `<span class="tier t-${r.tier.toLowerCase()}">${tier}${div}</span> ${r.lp} LP${p.solo ? '' : ' (Flex)'}
    · ${r.wins}W ${r.losses}L${g ? ` · <b class="${r.wins / g >= 0.5 ? 'good' : 'bad'}">${pct(r.wins / g)}</b>` : ''}`;
}

function lobbyCard(p) {
  const c = dd.champions[p.championId];
  const img = c ? `<img class="c" src="${champImg(c.id)}" alt="${esc(c.name)}" title="${esc(c.name)}">` : '<div class="c empty"></div>';
  const role = p.role ? `<small>${esc(ROLE_NAMES[p.role] || p.role)}</small>` : '';
  if (p.hidden) {
    return `<div class="pc hidden-name">${img}<div class="pi"><div class="pn">Hidden player ${role}</div>
      <div class="ps">Riot hides names in ranked champ select — full scouting starts on the loading screen.</div></div></div>`;
  }
  const mastery = p.mastery ? (p.mastery.points ? `${c ? esc(c.name) + ' ' : ''}mastery ${(p.mastery.points / 1000).toFixed(p.mastery.points < 10000 ? 1 : 0)}k` : `Never played ${c ? esc(c.name) : 'this champ'}`) : '';
  const tags = (p.tags || []).map((t) => `<span class="pill ${TAG_CLASS[t] || ''}">${esc(t)}</span>`).join('');
  return `<div class="pc ${p.me ? 'me' : ''} ${p.opp ? 'opp' : ''}">${img}
    <div class="pi">
      <div class="pn"><a href="#" data-riot="${esc(p.riotId)}">${esc(p.riotId || 'Unknown')}</a> ${role}${p.me ? ' <span class="pill you">You</span>' : ''}${p.opp ? ' <span class="pill lane">Your lane</span>' : ''}</div>
      <div class="pr">${rankHtml(p)}</div>
      <div class="ps">${p.level != null ? `Level ${p.level}` : ''}${mastery ? ' · ' + mastery : ''}</div>
      ${tags ? `<div class="tags">${tags}</div>` : ''}
    </div></div>`;
}

const ROLE_ORDER = { TOP: 0, JUNGLE: 1, MIDDLE: 2, BOTTOM: 3, UTILITY: 4 };
function renderLobby(l) {
  lobbyRegion = l.region || lobbyRegion;
  const teams = l.teams || [];
  if (!teams.length) {
    $('lobby').innerHTML = `<div class="notice">${l.error ? esc(l.error) : l.waiting
      ? 'Game found — waiting for Riot to list the players (usually a few seconds into the loading screen)…'
      : 'No lobby right now. In champ select you see your team here; from the loading screen on, all 10 players with rank, win rate and mastery on their champion.'}</div>`;
    return;
  }
  const head = l.phase === 'ChampSelect'
    ? `<div class="notice">Champ select · your team${l.hiddenNames ? ' — names are hidden by Riot in this queue, so only you are scouted until the game loads.' : ''}</div>`
    : l.stale ? '<div class="notice">Your last game\'s lobby.</div>' : '';
  const team = (t) => {
    const ps = [...t.players].sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));
    const label = l.phase === 'ChampSelect' ? 'Your team' : (t.mine ? 'Your team' : 'Enemy team');
    return `<div class="card team"><h3 class="${t.teamId === 100 ? 'blue' : 'red'}">${label}</h3>${ps.map(lobbyCard).join('')}</div>`;
  };
  $('lobby').innerHTML = head + `<div class="teams ${teams.length === 1 ? 'one' : ''}">${teams.map(team).join('')}</div>
    <p class="hint">Tags: <b>One-trick</b> 300k+ mastery · <b>New on champ</b> under 10k · <b>Possible smurf</b> low level with a very high win rate. Ranked stats are Solo/Duo (or Flex when they have no Solo rank).</p>`;
}

$('lobby').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-riot]');
  if (!a || !a.dataset.riot) return;
  e.preventDefault();
  viewingOther = true;
  $('region').value = lobbyRegion;
  $('riotId').value = a.dataset.riot;
  document.querySelector('.tab[data-tab="profile"]').click();
  search(lobbyRegion, a.dataset.riot);
});

async function pollLobby() {
  let l;
  try { l = await api('/api/lobby'); } catch (err) { l = { teams: [], error: err.message }; }
  const active = (l.teams || []).length > 0 && !l.stale;
  $('lobbyDot').classList.toggle('on', active);
  renderLobby(l);
  // Spring een keer per spel na die Lobby-oortjie sodra die laaiskerm begin
  if (l.phase === 'InGame' && !l.stale) {
    const key = String(l.gameId || l.at);
    if (key !== lastLobbyKey) { lastLobbyKey = key; document.querySelector('.tab[data-tab="lobby"]').click(); }
  }
}

// ---------- Instellings ----------
let hasKey = false;
async function openSettings() {
  $('settingsMsg').textContent = '';
  $('settingsMsg').className = 'hint';
  $('keyState').textContent = hasKey ? '✓ A Riot API key is saved. Paste a new one below to replace it.' : 'No key saved – that\'s fine.';
  $('keyState').className = 'hint ' + (hasKey ? 'ok' : '');
  $('removeKey').classList.toggle('hidden', !hasKey);
  try {
    const p = await api('/api/prefs');
    $('prefCollect').checked = p.collectBuilds;
    $('prefRegion').value = p.crawlRegion;
    $('prefAuto').checked = p.autoImport;
    $('prefReplace').checked = p.replaceRunePage;
    $('prefOverlay').checked = p.overlay;
    $('prefPos').value = p.overlayPosition;
  } catch { /* gebruik wat daar is */ }
  $('settings').classList.remove('hidden');
}
async function postJson(url, data) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'Could not save.');
  return body;
}
function setHasKey(v) {
  hasKey = v;
}
$('settingsBtn').addEventListener('click', openSettings);
$('settingsCancel').addEventListener('click', () => $('settings').classList.add('hidden'));
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').classList.add('hidden'); });
$('removeKey').addEventListener('click', async () => {
  try { setHasKey((await postJson('/api/settings', { apiKey: '' })).hasKey); openSettings(); } catch (err) { $('settingsMsg').textContent = err.message; }
});
$('settingsSave').addEventListener('click', async () => {
  const msg = $('settingsMsg');
  try {
    const key = $('apiKey').value.trim();
    if (key) setHasKey((await postJson('/api/settings', { apiKey: key })).hasKey);
    await postJson('/api/prefs', {
      collectBuilds: $('prefCollect').checked,
      crawlRegion: $('prefRegion').value,
      autoImport: $('prefAuto').checked,
      replaceRunePage: $('prefReplace').checked,
      overlay: $('prefOverlay').checked,
      overlayPosition: $('prefPos').value,
    });
    $('apiKey').value = '';
    msg.textContent = 'Settings saved.';
    msg.className = 'hint ok';
    pollBuildStatus();
    setTimeout(() => $('settings').classList.add('hidden'), 900);
    // Nuwe sleutel en ons ken jou rekening al: wys dadelik jou profiel
    if (key && hasKey && mine && !viewingOther && !current) { autoLoadedKey = `${mine.region}:${mine.riotId.toLowerCase()}`; search(mine.region, mine.riotId); }
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'hint err';
  }
});

// ---------- Builds ----------
const ROLE_NAMES = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support' };
const SHARDS = {
  5008: 'Adaptive force', 5005: 'Attack speed', 5007: 'Ability haste', 5010: 'Move speed',
  5001: 'Health scaling', 5011: 'Health', 5013: 'Tenacity', 5002: 'Armor', 5003: 'Magic resist',
};
let buildChamp = 0;
let buildData = null;
const champName = (id) => (dd.champions[id] ? dd.champions[id].name : `Champion ${id}`);
const champIcon = (id) => champImg(dd.champions[id] ? dd.champions[id].id : '');
let lcuConnected = false;
const itemName = (id) => (dd.items && dd.items[id] ? dd.items[id].name : `Item ${id}`);
const itemIcon = (id, cls = '') => `<div class="bi ${cls}" title="${esc(itemName(id))}"><img src="${itemImg(id)}" alt="" loading="lazy"></div>`;
const wr = (e) => (e && e.n ? pct(e.w / e.n) : '–');

function champList() {
  return Object.entries(dd.champions || {}).map(([key, c]) => ({ key: Number(key), ...c })).sort((a, b) => a.name.localeCompare(b.name));
}
function renderChampGrid() {
  const q = $('champSearch').value.trim().toLowerCase();
  const list = champList().filter((c) => !q || c.name.toLowerCase().includes(q));
  $('champGrid').innerHTML = list.map((c) => `<button class="cg" data-key="${c.key}" title="${esc(c.name)}">
      <img src="${champImg(c.id)}" alt="" loading="lazy"><span>${esc(c.name)}</span></button>`).join('')
    || '<div class="notice">No champion found.</div>';
}
function showGrid(show) {
  $('champGrid').classList.toggle('hidden', !show);
  $('buildView').classList.toggle('hidden', show);
  $('allChamps').classList.toggle('hidden', show || !buildChamp);
}
$('champSearch').addEventListener('input', () => { renderChampGrid(); showGrid(true); });
$('allChamps').addEventListener('click', () => { $('champSearch').value = ''; renderChampGrid(); showGrid(true); });
$('champGrid').addEventListener('click', (e) => {
  const b = e.target.closest('.cg');
  if (b) openBuild(Number(b.dataset.key), '', false, null);
});

async function openBuild(champKey, role, strict, vs) {
  buildChamp = champKey;
  $('champSearch').value = '';
  showGrid(false);
  $('buildView').innerHTML = '<div class="notice">Loading build…</div>';
  try {
    buildData = await api(`/api/builds/champion/${champKey}?role=${encodeURIComponent(role || '')}${strict ? '&strict=1' : ''}${vs ? `&vs=${vs}` : ''}`);
    renderBuild();
  } catch (err) {
    $('buildView').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  }
}

function runeImgTag(id, cls = '') {
  return dd.runes[id] ? `<img class="${cls}" src="${runeImg(id)}" alt="" title="${esc(dd.runes[id].name)}">` : '';
}
function runePageHtml(e, games, main) {
  const p = e.page;
  const rn = (id) => (dd.runes[id] ? esc(dd.runes[id].name) : `#${id}`);
  return `<div class="rune-page ${main ? 'main' : ''}">
    <div class="tree">
      <div class="tree-name">${runeImgTag(p.primaryStyleId, 'style')}${rn(p.primaryStyleId)}</div>
      <div class="keystone">${runeImgTag(p.primary[0], 'ks')}<span>${rn(p.primary[0])}</span></div>
      ${p.primary.slice(1).map((id) => `<div class="rr">${runeImgTag(id)}<span>${rn(id)}</span></div>`).join('')}
    </div>
    <div class="tree">
      <div class="tree-name">${runeImgTag(p.subStyleId, 'style')}${rn(p.subStyleId)}</div>
      ${p.secondary.map((id) => `<div class="rr">${runeImgTag(id)}<span>${rn(id)}</span></div>`).join('')}
      <div class="shards">${p.shards.map((id) => `<span class="shard">${esc(SHARDS[id] || id)}</span>`).join('')}</div>
    </div>
    <div class="rp-stats"><b>${wr(e)}</b> win rate<br>${pct(e.n / games)} pick rate · ${e.n} games</div>
  </div>`;
}

function renderBuild() {
  const b = buildData;
  const c = dd.champions[b.championId] || { id: '', name: `Champion ${b.championId}` };
  const r = b.rec;
  const enough = r && r.games >= b.minGames;
  const roles = b.roles.map((x) => `<button class="role ${x.role === b.role ? 'active' : ''}" data-role="${x.role}">
      ${ROLE_NAMES[x.role] || x.role} <small>${x.games}</small></button>`).join('');
  const dis = lcuConnected && enough ? '' : 'disabled';
  const tip = !enough ? 'Not enough data yet' : lcuConnected ? '' : 'Open the League client to import';
  const head = `<div class="card build-head">
      <img class="bh-icon" src="${champImg(c.id)}" alt="">
      <div class="bh-main">
        <div class="bh-name">${esc(c.name)} <span>${esc(ROLE_NAMES[b.role] || '')}</span></div>
        <div class="sub">${enough ? `${r.games} games · ${pct(r.wins / r.games)} win rate · patch ${esc(b.patches.join(' + '))}` : 'Collecting data…'}</div>
        <div class="roles">${roles}</div>
        ${b.opponents.length ? `<div class="vs-pick">vs <select id="vsSelect">
          <option value="">any opponent</option>
          ${b.opponents.map((o) => `<option value="${o.championId}" ${r && r.vs && r.vs.championId === o.championId ? 'selected' : ''}>${esc(champName(o.championId))} (${o.games})</option>`).join('')}
        </select></div>` : ''}
        ${r && r.vs ? `<div class="vs-line"><img src="${champIcon(r.vs.championId)}" alt="">
          ${r.vs.games >= 5 ? `<b class="${r.vs.wins / r.vs.games >= 0.5 ? 'good' : 'bad'}">${pct(r.vs.wins / r.vs.games)}</b> win vs ${esc(champName(r.vs.championId))} · ${r.vs.games} games` : `Few games vs ${esc(champName(r.vs.championId))} yet (${r.vs.games})`}
          ${r.fromMatchup.length ? ' · <span class="mtag">matchup build</span>' : ` · general build (matchup build from ${b.matchupMin} games)`}</div>` : ''}
      </div>
      <div class="bh-actions" title="${esc(tip)}">
        <button class="imp" data-what="runes,items" ${dis}>Import runes + items</button>
        <button class="imp ghost" data-what="spells" ${dis}>Set spells</button>
      </div>
    </div>
    <div id="importMsg" class="hint"></div>`;
  if (!enough) {
    const g = r ? r.games : 0;
    $('buildView').innerHTML = head + `<div class="notice">Not enough games for ${esc(c.name)}${b.role ? ' ' + esc(ROLE_NAMES[b.role]) : ''} yet
      (${g} of ${b.minGames}). RiftScout collects high-elo matches in the background while the app is open – check back soon.
      Popular champions fill up first.</div>`;
    return;
  }
  const tag = (k) => (r.fromMatchup.includes(k) ? ` <span class="mtag">vs ${esc(champName(r.vs.championId))}</span>` : '');
  const opts = (list, label) => (list.length ? `<div class="iopt"><div class="ilabel">${label}</div>${list.map((e) => `
      <div class="ichoice">${itemIcon(e.id)}<div class="sub">${wr(e)}<br>${e.n}</div></div>`).join('')}</div>` : '');
  const seq = r.skills[0] ? r.skills[0].key : '';
  const skillGrid = seq ? `<table class="skillgrid"><tbody>${['Q', 'W', 'E', 'R'].map((k) => `<tr><th>${k}</th>${
    Array.from({ length: 15 }, (_, i) => `<td class="${seq[i] === k ? 'on' : ''}">${seq[i] === k ? i + 1 : ''}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '';

  $('buildView').innerHTML = head + `
    <div class="build-grid">
      <div class="card"><h3>Runes${tag('runes')}</h3>${r.runes[0] ? runePageHtml(r.runes[0], r.games, true) : '<div class="sub">No rune data.</div>'}
        ${r.runes.slice(1).length ? `<details><summary>Other popular pages</summary>${r.runes.slice(1).map((e) => runePageHtml(e, r.games, false)).join('')}</details>` : ''}
      </div>
      <div>
        <div class="card"><h3>Summoner spells${tag('spells')}</h3>${r.spells.map((e) => `<div class="spellrow">${e.ids.map((s) =>
          `<img src="${spellImg(s)}" alt="" title="${esc(dd.spells[s] ? dd.spells[s].name : '')}">`).join('')}
          <div class="sub"><b>${wr(e)}</b> win · ${pct(e.n / r.games)} pick</div></div>`).join('')}</div>
        <div class="card"><h3>Skill order${tag('maxOrder')}</h3>
          ${r.maxOrder[0] ? `<div class="maxorder">${r.maxOrder[0].key.split('>').map((k) => `<span>${k}</span>`).join('<i>›</i>')}</div>
          <div class="sub">${wr(r.maxOrder[0])} win · ${pct(r.maxOrder[0].n / r.games)} pick</div>` : ''}
          ${skillGrid}
        </div>
      </div>
    </div>
    ${matchupCard(b)}
    <div class="card"><h3>Items${tag('core')}</h3>
      <div class="items-grid">
        ${r.start.length ? `<div class="iblock"><div class="ilabel">Starting items</div>${r.start.map((e) => `<div class="irow">${e.ids.map((id) => itemIcon(id)).join('')}
          <div class="sub">${wr(e)} · ${e.n}</div></div>`).join('')}</div>` : ''}
        ${r.boots.length ? `<div class="iblock"><div class="ilabel">Boots</div>${r.boots.slice(0, 2).map((e) => `<div class="irow">${itemIcon(e.id)}
          <div class="sub">${wr(e)} · ${pct(e.n / r.games)} pick</div></div>`).join('')}</div>` : ''}
        ${r.core.length ? `<div class="iblock wide"><div class="ilabel">Core build</div>${r.core.slice(0, 2).map((e, i) => `<div class="irow ${i === 0 ? 'best' : ''}">${
          e.ids.map((id) => itemIcon(id)).join('<span class="arrow">›</span>')}<div class="sub"><b>${wr(e)}</b> win · ${e.n} games</div></div>`).join('')}</div>` : ''}
      </div>
      <div class="items-grid">
        ${opts(r.item4, '4th item')}${opts(r.item5, '5th item')}${opts(r.item6, '6th item')}
      </div>
    </div>`;
}

function matchupCard(b) {
  if (!b.strongAgainst.length && !b.weakAgainst.length) return '';
  const row = (m) => `<button class="mu" data-vs="${m.championId}" title="Show the build vs ${esc(champName(m.championId))}">
      <img src="${champIcon(m.championId)}" alt=""><span>${esc(champName(m.championId))}</span>
      <b class="${m.wr >= 0.5 ? 'good' : 'bad'}">${pct(m.wr)}</b><small>${m.games}</small></button>`;
  return `<div class="card"><h3>Matchups</h3><div class="mu-grid">
      <div><div class="ilabel">Strong against</div>${b.strongAgainst.map(row).join('') || '<div class="sub">No winning matchups yet.</div>'}</div>
      <div><div class="ilabel">Weak against (counters)</div>${b.weakAgainst.map(row).join('') || '<div class="sub">No losing matchups yet.</div>'}</div>
    </div><div class="sub">Click a champion to see the build against it.</div></div>`;
}

$('buildView').addEventListener('change', (e) => {
  if (e.target.id === 'vsSelect') openBuild(buildChamp, buildData.role, true, Number(e.target.value) || null);
});

$('buildView').addEventListener('click', async (e) => {
  const mu = e.target.closest('.mu');
  if (mu) { openBuild(buildChamp, buildData.role, true, Number(mu.dataset.vs)); return; }
  const role = e.target.closest('.role');
  if (role) { openBuild(buildChamp, role.dataset.role, true, buildData.rec && buildData.rec.vs ? buildData.rec.vs.championId : null); return; }
  const imp = e.target.closest('.imp');
  if (!imp || !buildData) return;
  const msg = $('importMsg');
  msg.textContent = 'Importing…';
  msg.className = 'hint';
  try {
    const vs = buildData.rec && buildData.rec.vs ? buildData.rec.vs.championId : null;
    const res = await postJson('/api/lcu/import', { championId: buildData.championId, role: buildData.role, vs, what: imp.dataset.what.split(',') });
    msg.textContent = importText(res);
    msg.className = 'hint ' + (res.ok ? 'ok' : 'err');
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'hint err';
  }
});

function importText(res) {
  if (res.error) return res.error;
  const names = { runes: 'Runes', items: 'Item set', spells: 'Spells' };
  const parts = Object.entries(res.results || {}).map(([k, v]) => `${names[k]}: ${v.ok ? 'imported ✓' : v.error}`);
  if (res.matchupSpecific && res.vsName) parts.unshift(`matchup build vs ${res.vsName}`);
  return parts.join(' · ');
}

async function pollBuildStatus() {
  try {
    const s = await api('/api/builds/status');
    const parts = [];
    const total = s.analysed + s.sharedMatches;
    parts.push(`${total.toLocaleString()} high-elo matches analysed`);
    if (s.sharedMatches) parts.push(`${s.sharedMatches.toLocaleString()} from shared data`);
    if (!s.enabled) parts.push('background collection is off (Settings)');
    else if (!s.hasKey) parts.push(s.sharedMatches ? 'shared data updates every few hours' : 'build data is on its way – shared data updates every few hours');
    else if (s.lastError) parts.push(`collection stopped: ${s.lastError}`);
    else if (s.running) parts.push(`collecting from ${(s.region || '').toUpperCase()}: ${s.state}${s.session ? ` (+${s.session} this session)` : ''}`);
    $('buildStatus').textContent = parts.join(' · ');
    $('buildStatus').className = 'hint' + (s.lastError ? ' err' : '');
  } catch { /* ignore */ }
}

// ---------- Champ select ----------
let lastCsKey = '';
let lastImportAt = 0;
let counterKey = '';
let counterHtml = '';
async function loadCounters(enemyId, role) {
  const key = `${enemyId}:${role}`;
  if (key === counterKey) return counterHtml;
  counterKey = key;
  counterHtml = '';
  try {
    const c = await api(`/api/builds/counters/${enemyId}?role=${role}`);
    if (c.counters.length) {
      counterHtml = ` — counter picks vs ${esc(champName(enemyId))}: ` + c.counters.slice(0, 5).map((x) =>
        `<span class="cp"><img src="${champIcon(x.championId)}" alt="">${esc(champName(x.championId))} <b>${pct(x.wr)}</b></span>`).join('');
    }
  } catch { /* geen counters nie */ }
  return counterHtml;
}

async function pollLcu() {
  let st;
  try { st = await api('/api/lcu/state'); } catch { return; }
  const was = lcuConnected;
  lcuConnected = !!st.connected;
  if (was !== lcuConnected && buildData) renderBuild();
  const cs = st.phase === 'ChampSelect' ? st.champSelect : null;
  const banner = $('csBanner');
  if (!cs || !cs.championId) {
    banner.classList.toggle('hidden', !(st.phase === 'ChampSelect'));
    if (st.phase !== 'ChampSelect') { lastCsKey = ''; banner.textContent = ''; return; }
    let html = 'Champ select – pick a champion and RiftScout will load its build.';
    if (cs && cs.vs && cs.role) html = `Champ select · enemy ${esc(ROLE_NAMES[cs.role] || '')}: ${esc(champName(cs.vs))}` + await loadCounters(cs.vs, cs.role);
    banner.innerHTML = html;
    return;
  }
  const c = dd.champions[cs.championId] || { name: 'Champion' };
  const key = `${cs.championId}:${cs.role}:${cs.vs || ''}`;
  if (key !== lastCsKey) {
    lastCsKey = key;
    document.querySelector('.tab[data-tab="builds"]').click();
    openBuild(cs.championId, cs.role, false, cs.vs || null);
  }
  let text = `Champ select · ${c.name}${cs.role ? ' · ' + (ROLE_NAMES[cs.role] || '') : ''}${cs.vs ? ` vs ${champName(cs.vs)}` : ''}`;
  const li = st.lastImport;
  if (li && li.championId === cs.championId) text += ' — ' + importText(li);
  else if (!cs.locked) text += ' — lock in to import runes and items';
  banner.textContent = text;
  banner.classList.remove('hidden');
  if (li && li.at && li.at !== lastImportAt) lastImportAt = li.at;
}

// ---------- Begin ----------
(async function init() {
  await loadDDragon();
  try {
    const st = await api('/api/status');
    setHasKey(st.hasKey);
    if (st.version) $('appVersion').textContent = `RiftScout v${st.version}`;
  } catch { /* ignore */ }

  const [hRegion, hId] = location.hash.slice(1).split('/');
  const region = hRegion || store.get('lastRegion') || 'na1';
  const riotId = hId ? decodeURIComponent(hId) : store.get('lastRiotId') || '';
  $('region').value = region;
  $('riotId').value = riotId;
  if (hId) { viewingOther = true; search(region, riotId); }
  await pollMe();         // vul jou naam en bediener in en laai jou profiel
  setInterval(pollMe, 5000);

  renderChampGrid();
  showGrid(true);
  pollBuildStatus();
  setInterval(pollBuildStatus, 5000);
  pollLcu();
  setInterval(pollLcu, 2000);
  pollLive();
  setInterval(pollLive, 3000);
  pollLobby();
  setInterval(pollLobby, 4000);
})();
