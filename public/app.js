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
    const r = await fetch('/api/ddragon', { signal: AbortSignal.timeout(25000) });
    if (r.ok) { dd = await r.json(); return true; }
  } catch { /* val terug na direkte laai */ }
  if (dd && dd.version) return false; // hou wat ons het
  try {
    const versions = await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json', { signal: AbortSignal.timeout(10000) })).json();
    dd = { version: versions[0], spells: {}, runes: {}, champions: {}, items: {}, missing: true };
  } catch {
    dd = { version: '15.1.1', spells: {}, runes: {}, champions: {}, items: {}, missing: true };
  }
  return false;
}
// As Data Dragon (champions, runes, items) nie gelaai het nie: probeer elke 30 s weer en teken dan alles oor
async function retryDDragon() {
  if (!dd || !dd.missing) return;
  if (await loadDDragon()) {
    renderChampGrid();
    if (buildData) renderBuild();
    csPanelHtml = '';
    if (current) { renderProfile(current.profile); renderSummary(); $('matches').innerHTML = loadedMatches.map(renderMatch).join(''); }
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
    const games = e.losses == null ? 0 : e.wins + e.losses;
    const tier = e.tier.charAt(0) + e.tier.slice(1).toLowerCase();
    const showDiv = !['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(e.tier);
    return `<div class="rank"><div class="q">${order[q]}</div>
      <div class="tier">${esc(tier)}${showDiv ? ' ' + esc(e.rank) : ''} · ${e.leaguePoints} LP</div>
      <div class="wl">${e.losses == null ? `${e.wins} wins` : `${e.wins}W ${e.losses}L · ${games ? pct(e.wins / games) : '–'} win rate`}${e.hotStreak ? ' · 🔥 streak' : ''}</div></div>`;
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
    // Per champion-ID: wedstryde uit die League-kliënt het nie 'n championName nie
    const c = (champs[m.me.championId] ||= { games: 0, wins: 0, me: m.me });
    c.games++; if (m.me.win) c.wins++;
  }
  const n = games.length;
  const top = Object.values(champs).sort((x, y) => y.games - x.games).slice(0, 3)
    .map((s) => [champName(s.me.championId) !== `Champion ${s.me.championId}` ? champName(s.me.championId) : (s.me.championName || ''), s, s.me]);
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
        <div class="queue">${esc(QUEUES[m.queueId] || m.gameMode)}</div>
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
  viewingOther = true;
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
  const tcls = esc(r.tier.toLowerCase());
  if (r.losses == null) return `<span class="tier t-${tcls}">${esc(tier + div)}</span> ${r.lp} LP${p.solo ? '' : ' (Flex)'} · ${r.wins} wins`;
  const g = r.wins + r.losses;
  return `<span class="tier t-${tcls}">${esc(tier + div)}</span> ${r.lp} LP${p.solo ? '' : ' (Flex)'}
    · ${r.wins}W ${r.losses}L${g ? ` · <b class="${r.wins / g >= 0.5 ? 'good' : 'bad'}">${pct(r.wins / g)}</b>` : ''}`;
}

function lobbyCard(p) {
  const c = dd.champions[p.championId];
  const img = c ? `<img class="c" src="${champImg(c.id)}" alt="${esc(c.name)}" title="${esc(c.name)}">` : '<div class="c empty"></div>';
  const role = p.role ? `<small>${esc(ROLE_NAMES[p.role] || p.role)}</small>` : '';
  if (p.enemyPick) {
    return `<div class="pc ${p.opp ? 'opp' : ''}">${img}<div class="pi"><div class="pn">${esc(c ? c.name : 'Champion')} ${role}${p.opp ? ' <span class="pill lane">Your lane</span>' : ''}</div>
      <div class="ps">Riot shows enemy names from the loading screen on – full scouting starts there.</div></div></div>`;
  }
  if (p.hidden) {
    const why = p.teamId === 200 || p.position !== undefined
      ? 'This player hides their name (e.g. streamer mode), so they can\'t be scouted.'
      : 'Riot hides names in ranked champ select — full scouting starts on the loading screen.';
    return `<div class="pc hidden-name ${p.opp ? 'opp' : ''}">${img}<div class="pi"><div class="pn">Hidden player ${role}${p.opp ? ' <span class="pill lane">Your lane</span>' : ''}</div>
      <div class="ps">${why}</div></div></div>`;
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
    ? `<div class="notice">Champ select${l.hiddenNames ? ' — your teammates\' names are hidden by Riot in this queue, so only you are scouted until the game loads.' : ' — the enemy team\'s names show from the loading screen on.'}</div>`
    : l.stale ? '<div class="notice">Your last game\'s lobby.</div>' : '';
  const team = (t) => {
    const ps = [...t.players].sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));
    const label = t.mine ? 'Your team' : (l.phase === 'ChampSelect' ? 'Enemy picks' : 'Enemy team');
    return `<div class="card team"><h3 class="${t.teamId === 100 ? 'blue' : 'red'}">${label}</h3>${ps.map(lobbyCard).join('')}</div>`;
  };
  $('lobby').innerHTML = head + `<div class="teams ${teams.length === 1 ? 'one' : ''}">${teams.map(team).join('')}</div>
    <p class="hint">Tags: <b>One-trick</b> 300k+ mastery · <b>New on champ</b> under 10k · <b>Possible smurf</b> low level with a very high win rate. Ranked stats are Solo/Duo (or Flex when they have no Solo rank). The League client only shares other players' wins, not their losses.</p>`;
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
    $('prefSpells').checked = p.autoSpells;
    $('prefOpenCs').checked = p.openOnChampSelect;
    $('prefReplace').checked = p.replacePages;
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
      autoSpells: $('prefSpells').checked,
      openOnChampSelect: $('prefOpenCs').checked,
      replacePages: $('prefReplace').checked,
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
const laneTxt = (l, suffix) => (l && l[0] ? ` · ${pct(l[1] / l[0])}${suffix}` : '');

function champList() {
  return Object.entries(dd.champions || {}).map(([key, c]) => ({ key: Number(key), ...c })).sort((a, b) => a.name.localeCompare(b.name));
}
function renderChampGrid() {
  const q = $('champSearch').value.trim().toLowerCase();
  const list = champList().filter((c) => !q || c.name.toLowerCase().includes(q));
  $('champGrid').innerHTML = list.map((c) => `<button class="cg" data-key="${c.key}" title="${esc(c.name)}">
      <img src="${champImg(c.id)}" alt="" loading="lazy"><span>${esc(c.name)}</span></button>`).join('')
    || (dd.missing && !Object.keys(dd.champions || {}).length
      ? '<div class="notice error">Couldn\'t load the champion list (Riot\'s Data Dragon isn\'t reachable). Check your internet – RiftScout keeps trying.</div>'
      : '<div class="notice">No champion found.</div>');
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

let buildReq = 0;
async function openBuild(champKey, role, strict, vs) {
  const req = ++buildReq; // as jy vinnig tussen champions wissel, wen net die laaste antwoord
  runeSel = 0;
  buildChamp = champKey;
  $('champSearch').value = '';
  showGrid(false);
  $('buildView').innerHTML = '<div class="notice">Loading build…</div>';
  try {
    const data = await api(`/api/builds/champion/${champKey}?role=${encodeURIComponent(role || '')}${strict ? '&strict=1' : ''}${vs ? `&vs=${vs}` : ''}`);
    if (req !== buildReq) return;
    buildData = data;
    renderBuild();
  } catch (err) {
    if (req !== buildReq) return;
    $('buildView').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  }
}

function runeImgTag(id, cls = '') {
  return dd.runes[id] ? `<img class="${cls}" src="${runeImg(id)}" alt="" title="${esc(dd.runes[id].name)}">` : '';
}
// Volle rune-bladsy soos in die kliënt (en Blitz): alle opsies, die gekose eenes helder
const SHARD_ROWS = [[5008, 5005, 5007], [5008, 5010, 5001], [5011, 5013, 5001]];
const SHARD_ICON = {
  5008: 'statmodsadaptiveforceicon', 5005: 'statmodsattackspeedicon', 5007: 'statmodscdrscalingicon',
  5010: 'statmodsmovementspeedicon', 5001: 'statmodshealthplusicon', 5011: 'statmodshealthscalingicon',
  5013: 'statmodstenacityicon', 5002: 'statmodsarmoricon', 5003: 'statmodsmagicresicon',
};
const SHARD_SHORT = { 5008: 'AF', 5005: 'AS', 5007: 'AH', 5010: 'MS', 5001: 'HP+', 5011: 'HP', 5013: 'TEN', 5002: 'AR', 5003: 'MR' };
const shardImg = (id) => `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/perk-images/statmods/${SHARD_ICON[id] || ''}.png`;
// As 'n shard-ikoon nie laai nie: wys 'n kort teks (AF, AS, HP …)
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!img || !img.classList || !img.classList.contains('shard-i')) return;
  const t = document.createElement('span');
  t.className = 'shard-t';
  t.textContent = img.dataset.short || '?';
  img.replaceWith(t);
}, true);

