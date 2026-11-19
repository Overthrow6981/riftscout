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
    dd = { version: versions[0], spells: {}, runes: {}, champions: {} };
  } catch {
    dd = { version: '15.1.1', spells: {}, runes: {}, champions: {} };
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
  search($('region').value, $('riotId').value.trim());
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

// ---------- Instellings ----------
function openSettings() {
  $('settingsMsg').textContent = '';
  $('settingsMsg').className = 'hint';
  $('settings').classList.remove('hidden');
  $('apiKey').focus();
}
$('settingsBtn').addEventListener('click', openSettings);
$('settingsCancel').addEventListener('click', () => $('settings').classList.add('hidden'));
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').classList.add('hidden'); });
$('settingsSave').addEventListener('click', async () => {
  const msg = $('settingsMsg');
  try {
    const r = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: $('apiKey').value.trim() }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || 'Could not save.');
    $('apiKey').value = '';
    $('keyWarning').classList.toggle('hidden', body.hasKey);
    msg.textContent = body.hasKey ? 'Saved! You can search players now.' : 'Key removed.';
    msg.className = 'hint ok';
    setTimeout(() => $('settings').classList.add('hidden'), 900);
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'hint err';
  }
});

// ---------- Begin ----------
(async function init() {
  await loadDDragon();
  try {
    const st = await api('/api/status');
    $('keyWarning').classList.toggle('hidden', st.hasKey);
    if (st.version) $('appVersion').textContent = `RiftScout v${st.version}`;
    // Maak Settings net die heel eerste keer vanself oop
    if (!st.hasKey && !store.get('settingsSeen')) { store.set('settingsSeen', '1'); openSettings(); }
  } catch { /* ignore */ }

  const [hRegion, hId] = location.hash.slice(1).split('/');
  const region = hRegion || store.get('lastRegion') || 'na1';
  const riotId = hId ? decodeURIComponent(hId) : store.get('lastRiotId') || '';
  $('region').value = region;
  $('riotId').value = riotId;
  if (hId) search(region, riotId);

  pollLive();
  setInterval(pollLive, 3000);
})();
