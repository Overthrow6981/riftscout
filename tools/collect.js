#!/usr/bin/env node
// Versamel build-data vir 'n beperkte tyd en skryf dit na 'n JSON-lêer.
// Word deur GitHub Actions gebruik (.github/workflows/collect-builds.yml) om gedeelde data
// vir alle RiftScout-gebruikers te bou.
//
//   RIOT_API_KEY=RGAPI-... node tools/collect.js --region all --minutes 60 --file builds.json --seen builds-seen.json --status build-status.json
//
// Skryf ALTYD build-status.json (ok, lastRun, lastSuccess, lastMatchAt, newMatches, error ...), ook as die sleutel
// verval het, sodat die app en die "Patch check" kan wys dat die gedeelde data nie meer nuut is nie.
// builds.json word net verander as daar nuwe games bygekom het. Uitgangskodes: 0 = nuwe games, 2 = sleutel
// ontbreek of ongeldig, 1 = ander fout of geen nuwe games nie.
//
// --region: 'all' (elke bediener), of een of meer bedieners met kommas, bv. euw1,na1,kr
// Riot se rate limits geld per streek (europe, americas, asia, sea), so al die streke saam
// versamel omtrent 4 keer soveel wedstryde per uur as een bediener.

const fs = require('fs');
const path = require('path');
const { BuildDB, SeenSet, Crawler, PLATFORM_ROUTE, itemsFromDDragon, itemClassifier, comparePatch } = require('../builds');

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
const STATUS = path.resolve(args.status || 'build-status.json');
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
    const e = new Error(`Riot API ${res.status} for ${redact(apiPath)}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// ---------- Hulpfunksies (los getoets in test/collect.test.js) ----------
// Riot-sleutels kom nooit in die log nie (GitHub masker secrets ook, maar nie as die sleutel verander is nie)
const redact = (v) => String(v == null ? '' : v).replace(/RGAPI-[0-9a-f-]{8,}/gi, 'RGAPI-***');
// Vir die publieke statuslêer ook geen API-paaie nie (daarin staan speler-ID's soos puuids)
const publicText = (v) => redact(v).replace(/\/(lol|riot)\/\S*/g, '/$1/…');

// Uitslag van die vinnige sleutel-toets (een goedkoop versoek voor die versameling begin)
function classifyKeyCheck(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'key_invalid';
  return 'riot_unreachable'; // netwerk (status 0), 429, 5xx: nie die sleutel se skuld nie
}

const ERROR_TEXT = {
  key_missing: 'No RIOT_API_KEY secret is set.',
  key_invalid: 'The Riot API rejected the RIOT_API_KEY secret (expired or invalid). Development keys expire after 24 hours.',
  riot_unreachable: 'The Riot API could not be reached or kept failing.',
  no_new_matches: 'The run finished without any new games.',
  crashed: 'The collector stopped with an error.',
};
// Die statuslêer vir die app en die patch check. prev: die vorige lêer (uit die release) of null.
function buildStatus({ prev = null, now = Date.now(), newMatches = 0, data = null, error = null, message = null }) {
  const p = prev && typeof prev === 'object' ? prev : {};
  const d = data || {};
  const patches = Object.keys(d.patches || {}).sort(comparePatch).reverse();
  const added = newMatches > 0;
  const kind = added ? null : (error || 'no_new_matches');
  return {
    schema: 1,
    ok: added,
    lastRun: now,
    lastSuccess: added ? now : (p.lastSuccess || null),
    lastMatchAt: d.lastMatchAt || p.lastMatchAt || null,
    newMatches,
    totalMatches: d.matches || p.totalMatches || 0,
    patches: patches.length ? patches : (Array.isArray(p.patches) ? p.patches : []),
    error: kind,
    message: kind ? publicText(message || ERROR_TEXT[kind] || kind).slice(0, 300) : null,
  };
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeStatus(file, status) {
  fs.writeFileSync(file, JSON.stringify(status, null, 2));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `published=${status.ok ? 'true' : 'false'}\nerror=${status.error || ''}\n`);
}
const exitCodeFor = (status) => (status.ok ? 0 : ['key_missing', 'key_invalid'].includes(status.error) ? 2 : 1);

// Een goedkoop versoek wat 'n geldige sleutel nodig het
async function checkKey(region) {
  try {
    const res = await fetch(HOST_TEMPLATE.replace('{route}', region) + '/lol/status/v4/platform-data', {
      headers: { 'X-Riot-Token': KEY }, signal: AbortSignal.timeout(20000),
    });
    return { status: res.status, kind: classifyKeyCheck(res.status) };
  } catch (err) {
    return { status: 0, kind: 'riot_unreachable', message: `Riot API not reachable: ${redact(err.message)}` };
  }
}

const KEY_CHECK_RETRIES = Number(process.env.KEY_CHECK_RETRIES || 3);
const KEY_CHECK_WAIT_MS = Number(process.env.KEY_CHECK_WAIT_MS || 20000);

async function main() {
  const prev = readJson(STATUS);
  const finish = (fields) => {
    const st = buildStatus({ prev, ...fields });
    writeStatus(STATUS, st);
    return st;
  };
  if (!KEY) {
    console.log('No RIOT_API_KEY set - nothing to do.');
    return exitCodeFor(finish({ error: 'key_missing', data: readJson(FILE) }));
  }
  if (!REGIONS.length) { console.error(`Unknown region "${REGION_ARG}".`); return exitCodeFor(finish({ error: 'crashed', message: `Unknown region "${REGION_ARG}".`, data: readJson(FILE) })); }

  // Eers die sleutel toets (op die eerste bediener), sodat 'n vervalde sleutel dadelik duidelik is.
  // Net 401/403 stop die run; is Riot net besig of onbereikbaar (429, 5xx, netwerk), probeer 'n paar keer
  // en versamel dan tog (die versamelaar probeer self weer).
  let key = await checkKey(REGIONS[0]);
  for (let i = 0; key.kind === 'riot_unreachable' && i < KEY_CHECK_RETRIES; i++) {
    console.log(`Riot API key check: ${key.status ? `HTTP ${key.status}` : 'no answer'} – trying again…`);
    await sleep(KEY_CHECK_WAIT_MS);
    key = await checkKey(REGIONS[0]);
  }
  if (key.kind === 'key_invalid') {
    console.error(`The Riot API rejected the RIOT_API_KEY secret (HTTP ${key.status}). Renew it under Settings > Secrets and variables > Actions.`);
    return exitCodeFor(finish({ error: key.kind, data: readJson(FILE) }));
  }
  if (key.kind !== 'ok') console.log('The key check did not get an answer – collecting anyway.');

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
    log: (m) => console.log(`[${region}] ${redact(m)}`),
  }));
  const added = () => crawlers.reduce((n, c) => n + c.session, 0);
  // Net stoor as daar nuwe games is: anders bly builds.json (en sy tyd) soos dit was
  let saveError = null;
  const saveAll = () => {
    if (!added()) return;
    try { db.save(); seen.save(); saveError = null; } catch (err) { saveError = err; console.error('save failed: ' + redact(err.message)); }
  };
  let stopping = false;
  const stopAll = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.all(crawlers.map((c) => c.stop()));
    saveAll();
  };
  // As die werk gekanselleer word: stoor eers wat ons het, en die status
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await stopAll();
      const st = finish({ newMatches: added(), data: db.data, error: 'crashed', message: `Cancelled (${sig}).` });
      process.exit(exitCodeFor(st));
    });
  }

  console.log(`Collecting from ${REGIONS.join(', ')} for ${MINUTES} minutes (Data Dragon ${v}, ${before} matches so far)…`);
  crawlers.forEach((c) => c.start());
  const end = Date.now() + MINUTES * 60000;
  let lastSave = Date.now();
  while (Date.now() < end && crawlers.some((c) => c.running)) {
    await sleep(Math.min(60000, end - Date.now()));
    if (stopping) await new Promise(() => {}); // gekanselleer: die sein-hanteerder stoor en sluit af
    console.log(`  ${added()} new matches (${crawlers.map((c) => `${c.region || '?'} ${c.session}`).join(', ')})`);
    if (Date.now() - lastSave > 5 * 60000) { saveAll(); lastSave = Date.now(); }
  }
  if (stopping) await new Promise(() => {});
  await stopAll();
  const total = added();
  console.log(`Done: ${total} new matches, ${db.data.matches} in total.`);
  const errors = crawlers.map((c) => c.lastError).filter(Boolean);
  const keyErr = errors.find((e) => /expired|invalid/i.test(e));
  if (keyErr) console.error('The RIOT_API_KEY secret is expired or invalid. Update it under Settings > Secrets and variables > Actions.');
  if (saveError) {
    // Nuwe games, maar nie gestoor nie: niks publiseer nie
    return exitCodeFor(finish({ newMatches: 0, data: readJson(FILE), error: 'crashed', message: `Could not save the build data: ${saveError.message}` }));
  }
  const st = finish({
    newMatches: total, data: db.data,
    error: keyErr ? 'key_invalid' : errors.length ? 'riot_unreachable' : null,
    message: keyErr || errors[0] || null,
  });
  return exitCodeFor(st);
}

module.exports = { redact, publicText, classifyKeyCheck, buildStatus, exitCodeFor };

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(redact(err && err.stack ? err.stack : err));
    try { writeStatus(STATUS, buildStatus({ prev: readJson(STATUS), error: 'crashed', message: err && err.message, data: readJson(FILE) })); } catch { /* geen status */ }
    process.exit(1);
  });
}
