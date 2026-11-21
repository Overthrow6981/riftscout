// Klein nagemaakte Data Dragon + gedeelde build-data + Riot API vir die bediener-toetse
const http = require('http');
const zlib = require('zlib');
const b = require('../builds');

function sharedData() {
  const db = new b.BuildDB('/nonexistent/never-saved.json');
  db.data = { version: 1, matches: 0, updated: Date.now(), patches: {}, regions: { euw1: 3, kr: 2 } };
  const row = (c, vs, win, laneWin) => ({ championId: c, role: 'MIDDLE', vs, win, laneWin, runes: '8100:8112,8139,8138,8135|8200:8226,8210|5008,5008,5001',
    spells: '4,14', start: '1056,2003', completed: [3089, 3157, 3135], boots: 3020, maxOrder: 'Q>W>E', skills: 'QWEQQRQWQWRWWEE' });
  // Annie (1) teen Zed (238): 6 uit 8 gewen, 5 uit 8 voor op 15 min
  for (let i = 0; i < 8; i++) db.addMatch('16.23', [row(1, 238, i < 6, i < 5), row(238, 1, i >= 6, i >= 5)]);
  for (let i = 0; i < 25; i++) db.addMatch('16.23', [row(1, 99, i % 2 === 0, true), row(99, 1, i % 2 === 1, false)]);
  return db.data;
}

function startMock({ riotMode = () => 'ok' } = {}) {
  const gz = zlib.gzipSync(JSON.stringify(sharedData()));
  const dd = {
    '/dd/api/versions.json': ['16.23.1'],
    '/dd/cdn/16.23.1/data/en_US/summoner.json': { data: { SummonerFlash: { key: '4', name: 'Flash', image: { full: 'SummonerFlash.png' } } } },
    '/dd/cdn/16.23.1/data/en_US/runesReforged.json': [{ id: 8100, name: 'Domination', icon: 'd.png', slots: [{ runes: [{ id: 8112, name: 'Electrocute', icon: 'e.png' }] }] }],
    '/dd/cdn/16.23.1/data/en_US/champion.json': { data: { Annie: { key: '1', id: 'Annie', name: 'Annie', tags: ['Mage'] }, Zed: { key: '238', id: 'Zed', name: 'Zed', tags: ['Assassin'] }, Lux: { key: '99', id: 'Lux', name: 'Lux', tags: ['Mage'] },
      Syndra: { key: '134', id: 'Syndra', name: 'Syndra', tags: ['Mage'] }, Cassiopeia: { key: '69', id: 'Cassiopeia', name: 'Cassiopeia', tags: ['Mage'] } } },
    '/dd/cdn/16.23.1/data/en_US/item.json': { data: { 3089: { name: "Rabadon's Deathcap", gold: { total: 3600 }, tags: [] } } },
  };
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (dd[u]) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(dd[u])); }
    if (u === '/builds.json.gz') { res.writeHead(200); return res.end(gz); }
    if (u.startsWith('/riot/')) {
      const mode = riotMode();
      if (mode === 'hang') return; // antwoord nooit
      if (mode === '403') { res.writeHead(403); return res.end('{}'); }
      res.writeHead(404); return res.end('{}');
    }
    res.writeHead(404); res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// HTTP-versoek na die app, met beheer oor Host/Origin-opskrifte
function call(port, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = { Host: `127.0.0.1:${port}`, ...headers };
    if (data && !h['Content-Type']) h['Content-Type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* nie JSON nie */ }
        resolve({ status: res.statusCode, text: buf, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
};

module.exports = { startMock, call, until };
