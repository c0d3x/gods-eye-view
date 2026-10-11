/**
 * God's Eye View as a Mac app: Electron's main process.
 *
 * It starts the local server (app/server.mjs) on 127.0.0.1 and shows the app
 * in one window. Keys live in the app's encrypted store (app/keyStore.mjs),
 * caches under ~/Library/Caches, and nothing is written inside the app
 * bundle. Provider Settings works as in the browser; saving a key restarts
 * the server and reloads the window.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  safeStorage,
  session,
  shell,
  systemPreferences,
} from 'electron';
import {
  APP_ID,
  appOrigin,
  isAppUrl,
  isExternalLink,
  toolPath,
  usbDeviceLabel,
} from './policy.mjs';

/** The app's files: the repository root, or Resources/app in the bundle. */
const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** @type {{port: number, url: string, close: () => Promise<void>} | null} */
let appServer = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
let restarting = false;

// `pnpm run app:dev` runs Electron's own, differently signed binary. A name
// of its own gives it separate settings and Keychain items, so it never
// leaves anything the installed app would have to ask permission to read.
if (!app.isPackaged) app.setName("God's Eye View (dev)");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.whenReady().then(start, fail);
}

/** @param {unknown} error */
function fail(error) {
  console.error("God's Eye View could not start:", error);
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("God's Eye View could not start", message);
  app.quit();
}

async function start() {
  // The server keeps its caches under the working directory (.gev-cache),
  // and some modules fix those paths when they load, so move there first.
  const cacheDir = path.join(app.getPath('home'), 'Library', 'Caches', APP_ID);
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  process.chdir(cacheDir);
  // A Finder launch gets a minimal PATH; ChatGPT sign-in runs `codex`.
  process.env.PATH = toolPath(process.env.PATH, app.getPath('home'));

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('The macOS Keychain is not available to encrypt keys.');
  }
  const { applyStoredKeys, createKeyStore } = await import('./keyStore.mjs');
  const store = createKeyStore({
    file: path.join(app.getPath('userData'), 'provider-keys.enc'),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  });
  applyStoredKeys(store.values());

  const { startAppServer } = await import('./server.mjs');
  const serve = (/** @type {number | undefined} */ port) =>
    startAppServer({ root: APP_ROOT, store, onSaved: restartServer, port });
  appServer = await serve(undefined);
  // `pnpm run app:smoke` waits for this line.
  console.log(`God's Eye View is serving ${appServer.url}`);

  /** Provider Settings saved a key: serve with it, then reload the page. */
  async function restartServer() {
    if (restarting || !appServer) return;
    restarting = true;
    try {
      const { port } = appServer;
      await appServer.close();
      appServer = await serve(port);
      if (mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadURL(appServer.url);
      }
    } catch (error) {
      fail(error);
    } finally {
      restarting = false;
    }
  }

  guardSession();
  Menu.setApplicationMenu(buildMenu());
  mainWindow = createWindow(appServer.url);
  app.on('activate', () => {
    if (!mainWindow && appServer) mainWindow = createWindow(appServer.url);
  });
}

app.on('window-all-closed', () => app.quit());

let closed = false;
app.on('before-quit', (event) => {
  if (closed || !appServer) return;
  // Close the server first, so the AIS socket and the other relays end.
  event.preventDefault();
  closed = true;
  appServer.close().finally(() => app.quit());
});

/** @param {string} url */
function createWindow(url) {
  const state = readWindowState();
  const win = new BrowserWindow({
    ...state,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "God's Eye View",
    backgroundColor: '#05070a',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('close', () => writeWindowState(win));
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  // The app stays on its own origin; links to anything else open in the
  // default browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isExternalLink(target, appServer?.url)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (isAppUrl(target, appServer?.url)) return;
    event.preventDefault();
    if (isExternalLink(target, appServer?.url)) shell.openExternal(target);
  });
  win.loadURL(url);
  return win;
}

/** Permissions: only the app's own page gets them, and only what it uses. */
function guardSession() {
  const ses = session.defaultSession;
  const fromApp = (/** @type {string | undefined} */ url) =>
    isAppUrl(url, appServer?.url);
  const granted = new Set([
    'clipboard-sanitized-write',
    'fullscreen',
    'geolocation',
  ]);
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!fromApp(details.requestingUrl ?? contents.getURL())) {
      return callback(false);
    }
    if (permission === 'media') {
      // Voice needs the microphone; nothing uses the camera.
      const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
      if (types.includes('video')) return callback(false);
      systemPreferences
        .askForMediaAccess('microphone')
        .then(callback, () => callback(false));
      return;
    }
    callback(granted.has(permission));
  });
  ses.setPermissionCheckHandler(
    (_contents, permission, origin) =>
      fromApp(origin) && (permission === 'media' || granted.has(permission)),
  );
  // WebUSB, for the RTL-SDR receiver.
  ses.setDevicePermissionHandler(
    (details) => details.deviceType === 'usb' && fromApp(details.origin),
  );
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    chooseUsbDevice(details.deviceList).then(callback, () => callback(''));
  });
}

/**
 * Asks which USB device to use, as Chrome's chooser does.
 * @param {Electron.USBDevice[]} devices
 */
async function chooseUsbDevice(devices) {
  if (!devices.length) {
    await dialog.showMessageBox({
      type: 'info',
      message: 'No USB receiver found',
      detail: 'Connect the RTL-SDR receiver and try again.',
    });
    return '';
  }
  const options = { buttons: [...devices.map(usbDeviceLabel), 'Cancel'] };
  const { response } = await dialog.showMessageBox(
    /** @type {BrowserWindow} */ (mainWindow),
    {
      type: 'question',
      message: 'Connect a USB receiver',
      detail: "God's Eye View wants to use this device for the radio layer.",
      ...options,
      cancelId: devices.length,
      defaultId: 0,
    },
  );
  return devices[response]?.deviceId ?? '';
}

function buildMenu() {
  const openSettings = () =>
    mainWindow?.webContents.executeJavaScript(
      "document.dispatchEvent(new CustomEvent('gev:open-key-setup'))",
    );
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Provider Settings…',
          accelerator: 'CommandOrControl+,',
          click: openSettings,
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'MCP Server Address',
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              message: 'MCP server',
              detail: `While the app runs, MCP clients can connect to ${appOrigin(appServer?.url)}/mcp`,
            }),
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

const windowStateFile = () =>
  path.join(app.getPath('userData'), 'window-state.json');

function readWindowState() {
  try {
    const saved = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    const { width, height, x, y } = saved;
    if ([width, height].every((value) => Number.isFinite(value) && value > 0)) {
      return Number.isFinite(x) && Number.isFinite(y)
        ? { width, height, x, y }
        : { width, height };
    }
  } catch {
    // First launch, or an unreadable file: the default size.
  }
  return { width: 1440, height: 900 };
}

/** @param {BrowserWindow} win */
function writeWindowState(win) {
  try {
    fs.writeFileSync(windowStateFile(), JSON.stringify(win.getNormalBounds()));
  } catch {
    // Window state is a convenience; never block closing on it.
  }
}
