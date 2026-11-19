// RiftScout desktop-app (Electron)
// Begin die plaaslike server, maak 'n venster oop, en kyk outomaties vir opdaterings op GitHub Releases.

const { app, BrowserWindow, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { startServer } = require('./server');

let win = null;

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
  let port;
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

  setupUpdates();
}

function setupUpdates() {
  if (!app.isPackaged) return; // net in die geïnstalleerde app
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `RiftScout ${info.version} has been downloaded.`,
      detail: 'Restart now to install it, or it will install the next time you close RiftScout.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (err) => console.error('Update error:', err && err.message));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 60 * 60 * 1000); // elke uur
}

app.on('window-all-closed', () => app.quit());