function runeTreeHtml(p, statsHtml) {
  const tree = (id) => (dd.trees || []).find((t) => t.id === id);
  const pt = tree(p.primaryStyleId);
  const st = tree(p.subStyleId);
  if (!pt || !st) return runePageHtml({ page: p }, 0, true, true) + (statsHtml ? `<div class="rp-stats">${statsHtml}</div>` : '');
  const sel = new Set([...p.primary, ...p.secondary]);
  const nm = (id) => (dd.runes[id] ? dd.runes[id].name : '');
  const icon = (id, ks) => `<span class="rn ${sel.has(id) ? 'on' : ''} ${ks ? 'ks' : ''}" title="${esc(nm(id))}"><img src="${runeImg(id)}" alt=""></span>`;
  const rows = (t, from) => t.slots.slice(from).map((ids, i) =>
    `<div class="rrow">${ids.map((id) => icon(id, from === 0 && i === 0)).join('')}</div>`).join('');
  const shards = SHARD_ROWS.map((row, i) => {
    const pick = p.shards[i];
    const ids = row.includes(pick) || !pick ? row : [...row, pick];
    return `<div class="rrow sh">${ids.map((id) => `<span class="rn ${id === pick ? 'on' : ''}" title="${esc(SHARDS[id] || '')}">
      <img class="shard-i" data-short="${SHARD_SHORT[id] || '?'}" src="${shardImg(id)}" alt=""></span>`).join('')}</div>`;
  }).join('');
  return `<div class="rtree">
      <div class="rcol"><div class="rhead">${runeImgTag(pt.id, 'style')}<b>${esc(pt.name)}</b></div>${rows(pt, 0)}</div>
      <div class="rcol"><div class="rhead">${runeImgTag(st.id, 'style')}<b>${esc(st.name)}</b></div>${rows(st, 1)}<div class="rsep"></div>${shards}</div>
    </div>
    <div class="rnames"><b>${esc(nm(p.primary[0]))}</b> · ${[...p.primary.slice(1), ...p.secondary].map((id) => esc(nm(id))).join(' · ')}</div>
    ${statsHtml ? `<div class="rp-stats">${statsHtml}</div>` : ''}`;
}

