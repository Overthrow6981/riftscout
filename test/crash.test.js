// As RiftScout onverwags toegemaak is (bv. gekrash of deur Taakbestuurder gestop) terwyl sy set in die winkel
// was: by die volgende begin bly die set terwyl 'n game nog loop, en gaan uit sodra die game klaar is.
// Blitz se lêers en ander lêers word nie aangeraak nie (die "replace Blitz" voorkeur is hier af).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMock, call, until } = require('./helpers');
const { startFakeLcu } = require('./fakelcu');

let mock;
let fake;
let port;
let shopDir;
before(async () => {
  mock = await startMock();
  fake = await startFakeLcu({ games: 5 });
  const base = `http://127.0.0.1:${mock.port}`;
  process.env.LCU_LOCKFILE = fake.lockfile;
  process.env.DDRAGON_BASE = `${base}/dd`;
  process.env.REMOTE_BUILDS_URL = `${base}/builds.json`;
  process.env.RIOT_HOST_TEMPLATE = `${base}/riot/{route}`;
  process.env.LIVE_CLIENT_URL = 'https://127.0.0.1:1/liveclientdata/allgamedata';
  process.env.CRAWL_PACE_MS = '100000000';
  delete process.env.RIOT_API_KEY;
  shopDir = path.join(fake.install, 'Config', 'Global', 'Recommended');
  fs.mkdirSync(shopDir, { recursive: true });
  // Oorblyfsels van die vorige keer (RiftScout is in die middel van 'n game toegemaak)
  for (const i of [0, 1, 2]) fs.writeFileSync(path.join(shopDir, `!!!riftscout-${i}.json`), JSON.stringify({ title: `RiftScout Annie ${i}`, blocks: [] }));
  fs.writeFileSync(path.join(shopDir, '!!!blitz-0.json'), JSON.stringify({ title: 'Blitz: Crit Miss Fortune', blocks: [] }));
  fs.writeFileSync(path.join(shopDir, 'someone-else.json'), JSON.stringify({ title: 'Other app', blocks: [] }));
  fake.st.phase = 'InProgress'; // die game loop nog as RiftScout weer oopmaak
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-crash-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ prefs: { replaceBlitzSets: false } }));
  port = await require('../server').startServer({ port: 0, dataDir });
});
after(() => { mock.server.close(); fake.server.close(); setTimeout(() => process.exit(0), 50); });

const ours = () => fs.readdirSync(shopDir).filter((n) => n.startsWith('!!!riftscout-')).sort();

test('ná \'n onverwagte afsluiting: die set bly tydens die game, en gaan net daarna uit (ander lêers bly)', async () => {
  await new Promise((r) => setTimeout(r, 5000));
  assert.equal(ours().length, 3, 'tydens die game word niks uitgehaal nie');
  fake.st.phase = 'EndOfGame';
  assert.ok(await until(() => ours().length === 0, 10000), 'ná die game is RiftScout se oorblyfsels weg');
  assert.deepEqual(fs.readdirSync(shopDir).sort(), ['!!!blitz-0.json', 'someone-else.json'], 'Blitz en ander apps se lêers bly');
  const act = (await call(port, 'GET', '/api/activity')).json.events.map((e) => e.msg).join('\n');
  assert.match(act, /item set out of the shop \(left over from last time\)/);
});
