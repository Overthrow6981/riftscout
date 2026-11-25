// Klein nagemaakte League-kliënt (LCU) oor gewone http vir die toetse (die lockfile se protokol is "http").
// Bevat net wat RiftScout gebruik, met die gedrag wat op regte kliënte gesien is:
//  - die item set-lys vervang altyd die hele lys (PUT) en ken geen "priority" nie (word weggegooi)
//  - wedstrydgeskiedenis: die eerste versoek se reeks bepaal die lys; daarna word begIndex/endIndex geïgnoreer
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ME = '11111111-2222-3333-4444-555555555555';
const ITEM_SET_FIELDS = ['uid', 'title', 'mode', 'map', 'type', 'sortrank', 'startedFrom', 'associatedChampions', 'associatedMaps', 'blocks', 'preferredItemSlots'];

function lcuGame(i, { full = true } = {}) {
  const gameId = 9000 + i;
  const mine = { participantId: 1, teamId: 100, championId: 1, spell1Id: 4, spell2Id: 14,
    stats: { win: i % 2 === 0, kills: 5, deaths: 2, assists: 7, champLevel: 15, totalMinionsKilled: 150, neutralMinionsKilled: 4,
      goldEarned: 10000, totalDamageDealtToChampions: 20000, visionScore: 20, item0: 3089, perk0: 8112, perkSubStyle: 8200 },
    timeline: { lane: 'MIDDLE', role: 'SOLO' } };
  const other = { participantId: 6, teamId: 200, championId: 238, spell1Id: 4, spell2Id: 14, stats: { win: i % 2 === 1, kills: 3, deaths: 5, assists: 1 }, timeline: { lane: 'MIDDLE' } };
  const ids = [{ participantId: 1, player: { puuid: ME, gameName: 'Me', tagLine: 'NA1' } },
    { participantId: 6, player: { puuid: '99999999-2222-3333-4444-555555555555', gameName: 'Foe', tagLine: 'NA1' } }];
  return {
    gameId, platformId: 'NA1', queueId: 400, gameMode: 'CLASSIC', gameDuration: 1800, gameCreation: 1795000000000 - i * 3600e3,
    participants: full ? [mine, other] : [mine], participantIdentities: full ? ids : [ids[0]],
  };
}

