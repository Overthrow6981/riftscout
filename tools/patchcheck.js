// Kontroleer RiftScout teen die nuutste League-patch (Data Dragon) en teen die gedeelde build-data.
// Loop in GitHub Actions (.github/workflows/patch-check.yml), want daar is Data Dragon bereikbaar.
// Skryf 'n verslag (Engels, vir die GitHub issue) na patch-report.md en stel die uitsette "patch" en "status".
//
//   node tools/patchcheck.js
//   Omgewing: TESTS=success|failure (uitslag van npm test), GITHUB_REPOSITORY, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY

const fs = require('fs');
const zlib = require('zlib');
const builds = require('../builds');

const DDRAGON = process.env.DDRAGON_BASE || 'https://ddragon.leagueoflegends.com';
const REPO = process.env.GITHUB_REPOSITORY || 'Overthrow6981/riftscout';
const BUILD_DATA = process.env.REMOTE_BUILDS_URL || `https://github.com/${REPO}/releases/download/build-data/builds.json`;
const BUILD_STATUS = process.env.REMOTE_STATUS_URL || BUILD_DATA.replace(/builds\.json$/, 'build-status.json');
const STALE_MS = 24 * 3600e3;

const fail = [];
const warn = [];
const info = [];

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}
async function getBuildData() {
  try {
    const r = await fetch(`${BUILD_DATA}.gz`, { signal: AbortSignal.timeout(120000) });
    if (r.ok) return JSON.parse(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8'));
  } catch { /* probeer die gewone lêer */ }
  return getJson(BUILD_DATA);
}

// Al die item-, rune- en spell-ID's wat RiftScout uit die build-data kan aanbeveel, met hoeveel games elkeen het
function idsInData(data) {
  const items = new Map();
  const runes = new Map();
  const spells = new Map();
  const add = (m, id, n) => m.set(String(id), (m.get(String(id)) || 0) + n);
  const walk = (s) => {
    if (!s) return;
    for (const [k, [n]] of Object.entries(s.runes || {})) {
      const p = builds.parseRuneKey(k);
      for (const id of [p.primaryStyleId, p.subStyleId, ...p.primary, ...p.secondary]) add(runes, id, n);
    }
    for (const [k, [n]] of Object.entries(s.spells || {})) for (const id of k.split(',')) add(spells, id, n);
    for (const [k, [n]] of Object.entries(s.start || {})) for (const id of k.split(',')) add(items, id, n);
    for (const [k, [n]] of Object.entries(s.core || {})) for (const id of k.split('-')) add(items, id, n);
    for (const key of ['boots', 'items', 'item4', 'item5', 'item6']) for (const [k, [n]] of Object.entries(s[key] || {})) add(items, k, n);
  };
  for (const p of Object.values(data.patches || {})) {
    for (const roles of Object.values(p.champs || {})) {
      for (const s of Object.values(roles)) { walk(s); for (const m of Object.values(s.vs || {})) walk(m); }
    }
  }
  return { items, runes, spells };
}

const top = (map, n = 12) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n);

