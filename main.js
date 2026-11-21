// RiftScout desktop-app (Electron)
// Begin die plaaslike server, maak die hoofvenster oop
// en kyk outomaties vir opdaterings op GitHub Releases.

const { app, BrowserWindow, shell, dialog } = require('electron');
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
  // Vaste poort sodat die blad se oorsprong (en dus localStorage: laaste soektog ens.) dieselfde bly.
  // As die poort besig is, kies die stelsel 'n vrye een.
  const dataDir = app.getPath('userData');
  try {
    port = await startServer({ port: 51735, dataDir }).catch(() => startServer({ port: 0, dataDir }));
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
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(`http://127.0.0.1:${port}`);

  // Eksterne skakels (bv. developer.riotgames.com) gaan na die gewone blaaier
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) { e.preventDefault(); shell.openExternal(url); }
  });
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
