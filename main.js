// RiftScout desktop-app (Electron)
// Begin die plaaslike server, maak die hoofvenster en die in-game oorleg oop,
// en kyk outomaties vir opdaterings op GitHub Releases.

const { app, BrowserWindow, shell, dialog, screen, globalShortcut } = require('electron');
const { autoUpdater } = require('electron-updater');
const { startServer, getLiveData, getPrefs, saveBuildData, setUpdateState, onInstallRequest, isBusy } = require('./server');
const updates = require('./updater');

const OVERLAY_W = 300;
const OVERLAY_H = 300;

let win = null;
let overlay = null;
let overlayHiddenByUser = false;
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

  setupOverlay();
  setupUpdates();
}

// ---------- In-game oorleg ----------
// 'n Deursigtige venster bo-op die spel wat muisklikke deurlaat. Werk in Borderless/Windowed modus
// (nie in eksklusiewe fullscreen nie). Ctrl+Shift+O wys/versteek dit.
function createOverlay() {
  overlay = new BrowserWindow({
    width: OVERLAY_W,
    height: OVERLAY_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadURL(`http://127.0.0.1:${port}/overlay.html`);
  overlay.on('closed', () => { overlay = null; });
}

function placeOverlay(position) {
  const { bounds } = screen.getPrimaryDisplay();
  const right = bounds.x + bounds.width - OVERLAY_W - 12;
  const pos = {
    right: { x: right, y: bounds.y + Math.round(bounds.height * 0.3) },
    left: { x: bounds.x + 12, y: bounds.y + Math.round(bounds.height * 0.3) },
    'top-right': { x: right, y: bounds.y + 90 },
  }[position] || { x: right, y: bounds.y + Math.round(bounds.height * 0.3) };
  overlay.setBounds({ x: pos.x, y: pos.y, width: OVERLAY_W, height: OVERLAY_H });
}

function setupOverlay() {
  globalShortcut.register('Control+Shift+O', () => {
    overlayHiddenByUser = !overlayHiddenByUser;
    refreshOverlay();
  });
  setInterval(refreshOverlay, 2000);
}

let refreshing = false;
let misses = 0;
async function refreshOverlay() {
  if (refreshing) return;
  refreshing = true;
  try {
    const prefs = getPrefs();
    const live = await getLiveData();
    // Een trae antwoord van die spel beteken nie die wedstryd is verby nie
    misses = live.inGame ? 0 : misses + 1;
    const inGame = live.inGame || (overlay && misses < 3);
    if (!inGame) overlayHiddenByUser = false;
    const show = prefs.overlay && inGame && !overlayHiddenByUser;
    if (show) {
      if (!overlay) {
        createOverlay();
        placeOverlay(prefs.overlayPosition);
        overlay.once('ready-to-show', () => { if (overlay) overlay.showInactive(); });
      } else {
        placeOverlay(prefs.overlayPosition);
        overlay.setAlwaysOnTop(true, 'screen-saver');
      }
    } else if (overlay) {
      // Maak die venster heeltemal toe; die volgende wedstryd kry 'n vars een
      overlay.destroy();
      overlay = null;
    }
  } catch { /* volgende keer weer */ } finally {
    refreshing = false;
  }
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
  globalShortcut.unregisterAll();
  saveBuildData();
});
app.on('window-all-closed', () => app.quit());
