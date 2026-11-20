#!/usr/bin/env node
// Versamel build-data vir 'n beperkte tyd en skryf dit na 'n JSON-lêer.
// Word deur GitHub Actions gebruik (.github/workflows/collect-builds.yml) om gedeelde data
// vir alle RiftScout-gebruikers te bou.
//
//   RIOT_API_KEY=RGAPI-... node tools/collect.js --region all --minutes 60 --file builds.json --seen builds-seen.json
//
// --region: 'all' (elke bediener), of een of meer bedieners met kommas, bv. euw1,na1,kr
// Riot se rate limits geld per streek (europe, americas, asia, sea), so al die streke saam
// versamel omtrent 4 keer soveel wedstryde per uur as een bediener.

const path = require('path');
const { BuildDB, SeenSet, Crawler, PLATFORM_ROUTE, itemsFromDDragon, itemClassifier } = require('../builds');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
  return acc;
}, []));
const REGION_ARG = String(args.region || 'all').toLowerCase();
const REGIONS = REGION_ARG === 'all'
  ? Object.keys(PLATFORM_ROUTE)
  : REGION_ARG.split(',').map((r) => r.trim()).filter((r) => PLATFORM_ROUTE[r]);
const MINUTES = Number(args.minutes || 60);
const FILE = path.resolve(args.file || 'builds.json');
const SEEN = path.resolve(args.seen || 'builds-seen.json');
const KEY = (process.env.RIOT_API_KEY || '').trim();
const HOST_TEMPLATE = process.env.RIOT_HOST_TEMPLATE || 'https://{route}.api.riotgames.com';
const DDRAGON = process.env.DDRAGON_BASE || 'https://ddragon.leagueoflegends.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WINDOWS = [
  { limit: Number(process.env.RATE_PER_SECOND) || 20, ms: 1000 },
  { limit: Number(process.env.RATE_PER_2MIN) || 100, ms: 120000 },
];
// Een limiet per gasheer (euw1, europe, na1, americas, …) – so tel Riot dit ook
const stampsByHost = {};
async function takeSlot(host) {
  const stamps = stampsByHost[host] || (stampsByHost[host] = []);
  for (;;) {
    const now = Date.now();
    while (stamps.length && now - stamps[0] >= 120000) stamps.shift();
    let wait = 0;
    for (const w of WINDOWS) {
      const recent = stamps.filter((t) => now - t < w.ms);
      if (recent.length >= w.limit) wait = Math.max(wait, w.ms - (now - recent[0]) + 10);
    }
    if (!wait) { stamps.push(now); return; }
    await sleep(wait);
  }
}

async function riot(route, apiPath, attempt = 0) {
  await takeSlot(route);
  const res = await fetch(HOST_TEMPLATE.replace('{route}', route) + apiPath, { headers: { 'X-Riot-Token': KEY } });
  if (res.status === 429 && attempt < 5) {
    await sleep((Number(res.headers.get('retry-after')) || 5) * 1000);
    return riot(route, apiPath, attempt + 1);
  }
  if (!res.ok) {
    const e = new Error(`Riot API ${res.status} for ${apiPath}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

(async () => {
  if (!KEY) { console.log('No RIOT_API_KEY set - nothing to do.'); return; }
  if (!REGIONS.length) { console.error(`Unknown region "${REGION_ARG}".`); process.exit(1); }
  const v = (await (await fetch(`${DDRAGON}/api/versions.json`)).json())[0];
  const cls = itemClassifier(itemsFromDDragon(await (await fetch(`${DDRAGON}/cdn/${v}/data/en_US/item.json`)).json()));
  const db = new BuildDB(FILE);
  const seen = new SeenSet(SEEN);
  const before = db.data.matches;
  // Een versamelaar per bediener; almal skryf in dieselfde databasis
  const crawlers = REGIONS.map((region) => new Crawler({
    riot, db, seen,
    getRegion: () => region,
    getClassifier: () => cls,
    hasKey: () => true,
    isUserBusy: () => false,
    paceMs: 0,
    autoSave: false,
    log: (m) => console.log(`[${region}] ${m}`),
  }));
  const saveAll = () => { try { db.save(); seen.save(); } catch (err) { console.error('save failed: ' + err.message); } };
  let stopping = false;
  const stopAll = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.all(crawlers.map((c) => c.stop()));
    saveAll();
  };
  // As die werk gekanselleer word: stoor eers wat ons het
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await stopAll(); process.exit(0); });

  console.log(`Collecting from ${REGIONS.join(', ')} for ${MINUTES} minutes (Data Dragon ${v}, ${before} matches so far)…`);
  crawlers.forEach((c) => c.start());
  const end = Date.now() + MINUTES * 60000;
  let lastSave = Date.now();
  while (Date.now() < end && crawlers.some((c) => c.running)) {
    await sleep(Math.min(60000, end - Date.now()));
    const total = crawlers.reduce((n, c) => n + c.session, 0);
    console.log(`  ${total} new matches (${crawlers.map((c) => `${c.region || '?'} ${c.session}`).join(', ')})`);
    if (Date.now() - lastSave > 5 * 60000) { saveAll(); lastSave = Date.now(); }
  }
  await stopAll();
  const total = crawlers.reduce((n, c) => n + c.session, 0);
  console.log(`Done: ${total} new matches, ${db.data.matches} in total.`);
  const keyErr = crawlers.map((c) => c.lastError).find((e) => e && /expired|invalid/i.test(e));
  if (keyErr) {
    console.error('The RIOT_API_KEY secret is expired or invalid. Update it under Settings > Secrets and variables > Actions.');
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
