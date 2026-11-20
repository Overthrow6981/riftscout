// Outomatiese updates.
// - Sodra die app oopmaak, soek hy 'n nuwe weergawe, laai dit af en installeer dit dadelik
//   (die app maak toe en weer oop) – behalwe as jy in champ select of 'n spel is.
// - Word 'n update later gevind, of is jy besig, wys die app 'n balk met "Restart now";
//   anders installeer dit vanself wanneer jy RiftScout toemaak.
const STARTUP_WINDOW_MS = 15 * 60 * 1000; // so lank ná oopmaak installeer ons sonder om te vra
const CHECK_EVERY_MS = 20 * 60 * 1000;

function setupUpdates({ updater, isBusy, onState, beforeInstall, log = console }) {
  const startedAt = Date.now();
  let version = '';
  let installing = false;
  let ready = null;
  const state = (s) => { try { onState(s); } catch { /* ignoreer */ } };

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.disableWebInstaller = true;

  updater.on('checking-for-update', () => { if (!ready && !installing) state({ state: 'checking' }); });
  updater.on('update-not-available', () => { if (!ready && !installing) state({ state: 'none' }); });
  updater.on('update-available', (info) => {
    version = info.version;
    state({ state: 'downloading', version, percent: 0 });
  });
  updater.on('download-progress', (p) => {
    state({ state: 'downloading', version, percent: Math.max(0, Math.min(100, Math.round((p && p.percent) || 0))) });
  });
  updater.on('update-downloaded', async (info) => {
    version = info.version;
    ready = info.version;
    let busy = false;
    try { busy = await isBusy(); } catch { busy = false; }
    if (!busy && Date.now() - startedAt < STARTUP_WINDOW_MS) { install(); return; }
    state({ state: 'ready', version, busy });
  });
  updater.on('error', (err) => {
    log.error('Update error:', err && err.message);
    if (!ready && !installing) state({ state: 'error', message: String((err && err.message) || err).slice(0, 200) });
  });

  function install() {
    if (installing || !ready) return false;
    installing = true;
    state({ state: 'installing', version: ready });
    try { beforeInstall(); } catch { /* ignoreer */ }
    // Stil installeer en daarna die nuwe weergawe self oopmaak
    setTimeout(() => updater.quitAndInstall(true, true), 1500);
    return true;
  }

  const check = () => {
    if (installing) return Promise.resolve();
    return updater.checkForUpdates().catch((err) => {
      log.error('Update check failed:', err && err.message);
      if (!ready) state({ state: 'error', message: String((err && err.message) || err).slice(0, 200) });
    });
  };
  check();
  const timer = setInterval(check, CHECK_EVERY_MS);
  return { install, check, stop: () => clearInterval(timer) };
}

module.exports = { setupUpdates, STARTUP_WINDOW_MS };