function startFakeLcu({ games = 25, badGames = new Set() } = {}) {
  const install = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-league-'));
  fs.mkdirSync(path.join(install, 'Config'), { recursive: true });
  const st = {
    install,
    phase: 'None',
    session: null,
    pages: [{ id: 50, name: 'My page', current: true, isDeletable: true, isEditable: true, primaryStyleId: 8000, subStyleId: 8100, selectedPerkIds: [] }],
    nextPage: 100,
    maxPages: 3,
    sets: { accountId: 42, timestamp: 1, itemSets: [] },
    selection: null,
    historyCache: new Map(),
    historyCalls: [],
    gameCalls: 0,
    puts: [],
    hang: new Set(), // roetes wat nooit antwoord nie (stadige kliënt)
    delay: {},
    flow: null, // /lol-gameflow/v1/session (wachtry en kaart), bv. { map: { id: 12 }, gameData: { queue: { id: 450, gameMode: 'ARAM' } } }
  };
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      // Vertraging vir 'n roete (bv. st.delay['POST /lol-perks/v1/pages'] = 1500): om gelyktydigheid te toets
      const wait = st.delay[`${req.method} ${req.url.split('?')[0]}`];
      if (wait) { delete st.delay[`${req.method} ${req.url.split('?')[0]}`]; return setTimeout(handle, wait); }
      return handle();
    });
    function handle() {
      const [u, qs] = req.url.split('?');
      const q = new URLSearchParams(qs || '');
      const m = req.method;
      const b = body ? JSON.parse(body) : null;
      let x;
      if (st.hang.has(u)) return;
      if (u === '/lol-gameflow/v1/gameflow-phase') return json(res, 200, st.phase);
      if (u === '/lol-gameflow/v1/session') return st.flow ? json(res, 200, st.flow) : json(res, 404, {});
      if (u === '/lol-champ-select/v1/session') return st.session ? json(res, 200, st.session) : json(res, 404, { message: 'No active delegate' });
      if (u === '/lol-summoner/v1/current-summoner') return json(res, 200, { summonerId: 777, puuid: ME, gameName: 'Me', tagLine: 'NA1', summonerLevel: 24, profileIconId: 1 });
      if (u === '/lol-platform-config/v1/namespaces/LoginDataPacket/platformId') return json(res, 200, 'NA1');
      if (u === '/data-store/v1/install-dir') return json(res, 200, install);
      if (u === '/lol-perks/v1/recommended-champion-positions') return json(res, 200, {});
      if (u === '/lol-perks/v1/pages' && m === 'GET') return json(res, 200, st.pages);
      if (u === '/lol-perks/v1/pages' && m === 'POST') {
        if (st.pages.length >= st.maxPages) return json(res, 400, { message: 'Max pages reached' });
        const p = { ...b, id: st.nextPage++, isDeletable: true, isEditable: true };
        if (p.current) st.pages.forEach((o) => (o.current = false));
        st.pages.push(p);
        return json(res, 200, p);
      }
      if ((x = /^\/lol-perks\/v1\/pages\/(\d+)$/.exec(u))) {
        const i = st.pages.findIndex((p) => p.id === Number(x[1]));
        if (i < 0) return json(res, 404, {});
        if (m === 'DELETE') {
          const was = st.pages[i].current;
          st.pages.splice(i, 1);
          if (was && st.pages[0]) st.pages[0].current = true; // League kies dan 'n ander bladsy
          return json(res, 204);
        }
        if (m === 'PUT') {
          st.pages[i] = { ...st.pages[i], ...b, id: st.pages[i].id };
          if (b.current) st.pages.forEach((o, j) => (o.current = j === i));
          return json(res, 201, st.pages[i]);
        }
      }
      if (u === '/lol-perks/v1/currentpage' && m === 'GET') return json(res, 200, st.pages.find((p) => p.current) || null);
      if (u === '/lol-perks/v1/currentpage' && m === 'PUT') {
        if (!st.pages.some((p) => p.id === b)) return json(res, 404, {});
        st.pages.forEach((p) => (p.current = p.id === b));
        return json(res, 204);
      }
      if (u === '/lol-champ-select/v1/session/my-selection' && m === 'PATCH') { st.selection = b; return json(res, 204); }
      if (u === '/lol-item-sets/v1/item-sets/777/sets' && m === 'GET') return json(res, 200, st.sets);
      if (u === '/lol-item-sets/v1/item-sets/777/sets' && m === 'PUT') {
        st.puts.push(b);
        // Die kliënt se skema: onbekende velde (soos "priority") val weg
        st.sets = { accountId: b.accountId, timestamp: b.timestamp, itemSets: (b.itemSets || []).map((s) => Object.fromEntries(ITEM_SET_FIELDS.filter((k) => k in s).map((k) => [k, s[k]]))) };
        return json(res, 201);
      }
      if ((x = /^\/lol-match-history\/v1\/products\/lol\/([^/]+)\/matches$/.exec(u))) {
        const who = decodeURIComponent(x[1]);
        st.historyCalls.push(`${who}:${q.get('begIndex')}-${q.get('endIndex')}`);
        if (who !== ME && who !== 'current-summoner') return json(res, 200, { games: { games: [] } });
        const key = 'me';
        if (!st.historyCache.has(key)) {
          const beg = Number(q.get('begIndex') || 0);
          const end = Math.min(Number(q.get('endIndex') || 19), games - 1);
          const list = [];
          for (let i = beg; i <= end; i++) list.push(lcuGame(i, { full: false }));
          st.historyCache.set(key, list);
        }
        const list = st.historyCache.get(key);
        return json(res, 200, { accountId: 1, platformId: 'NA1', games: { gameCount: list.length, games: list } });
      }
      if ((x = /^\/lol-match-history\/v1\/games\/(\d+)$/.exec(u))) {
        st.gameCalls++;
        const i = Number(x[1]) - 9000;
        if (badGames.has(i)) return json(res, 500, { message: 'RPC_ERROR' });
        return json(res, 200, lcuGame(i));
      }
      if ((x = /^\/lol-summoner\/v2\/summoners\/puuid\/(.+)$/.exec(u))) return json(res, 200, { puuid: decodeURIComponent(x[1]), gameName: 'Me', tagLine: 'NA1', summonerLevel: 24, profileIconId: 1 });
      if (u.startsWith('/lol-ranked/v1/ranked-stats/')) return json(res, 200, { queueMap: {} });
      if (u.endsWith('/champion-mastery')) return json(res, 200, []);
      json(res, 404, {});
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const lockfile = path.join(install, 'lockfile');
    fs.writeFileSync(lockfile, `LeagueClient:1:${server.address().port}:testpass:http`);
    resolve({ server, st, lockfile, install, ME });
  }));
}

function champSelect(championId, role = 'middle', { locked = true, enemies = [] } = {}) {
  return {
    localPlayerCellId: 0,
    myTeam: [{ cellId: 0, championId, assignedPosition: role, spell1Id: 4, spell2Id: 14, puuid: ME, gameName: 'Me', tagLine: 'NA1' }],
    theirTeam: enemies.map((c, i) => ({ cellId: 5 + i, championId: c })),
    actions: [[{ actorCellId: 0, type: 'pick', completed: locked, championId }]],
  };
}

module.exports = { startFakeLcu, champSelect, lcuGame, ME };