function runePageHtml(e, games, main, noStats) {
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
    ${noStats ? '' : `<div class="rp-stats"><b>${wr(e)}</b> win rate<br>${pct(e.n / games)} pick rate · ${e.n} games</div>`}
  </div>`;
}

// Rune-kaart: kies tussen die gewildste bladsye en sit die gekose een met een klik in League
let runeSel = 0;
function runeCardHtml(r) {
  if (!r.runes[0]) return '<div class="sub">No rune data.</div>';
  const sel = Math.min(runeSel, r.runes.length - 1);
  const e = r.runes[sel];
  const base = r.fromMatchup.includes('runes') && r.vs ? r.vs.games : r.games;
  const tabs = r.runes.length > 1 ? `<div class="rtabs">${r.runes.map((x, i) => `<button type="button" class="rtab ${i === sel ? 'on' : ''}" data-rune="${i}">
      ${runeImgTag(x.page.primary[0], 'ks')}<span>${i === 0 ? 'Most popular' : `Option ${i + 1}`}<small>${wr(x)} win · ${pct(x.n / base)} pick</small></span></button>`).join('')}</div>` : '';
  const stats = r.fromMatchup.includes('runes') && r.vs
    ? `<b>${wr(e)}</b> win rate · ${e.n} games vs ${esc(champName(r.vs.championId))}`
    : `<b>${wr(e)}</b> win rate · ${pct(e.n / r.games)} pick rate · ${e.n} games`;
  return `${tabs}${runeTreeHtml(e.page, stats)}
    <div class="ruse"><button class="imp" data-what="runes" ${lcuConnected ? '' : 'disabled title="Open the League client to import"'}>Use these runes</button><span class="hint ruse-msg"></span></div>`;
}

function renderBuild() {
  const b = buildData;
  const c = dd.champions[b.championId] || { id: '', name: `Champion ${b.championId}` };
  const r = b.rec;
  const enough = r && r.games >= b.minGames;
  const roles = b.roles.map((x) => `<button class="role ${x.role === b.role ? 'active' : ''}" data-role="${x.role}">
      ${ROLE_NAMES[x.role] || x.role} <small>${x.games}</small></button>`).join('');
  const riot = !enough ? b.riot : null;
  const dis = lcuConnected && (enough || riot) ? '' : 'disabled';
  const disSpells = lcuConnected && (enough || (riot && riot.spells.length === 2)) ? '' : 'disabled';
  const tip = !lcuConnected ? 'Open the League client to import' : !enough && !riot ? 'Not enough data yet' : '';
  const head = `<div class="card build-head">
      <img class="bh-icon" src="${champImg(c.id)}" alt="">
      <div class="bh-main">
        <div class="bh-name">${esc(c.name)} <span>${esc(ROLE_NAMES[b.role] || '')}</span></div>
        <div class="sub">${enough ? `${r.games} games · ${pct(r.wins / r.games)} win rate${laneTxt(r.lane, ' lane')} · patch ${esc(b.patches.join(' + '))}` : riot ? "Riot's recommended setup from the League client" : 'No RiftScout stats for this champion yet'}</div>
        <div class="roles">${roles}</div>
        ${b.opponents.length ? `<div class="vs-pick">vs <select id="vsSelect">
          <option value="">any opponent</option>
          ${b.opponents.map((o) => `<option value="${o.championId}" ${r && r.vs && r.vs.championId === o.championId ? 'selected' : ''}>${esc(champName(o.championId))} (${o.games})</option>`).join('')}
        </select></div>` : ''}
        ${r && r.vs ? `<div class="vs-line"><img src="${champIcon(r.vs.championId)}" alt="">
          ${r.vs.games >= 3 ? `<b class="${r.vs.wins / r.vs.games >= 0.5 ? 'good' : 'bad'}">${pct(r.vs.wins / r.vs.games)}</b> game${r.vs.lane && r.vs.lane[0] ? ` · <b class="${r.vs.lane[1] / r.vs.lane[0] >= 0.5 ? 'good' : 'bad'}">${pct(r.vs.lane[1] / r.vs.lane[0])}</b> lane` : ''} vs ${esc(champName(r.vs.championId))} · ${r.vs.games} games` : `Few games vs ${esc(champName(r.vs.championId))} yet (${r.vs.games})`}
          ${r.fromMatchup.length ? ' · <span class="mtag">matchup build</span>' : ` · general build (matchup build from ${b.matchupMin} games)`}</div>` : ''}
      </div>
      <div class="bh-actions" title="${esc(tip)}">
        <button class="imp" data-what="runes,items" ${dis}>${riot ? 'Import runes' : 'Import runes + items'}</button>
        <button class="imp ghost" data-what="spells" ${disSpells}>Set spells</button>
      </div>
    </div>
    <div id="importMsg" class="hint"></div>`;
  if (!enough && riot) {
    $('buildView').innerHTML = head + `<div class="notice">RiftScout's own win-rate stats for ${esc(c.name)} aren't in yet, so this is
      <b>Riot's recommended setup</b> straight from your League client – it imports instantly. Items: use the recommended items in the game's shop.</div>
      <div class="build-grid">
        <div class="card"><h3>Runes <span class="mtag">Riot recommended</span></h3>${runeTreeHtml(riot)}</div>
        <div class="card"><h3>Summoner spells</h3>${riot.spells.length ? `<div class="spellrow">${riot.spells.map((sp) =>
          `<img src="${spellImg(sp)}" alt="" title="${esc(dd.spells[sp] ? dd.spells[sp].name : '')}">`).join('')}</div>` : '<div class="sub">—</div>'}</div>
      </div>`;
    return;
  }
  if (!enough) {
    const g = r ? r.games : 0;
    $('buildView').innerHTML = head + `<div class="notice">Not enough games for ${esc(c.name)}${b.role ? ' ' + esc(ROLE_NAMES[b.role]) : ''} yet
      (${g} of ${b.minGames}). ${lcuConnected ? '' : "Open the League client to see Riot's recommended runes for this champion right away."}</div>`;
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
      <div class="card"><h3>Runes${tag('runes')}</h3>${runeCardHtml(r)}</div>
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
  const rt = e.target.closest('.rtab');
  if (rt) { runeSel = Number(rt.dataset.rune) || 0; renderBuild(); return; }
  const mu = e.target.closest('.mu');
  if (mu) { openBuild(buildChamp, buildData.role, true, Number(mu.dataset.vs)); return; }
  const role = e.target.closest('.role');
  if (role) { openBuild(buildChamp, role.dataset.role, true, buildData.rec && buildData.rec.vs ? buildData.rec.vs.championId : null); return; }
  const imp = e.target.closest('.imp');
  if (!imp || !buildData) return;
  const msg = $('importMsg');
  const near = imp.closest('.ruse') ? imp.closest('.ruse').querySelector('.ruse-msg') : null; // boodskap langs die knoppie
  const show = (text, cls) => { for (const m of [msg, near]) if (m) { m.textContent = text; m.className = (m === near ? 'hint ruse-msg ' : 'hint ') + cls; } };
  show('Importing…', '');
  try {
    const vs = buildData.rec && buildData.rec.vs ? buildData.rec.vs.championId : null;
    const res = await postJson('/api/lcu/import', { championId: buildData.championId, role: buildData.role, vs, what: imp.dataset.what.split(','), runeIndex: runeSel });
    show(importText(res), res.ok ? 'ok' : 'err');
  } catch (err) {
    show(err.message, 'err');
  }
});

function importText(res) {
  if (res.error) return res.error;
  const names = { runes: 'Runes', items: 'Item set', spells: 'Spells' };
  const parts = Object.entries(res.results || {}).map(([k, v]) => `${names[k]}: ${v.ok ? `imported ✓${v.replaced ? ` (replaced page "${v.replaced}")` : ''}` : v.error}`);
  if (res.matchupSpecific && res.vsName) parts.unshift(`matchup build vs ${res.vsName}`);
  return parts.join(' · ');
}

async function pollBuildStatus() {
  try {
    const s = await api('/api/builds/status');
    const parts = [];
    const total = s.analysed + s.sharedMatches;
    parts.push(`${total.toLocaleString()} high-elo matches analysed`);
    if (s.sharedMatches) parts.push(`${s.sharedMatches.toLocaleString()} from shared data${s.sharedRegions && s.sharedRegions.length > 1 ? ` (${s.sharedRegions.length} servers: ${s.sharedRegions.join(', ')})` : ''}`);
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
let counterData = null;
async function loadCounters(enemyId, role, mineId) {
  const key = `${enemyId}:${role}:${mineId || 0}`;
  if (key === counterKey) return counterData;
  counterKey = key;
  counterData = null;
  try { counterData = await api(`/api/builds/counters/${enemyId}?role=${role}${mineId ? `&me=${mineId}` : ''}`); } catch { counterData = { counters: [] }; }
  return counterData;
}
const takenSet = (cs) => new Set([...(cs.enemies || []), ...(cs.bans || []),
  ...(cs.allies || []).filter((a) => !a.me && a.championId).map((a) => a.championId)]);
const wrCls = (x) => (x >= 0.5 ? 'good' : 'bad');
const pickLine = (x) => `<img src="${champIcon(x.championId)}" alt=""><b>${esc(champName(x.championId))}</b>
  <span class="${wrCls(x.wr)}">${pct(x.wr)} win</span>${x.laneWr != null ? ` · <span class="${wrCls(x.laneWr)}">${pct(x.laneWr)} lane</span>` : ''}
  <span class="sub">· ${x.games} game${x.games === 1 ? '' : 's'}${x.games < 10 ? ', few so far' : ''}</span>`;

let csPanelHtml = '';
let csSort = 'wr';
let bestKey = '';
let bestData = null;
async function loadBest(role) {
  if (role === bestKey) return bestData;
  bestKey = role;
  bestData = null;
  try { bestData = await api(`/api/builds/best?role=${role}`); } catch { bestData = { best: [] }; }
  return bestData;
}

// Tabel soos Blitz: champion, game-wenkoers, lane-wenkoers (voor in goud op 15 min) en hoeveel games
function counterTable(list, cs, vsName) {
  const taken = takenSet(cs);
  const cls = (x) => (x >= 0.5 ? 'good' : 'bad');
  const sorted = [...list].sort((a, b) => (csSort === 'lane'
    ? ((b.laneScore ?? -1) - (a.laneScore ?? -1))
    : (b.score - a.score)) || b.games - a.games);
  const gameTip = vsName ? `How often this champion wins the game vs ${vsName}` : 'How often this champion wins the game';
  const laneTip = vsName ? `How often this champion is ahead in gold at 15 minutes vs ${vsName}` : 'How often this champion is ahead of its lane opponent in gold at 15 minutes';
  return `<div class="ct-head"><span></span><span></span><span>Champion</span>
      <button type="button" class="ct-sort ${csSort === 'wr' ? 'on' : ''}" data-sort="wr" title="${esc(gameTip)}">Game %</button>
      <button type="button" class="ct-sort ${csSort === 'lane' ? 'on' : ''}" data-sort="lane" title="${esc(laneTip)}">Lane %</button>
      <span>Games</span></div>
    <ol class="counters">${sorted.map((x) => `<li data-champ="${x.championId}" class="${taken.has(x.championId) ? 'taken' : ''}"
        title="${taken.has(x.championId) ? 'Already picked or banned' : 'Click for runes and build'}">
        <img src="${champIcon(x.championId)}" alt=""><span class="cn">${esc(champName(x.championId))}${taken.has(x.championId) ? ' <small>taken</small>' : ''}</span>
        <span class="cval"><span class="cbar"><span class="${cls(x.wr)}" style="width:${Math.round(x.wr * 100)}%"></span></span><b class="${cls(x.wr)}">${pct(x.wr)}</b></span>
        <span class="cval">${x.laneWr == null ? '<span class="sub">–</span>' : `<span class="cbar"><span class="${cls(x.laneWr)}" style="width:${Math.round(x.laneWr * 100)}%"></span></span><b class="${cls(x.laneWr)}">${pct(x.laneWr)}</b>`}</span>
        <span class="sub ${x.games < 10 ? 'few' : ''}" ${x.games < 10 ? 'title="Few games – less reliable"' : ''}>${x.games.toLocaleString()}</span></li>`).join('')}</ol>`;
}

async function renderCsPanel(cs) {
  const panel = $('csPanel');
  if (!cs) { panel.classList.add('hidden'); csPanelHtml = ''; return; }
  const er = cs.enemyRoles || {};
  // Sonder lanes (ARAM, Arena) is daar geen lane-teenstander om te kies nie: net die champions
  const enemies = (cs.enemies || []).map((id) => (!cs.role
    ? `<span class="ep" title="${esc(champName(id))}"><img src="${champIcon(id)}" alt=""><span>${esc(champName(id))}</span></span>`
    : `<button type="button" class="ep ${id === cs.vs ? 'lane' : ''}" data-ep="${id}"
      title="${id === cs.vs ? `Your lane opponent${cs.vsManual ? ' (you picked this)' : ''}` : `Click if ${esc(champName(id))} is your lane opponent`}">
      <img src="${champIcon(id)}" alt=""><span>${esc(champName(id))}<small>${esc(id === cs.vs ? ROLE_NAMES[cs.role] : ROLE_NAMES[er[id]] || '')}</small></span></button>`)).join('');
  const roleName = esc(ROLE_NAMES[cs.role] || '');
  const fixHint = cs.role && (cs.enemies || []).length ? `<div class="sub ep-hint">${cs.vs
    ? `Wrong lane opponent? Click the right enemy above.${cs.vsManual ? ' <a href="#" data-ep-reset="1">Use RiftScout\'s guess</a>' : ''}`
    : `Know who your ${roleName} opponent is? Click them above.`}</div>` : '';
  let body;
  if (!cs.role) {
    body = '<div class="sub">No lanes in this mode – counter picks are for Summoner\'s Rift draft and ranked.</div>';
  } else if (!cs.vs) {
    const b = await loadBest(cs.role);
    const list = (b && b.best) || [];
    body = `<div class="sub">Waiting for the enemy ${roleName} to pick – then you get the best picks against them.</div>` + (list.length
      ? `<h3>Strongest ${roleName} picks right now</h3>${counterTable(list, cs, '')}` : '');
  } else {
    const vsName = champName(cs.vs);
    const mineId = cs.locked ? cs.championId : 0;
    const c = await loadCounters(cs.vs, cs.role, mineId);
    const list = (c && c.counters) || [];
    const best = (c && c.best) || [];
    // Duidelik bo-aan: die beste pick teen jou laner (of, ná lock-in, hoe jou champion teen hom vaar)
    const taken = takenSet(cs);
    const top = list.find((x) => !taken.has(x.championId));
    const topOverall = best.find((x) => !taken.has(x.championId));
    let callout = '';
    if (cs.locked && cs.championId) {
      const m = c && c.mine;
      callout = m && m.games
        ? `<div class="cs-best"><span class="cb-label">Your matchup</span>${pickLine(m)} <span class="sub">vs ${esc(vsName)}</span></div>`
        : `<div class="cs-best"><span class="cb-label">Your matchup</span><span class="sub">No games of ${esc(champName(cs.championId))} vs ${esc(vsName)} in RiftScout's data yet.</span></div>`;
    } else if (top) {
      callout = `<div class="cs-best"><span class="cb-label">Best pick vs ${esc(vsName)}</span>${pickLine(top)}</div>`;
    } else if (topOverall) {
      callout = `<div class="cs-best"><span class="cb-label">Strongest ${roleName} pick</span>${pickLine(topOverall)}
        <span class="sub">(not enough games vs ${esc(vsName)} yet)</span></div>`;
    }
    let inner = '';
    if (list.length) {
      inner += counterTable(list, cs, vsName) + `<div class="sub">Click a champion for its runes and build vs ${esc(vsName)}.
        Game % = wins the game, Lane % = ahead in gold at 15 min. Sorted by win rate, weighted by number of games.</div>`;
    }
    if (best.length) {
      inner += `<h3>${list.length ? 'More' : 'Strongest'} ${roleName} picks overall <small>not enough games vs ${esc(vsName)} for these yet</small></h3>${counterTable(best, cs, '')}`;
    }
    if (!list.length && !best.length) {
      inner += `<div class="sub">No matchup win rates vs ${esc(vsName)} yet – they come from RiftScout's shared match data, which grows every few hours.
        Your runes still import when you lock in.</div>`;
    }
    // Na lock-in: lys ingevou sodat jou runes en build bo-aan sigbaar is
    body = callout + (cs.locked
      ? `<details class="cs-more"><summary>Best ${roleName} picks vs ${esc(vsName)}${list.length ? ` <small>(${list.length})</small>` : ''}</summary>${inner}</details>`
      : `<h3>Best ${roleName} picks vs ${esc(vsName)}</h3>${inner}`);
  }
  const html = `<div class="ep-row"><span class="ep-label">Enemy picks</span>${enemies || '<span class="sub">none yet</span>'}</div>${fixHint}${body}`;
  if (html !== csPanelHtml) { csPanelHtml = html; panel.innerHTML = html; }
  panel.classList.remove('hidden');
}
$('csPanel').addEventListener('click', async (e) => {
  const ep = e.target.closest('[data-ep]');
  const reset = e.target.closest('[data-ep-reset]');
  if (ep || reset) {
    e.preventDefault();
    const id = reset ? 0 : Number(ep.dataset.ep);
    try { await postJson('/api/lcu/vs', { championId: lastCs && lastCs.vsManual && lastCs.vs === id ? 0 : id }); } catch { /* volgende poll */ }
    pollLcu();
    return;
  }
  const sortBtn = e.target.closest('.ct-sort');
  if (sortBtn) { csSort = sortBtn.dataset.sort; csPanelHtml = ''; if (lastCs) renderCsPanel(lastCs); return; }
  const li = e.target.closest('li[data-champ]');
  if (!li || !lastCs) return;
  openBuild(Number(li.dataset.champ), lastCs.role, false, lastCs.vs || null);
});
let lastCs = null;