async function main() {
  // ---------- Data Dragon ----------
  const versions = await getJson(`${DDRAGON}/api/versions.json`);
  const v = versions[0];
  const patch = builds.patchOf(v);
  const base = `${DDRAGON}/cdn/${v}/data/en_US`;
  const [champs, items, runes, spells] = await Promise.all([
    getJson(`${base}/champion.json`), getJson(`${base}/item.json`), getJson(`${base}/runesReforged.json`), getJson(`${base}/summoner.json`),
  ]);
  info.push(`Newest Data Dragon version: **${v}** (patch ${patch}); previous: ${versions[1] || '?'}.`);

  // Die velde wat RiftScout uit Data Dragon lees
  const champList = Object.values((champs && champs.data) || {});
  if (champList.length < 150 || champList.some((c) => !c.key || !c.id || !c.name || !Array.isArray(c.tags))) {
    fail.push(`champion.json looks different (${champList.length} champions, or key/id/name/tags missing).`);
  }
  const itemList = Object.entries((items && items.data) || {});
  if (itemList.length < 150 || itemList.some(([, it]) => !it.gold || typeof it.gold.total !== 'number' || !Array.isArray(it.tags || []))) {
    fail.push(`item.json looks different (${itemList.length} items, or gold/tags missing).`);
  }
  if (!Array.isArray(runes) || runes.length < 5 || runes.some((st) => !st.id || !Array.isArray(st.slots) || st.slots.some((sl) => !Array.isArray(sl.runes)))) {
    fail.push('runesReforged.json looks different (rune trees or slots missing).');
  }
  const spellList = Object.values((spells && spells.data) || {});
  if (spellList.length < 8 || spellList.some((s) => !s.key || !s.name)) fail.push('summoner.json looks different (summoner spells missing).');

  // Item-klassifikasie (boots en voltooide items) soos die app dit doen
  const full = builds.itemsFromDDragon(items);
  const cls = builds.itemClassifier(full);
  const srIds = Object.entries(full).filter(([, it]) => it.sr).map(([id]) => id);
  const boots = srIds.filter((id) => cls.isBoots(id));
  const completed = srIds.filter((id) => cls.isCompleted(id));
  if (boots.length < 3) fail.push(`Only ${boots.length} boots found on Summoner's Rift – RiftScout's boots detection (tag "Boots", 500+ gold, not 1001) no longer matches the items.`);
  else info.push(`Boots on Summoner's Rift: ${boots.map((id) => `${full[id].name} (${id})`).join(', ')}.`);
  if (completed.length < 30) fail.push(`Only ${completed.length} completed items found – the completed-item detection no longer matches.`);
  for (const [id, name] of [['2003', 'Health Potion'], ['2055', 'Control Ward']]) {
    if (!full[id] || !full[id].sr) warn.push(`${name} (${id}) is no longer on Summoner's Rift – the "Consumables" block now leaves it out.`);
  }
  if (!champList.some((c) => c.id === 'Cassiopeia')) info.push('Cassiopeia is gone from champion.json – the "no boots for Cassiopeia" rule in server.js can go.');

  const validRunes = new Set();
  for (const st of runes || []) { validRunes.add(String(st.id)); for (const sl of st.slots || []) for (const r of sl.runes || []) validRunes.add(String(r.id)); }
  const validSpells = new Set(spellList.map((s) => String(s.key)));
  const validItems = new Set(srIds);

  // ---------- Build-data ----------
  let data = null;
  try { data = await getBuildData(); } catch (e) { fail.push(`Could not download the shared build data (${e.message}).`); }
  if (data) {
    const patches = Object.keys(data.patches || {}).sort(builds.comparePatch).reverse();
    const counts = patches.map((p) => `${p}: ${(data.patches[p] || {}).matches || 0}`).join(', ');
    const updated = data.updated ? new Date(data.updated).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown';
    const newest = data.lastMatchAt ? new Date(data.lastMatchAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown';
    info.push(`Shared build data: ${data.matches || 0} games (${counts || 'no patches'}); newest game added ${newest}; file last written ${updated}.`);
    const now = (data.patches[patch] || {}).matches || 0;
    if (!now) {
      warn.push(`The shared build data has **no games from patch ${patch}** yet. If this stays so for more than a day after the patch, the collector is not collecting – usually the RIOT_API_KEY secret has expired (development keys last 24 hours).`);
    } else if (now < 100) {
      warn.push(`Only ${now} games from patch ${patch} so far – builds still lean on older patches.`);
    }
    if (patches[0] && builds.comparePatch(patches[0], patch) > 0) warn.push(`The build data has a newer patch (${patches[0]}) than Data Dragon (${patch}).`);

    const used = idsInData(data);
    const goneItems = top(new Map([...used.items].filter(([id]) => !validItems.has(id))));
    const goneRunes = top(new Map([...used.runes].filter(([id]) => !validRunes.has(id))));
    const goneSpells = top(new Map([...used.spells].filter(([id]) => !validSpells.has(id))));
    if (goneItems.length) {
      info.push(`Items in the build data that are not on Summoner's Rift in ${v} (RiftScout no longer recommends them): ${goneItems.map(([id, n]) => `${id} (${n} picks)`).join(', ')}.`);
    }
    if (goneRunes.length) info.push(`Runes in the build data that no longer exist in ${v} (pages with them are skipped): ${goneRunes.map(([id, n]) => `${id} (${n})`).join(', ')}.`);
    if (goneSpells.length) warn.push(`Summoner spells in the build data that no longer exist in ${v}: ${goneSpells.map(([id, n]) => `${id} (${n})`).join(', ')}.`);

    const inData = new Set();
    for (const p of Object.values(data.patches || {})) for (const id of Object.keys(p.champs || {})) inData.add(id);
    const fresh = champList.filter((c) => !inData.has(String(c.key))).map((c) => c.name);
    if (fresh.length) info.push(`Champions with no games in the build data yet (new or rarely played): ${fresh.slice(0, 15).join(', ')}${fresh.length > 15 ? ` and ${fresh.length - 15} more` : ''}. RiftScout falls back to Riot's own recommended runes and to similar champions' items for them.`);
  }

  // ---------- Versamelaar se status (build-status.json, sien tools/collect.js) ----------
  let st = null;
  try { st = await getJson(BUILD_STATUS); } catch { /* ouer versamelaar: nog geen statuslêer nie */ }
  const when = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'never');
  if (!st) {
    warn.push('No collector status file (build-status.json) in the build-data release yet – it appears after the next "Collect build data" run.');
  } else {
    info.push(`Collector: last run ${when(st.lastRun)} (${st.ok ? `${st.newMatches} new games` : st.error || 'no new games'}); last run with new games ${when(st.lastSuccess)}; newest game added ${when(st.lastMatchAt)}.`);
    if (st.error === 'key_invalid' || st.error === 'key_missing') {
      fail.push(`The collector cannot collect: ${st.message || st.error}. The owner must renew the RIOT_API_KEY repository secret – the shared build data is not getting new games.`);
    } else if (!st.lastSuccess || Date.now() - st.lastSuccess > STALE_MS) {
      warn.push(`The shared build data has had no new games since ${when(st.lastSuccess)} (last error: ${st.message || st.error || 'none'}).`);
    }
  }

  // ---------- Toetse ----------
  if (process.env.TESTS && process.env.TESTS !== 'success') fail.push(`The unit tests did not pass on this run (${process.env.TESTS}).`);
  else if (process.env.TESTS) info.push('Unit tests: all passed.');

  const status = fail.length ? 'fail' : warn.length ? 'warn' : 'ok';
  const head = { ok: '✅ Everything RiftScout reads from League still matches this patch.', warn: '⚠️ Works, but something needs attention.', fail: '❌ Something in this patch breaks an assumption RiftScout makes – a code change is needed.' }[status];
  const list = (title, xs) => (xs.length ? `### ${title}\n${xs.map((x) => `- ${x}`).join('\n')}\n` : '');
  const report = `## League patch ${patch} – RiftScout check\n\n${head}\n\n${list('Problems', fail)}${list('Warnings', warn)}${list('Details', info)}\n`
    + `_Checked ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC by the "Patch check" workflow. This issue is updated on every run during this patch._\n`;
  fs.writeFileSync('patch-report.md', report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `patch=${patch}\nstatus=${status}\n`);
  console.log(report);
}

main().catch((e) => {
  const report = `## RiftScout patch check could not run\n\n❌ ${e.message}\n`;
  fs.writeFileSync('patch-report.md', report);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'patch=unknown\nstatus=fail\n');
  console.error(report);
  process.exitCode = 0; // die werkvloei skryf steeds 'n issue
});
