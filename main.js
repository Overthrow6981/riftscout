// RiftScout desktop-app (Electron)
// Begin die plaaslike server, maak die hoofvenster oop
// en kyk outomaties vir opdaterings op GitHub Releases.

const { app, BrowserWindow, shell, dialog, safeStorage, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const { startServer, getPrefs, saveBuildData, cleanupOnQuit, setUpdateState, onInstallRequest, isBusy, onChampSelectStart } = require('./server');
const updates = require('./updater');

let win = null;
let port = 0;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(boot);
}

async function boot() {
  // Die blad vra niks (kamera, mikrofoon, kennisgewings, ligging ...): Electron sê andersins by verstek ja
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // Vaste poort sodat die blad se oorsprong (en dus localStorage: laaste soektog ens.) dieselfde bly.
  // As die poort besig is, kies die stelsel 'n vrye een.
  const dataDir = app.getPath('userData');
  try {
    // Die opsionele Riot-sleutel word met Windows se eie versleuteling (DPAPI, via safeStorage) gestoor
    const secrets = {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(String(text)).toString('base64'),
      decrypt: (b64) => safeStorage.decryptString(Buffer.from(String(b64), 'base64')),
    };
    port = await startServer({ port: 51735, dataDir, secrets }).catch(() => startServer({ port: 0, dataDir, secrets }));
  } catch (err) {
    dialog.showErrorBox('RiftScout', 'Could not start: ' + err.message);
    app.quit();
    return;
  }

  win = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#0e1015',
    title: 'RiftScout',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(`http://127.0.0.1:${port}`);

  // Eksterne skakels (bv. developer.riotgames.com) gaan na die gewone blaaier – net https, niks anders nie
  // (shell.openExternal met file:, smb: ens. kan programme oopmaak)
  const appOrigin = `http://127.0.0.1:${port}`;
  const isApp = (url) => { try { return new URL(url).origin === appOrigin; } catch { return false; } };
  const openSafe = (url) => { try { if (new URL(url).protocol === 'https:') shell.openExternal(url); } catch { /* ongeldige skakel */ } };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isApp(url)) { e.preventDefault(); openSafe(url); }
  });
  win.webContents.on('will-redirect', (e, url) => { if (!isApp(url)) e.preventDefault(); });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.on('closed', () => app.quit());

  setupUpdates();
  onChampSelectStart(bringToFront);
}

// Sodra champ select begin: RiftScout na vore (soos Blitz), sodat jy dadelik jou picks en runes sien
function bringToFront() {
  if (!win || win.isDestroyed() || !getPrefs().openOnChampSelect) return;
  if (win.isMinimized()) win.restore();
  win.show();
  // Windows laat 'n ander app nie sommer die fokus vat nie; kortstondig "altyd bo" werk wel
  win.setAlwaysOnTop(true);
  win.moveTop();
  win.focus();
  setTimeout(() => { if (win && !win.isDestroyed()) win.setAlwaysOnTop(false); }, 600);
}

// ---------- Opdaterings ----------
function setupUpdates() {
  if (!app.isPackaged) return; // net in die geïnstalleerde app
  const u = updates.setupUpdates({
    updater: autoUpdater,
    isBusy,
    onState: setUpdateState,
    beforeInstall: saveBuildData,
  });
  onInstallRequest(() => u.install());
}

app.on('will-quit', () => {
  saveBuildData();
  cleanupOnQuit();
});
app.on('window-all-closed', () => app.quit());
