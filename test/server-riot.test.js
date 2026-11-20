// Bediener-toetse met 'n (nagemaakte) Riot API wat hang of die sleutel weier
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMock, call } = require('./helpers');

let mock;
let port;
let mode = 'hang';
before(async () => {
  mock = await startMock({ riotMode: () => mode });
  const base = `http://127.0.0.1:${mock.port}`;
  process.env.LCU_LOCKFILE = path.join(os.tmpdir(), 'no-such-lockfile');
  process.env.DDRAGON_BASE = `${base}/dd`;
  process.env.REMOTE_BUILDS_URL = `${base}/builds.json`;
  process.env.RIOT_HOST_TEMPLATE = `${base}/riot/{route}`;
  process.env.RIOT_API_KEY = 'RGAPI-00000000-0000-0000-0000-000000000000'; // vals toetssleutel
  process.env.RIOT_TIMEOUT_MS = '800';
  process.env.CRAWL_PACE_MS = '100000000'; // versamelaar doen niks in die toets
  const server = require('../server');
  port = await server.startServer({ port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rs-riot-')) });
});
after(() => { mock.server.close(); setTimeout(() => process.exit(0), 50); });

test('as die Riot API hang, kry die gebruiker binne die tydsbeperking \'n duidelike fout', async () => {
  mode = 'hang';
  const t0 = Date.now();
  const r = await call(port, 'GET', '/api/profile?region=euw1&riotId=Slow%23EUW');
  assert.equal(r.status, 504);
  assert.match(r.json.error, /not responding/);
  assert.ok(Date.now() - t0 < 5000, 'hang nie vir altyd nie');
});

test('as Riot die sleutel weier, sê die app dit reguit', async () => {
  mode = '403';
  const r = await call(port, 'GET', '/api/profile?region=euw1&riotId=Someone%23EUW');
  assert.equal(r.status, 403);
  assert.match(r.json.error, /API key rejected/);
});
