#!/usr/bin/env node
// Versamel build-data vir 'n beperkte tyd en skryf dit na 'n JSON-lêer.
// Word deur GitHub Actions gebruik (.github/workflows/collect-builds.yml) om gedeelde data
// vir alle RiftScout-gebruikers te bou.
//
//   RIOT_API_KEY=RGAPI-... node tools/collect.js --region na1 --minutes 60 --file builds.json --seen builds-seen.json

const path = require('path');
const { BuildDB, SeenSet, Crawler, itemsFromDDragon, itemClassifier } = require('../builds');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
  return acc;
}, []));
const REGION = args.region || 'na1';
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
const stamps = [];
async function takeSlot() {
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
  await takeSlot();
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
  const v = (await (await fetch(`${DDRAGON}/api/versions.json`)).json())[0];
  const cls = itemClassifier(itemsFromDDragon(await (await fetch(`${DDRAGON}/cdn/${v}/data/en_US/item.json`)).json()));
  const db = new BuildDB(FILE);
  const seen = new SeenSet(SEEN);
  const before = db.data.matches;
  const crawler = new Crawler({
    riot, db, seen,
    getRegion: () => REGION,
    getClassifier: () => cls,
    hasKey: () => true,
    isUserBusy: () => false,
    paceMs: 0,
    log: (m) => console.log(m),
  });
  console.log(`Collecting from ${REGION} for ${MINUTES} minutes (Data Dragon ${v}, ${before} matches so far)…`);
  crawler.start();
  const end = Date.now() + MINUTES * 60000;
  while (Date.now() < end && crawler.running) {
    await sleep(Math.min(60000, end - Date.now()));
    console.log(`  ${crawler.session} new matches (${crawler.state})`);
  }
  await crawler.stop();
  crawler.save();
  console.log(`Done: ${crawler.session} new matches, ${db.data.matches} in total.`);
  if (crawler.lastError && /expired|invalid/i.test(crawler.lastError)) {
    console.error('The RIOT_API_KEY secret is expired or invalid. Update it under Settings > Secrets and variables > Actions.');
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