async function pollLcu() {
  let st;
  try { st = await api('/api/lcu/state'); } catch { return; }
  const was = lcuConnected;
  lcuConnected = !!st.connected;
  if (was !== lcuConnected && buildData) renderBuild();
  const cs = st.phase === 'ChampSelect' ? st.champSelect : null;
  lastCs = cs;
  // Tydens champ select word die Builds-oortjie "Champ Select" (met 'n groen kolletjie)
  $('buildsLabel').textContent = st.phase === 'ChampSelect' ? 'Champ Select' : 'Builds';
  $('csDot').classList.toggle('on', st.phase === 'ChampSelect');
  if (st.phase === 'ChampSelect' && !lastCsKey) {
    document.querySelector('.tab[data-tab="builds"]').click();
    window.scrollTo(0, 0);
  }
  renderCsPanel(cs);
  const banner = $('csBanner');
  if (!cs || !cs.championId) {
    banner.classList.toggle('hidden', !(st.phase === 'ChampSelect'));
    if (st.phase !== 'ChampSelect') { lastCsKey = ''; banner.textContent = ''; return; }
    let html = 'Champ select – pick a champion and RiftScout loads its runes and build.';
    if (cs && cs.vs && cs.role) html = `Champ select · your lane: ${esc(champName(cs.vs))} – the best picks against them are below.`;
    banner.innerHTML = html;
    if (cs && st.phase === 'ChampSelect' && !lastCsKey) { lastCsKey = 'panel'; document.querySelector('.tab[data-tab="builds"]').click(); }
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
  if (li && li.championId === cs.championId) text += ' — ' + (li.source === 'riot' ? "Riot's recommended runes · " : '') + importText(li);
  else if (st.autoImport) text += ` — putting runes, items${cs.role && st.autoSpells ? ' and spells' : ''} into League…`;
  else text += ' — click Import to put the runes into League';
  banner.textContent = text;
  banner.classList.remove('hidden');
  if (li && li.at && li.at !== lastImportAt) lastImportAt = li.at;
}

// ---------- Updates ----------
async function pollUpdate() {
  let u;
  try { u = await api('/api/update'); } catch { return; }
  const bar = $('updateBar');
  let html = '';
  if (u.state === 'downloading') {
    html = `<span>Downloading RiftScout ${esc(u.version || '')}… <b>${u.percent || 0}%</b></span><span class="ub-track"><span class="ub-fill" style="width:${u.percent || 0}%"></span></span>`;
  } else if (u.state === 'installing') {
    html = `<span>Installing RiftScout ${esc(u.version || '')} – the app closes and opens again by itself…</span>`;
  } else if (u.state === 'ready') {
    html = `<span>RiftScout ${esc(u.version || '')} is ready.${u.busy ? ' It installs after your game, when you close RiftScout.' : ' It installs when you close RiftScout.'}</span>
      <button id="updateNow" type="button">Restart now</button>`;
  }
  bar.classList.toggle('hidden', !html);
  if (bar.dataset.html !== html) { bar.dataset.html = html; bar.innerHTML = html; }
  const btn = $('updateNow');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await postJson('/api/update/install', {}); } catch (err) { btn.disabled = false; showMessage(err.message, true); }
    });
  }
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
  const okRegion = (r) => (r && REGION_LABEL[r] ? r : '');
  const region = okRegion(hRegion) || okRegion(store.get('lastRegion')) || 'na1';
  let riotId = store.get('lastRiotId') || '';
  let fromHash = false;
  if (hId && okRegion(hRegion)) { try { riotId = decodeURIComponent(hId); fromHash = true; } catch { /* stukkende adres */ } }
  $('region').value = region;
  $('riotId').value = riotId;
  if (fromHash) { viewingOther = true; search(region, riotId); }
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
  pollUpdate();
  setInterval(pollUpdate, 2000);
  setInterval(retryDDragon, 30000);
})();
