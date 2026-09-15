const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  screen,
  net,
  powerMonitor,
} = require('electron');
const path = require('path');
const fs = require('fs');
const desktopPin = require('./desktop-pin');

const launchedAtLogin = process.argv.includes('--autostart');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId('com.meowsconvert.app');

// Виджет встроен в рабочий стол и почти всегда перекрыт окнами. Chromium считает такое окно
// невидимым и перестаёт его рисовать, а для дочернего окна рабочего стола это состояние может
// не сняться даже после «Свернуть всё» — виджет застывает. Отключаем расчёт перекрытия.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const ASSETS = path.join(__dirname, '..', 'assets');
const RENDERER = path.join(__dirname, 'renderer');
const WIDGET_WIDTH = 300;
// На Windows .ico содержит все размеры, и система берёт подходящий под масштаб экрана
const APP_ICON = path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon.png');

// ---------- Хранилище ----------

const DEFAULT_SETTINGS = {
  currencies: ['RUB', 'USD', 'EUR', 'KZT', 'CNY'],
  source: 'erapi', // 'erapi' | 'cbr'
  precision: 'auto', // 'auto' | '0' | '2' | '4'
  refreshMinutes: 60, // 0 = не обновлять автоматически
  autostart: false,
  hideMainOnAutostart: true,
  closeToTray: true,
  mainOnTop: false,
  widgetEnabled: false,
  widgetOnTop: false,
  widgetOpacity: 1,
  widgetBounds: null,
  mainBounds: null,
  conversion: { code: 'RUB', amount: 1000 },
};

function dataPath(name) {
  return path.join(app.getPath('userData'), name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(dataPath(name), 'utf8'));
  } catch {
    return fallback;
  }
}

const saveTimers = {};
function writeJsonSoon(name, data) {
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(() => writeJsonNow(name, data), 400);
}

function writeJsonNow(name, data) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(dataPath(name), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Не удалось сохранить', name, e);
  }
}

let settings;
let ratesCache;

function saveSettings() {
  writeJsonSoon('settings.json', settings);
}

// ---------- Курсы валют ----------

let ratesState = { source: null, rates: null, updatedAt: null, fetchedAt: null, error: null, loading: false };
let refreshPromise = null;

async function fetchJson(url) {
  const res = await net.fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Курсы в формате «единиц валюты за 1 единицу базы»
async function fetchErApi() {
  const j = await fetchJson('https://open.er-api.com/v6/latest/USD');
  if (j.result !== 'success') throw new Error(j['error-type'] || 'ошибка API');
  return { rates: j.rates, updatedAt: j.time_last_update_unix * 1000 };
}

async function fetchCbr() {
  const j = await fetchJson('https://www.cbr-xml-daily.ru/daily_json.js');
  const rates = { RUB: 1 };
  for (const [code, v] of Object.entries(j.Valute)) rates[code] = v.Nominal / v.Value;

  // У ЦБ нет части валют, их досчитываем через рыночный кросс-курс к доллару
  const filled = [];
  let market = ratesCache.erapi;
  if (!market || Date.now() - market.fetchedAt > 24 * 3600e3) {
    try {
      market = { ...(await fetchErApi()), fetchedAt: Date.now() };
      ratesCache.erapi = market;
    } catch {
      // без досчёта, только валюты ЦБ
    }
  }
  if (market && rates.USD) {
    for (const [code, v] of Object.entries(market.rates)) {
      if (!(code in rates)) {
        rates[code] = v * rates.USD;
        filled.push(code);
      }
    }
  }
  return { rates, updatedAt: Date.parse(j.Date), filled };
}

function applyCachedRates() {
  const cached = ratesCache[settings.source];
  ratesState = {
    source: settings.source,
    rates: cached?.rates || null,
    updatedAt: cached?.updatedAt || null,
    fetchedAt: cached?.fetchedAt || null,
    filled: cached?.filled || [],
    error: null,
    loading: false,
  };
}

function refreshRates() {
  if (refreshPromise) return refreshPromise;
  const source = settings.source;
  ratesState = { ...ratesState, loading: true };
  broadcast('rates', ratesState);

  refreshPromise = (async () => {
    try {
      const data = source === 'cbr' ? await fetchCbr() : await fetchErApi();
      ratesCache[source] = { ...data, fetchedAt: Date.now() };
      writeJsonSoon('rates-cache.json', ratesCache);
      if (settings.source === source) applyCachedRates();
    } catch (e) {
      if (settings.source === source) {
        applyCachedRates();
        ratesState.error = e.message || String(e);
      }
    } finally {
      ratesState.loading = false;
      refreshPromise = null;
      broadcast('rates', ratesState);
    }
    return ratesState;
  })();
  return refreshPromise;
}

function refreshIfStale() {
  const minutes = settings.refreshMinutes;
  if (!ratesState.rates) return refreshRates();
  if (!minutes) return;
  if (!ratesState.fetchedAt || Date.now() - ratesState.fetchedAt > minutes * 60e3) refreshRates();
}

// ---------- Окна ----------

let mainWindow = null;
let widgetWindow = null;
let tray = null;
let quitting = false;

const webPreferences = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

function allWindows() {
  return [mainWindow, widgetWindow].filter((w) => w && !w.isDestroyed());
}

function broadcast(channel, data, exceptContents) {
  for (const w of allWindows()) {
    if (w.webContents !== exceptContents) w.webContents.send(channel, data);
  }
}

function boundsVisible(b) {
  if (!b) return false;
  const area = screen.getDisplayMatching(b).workArea;
  return b.x < area.x + area.width - 40 && b.x + b.width > area.x + 40 && b.y >= area.y - 10 && b.y < area.y + area.height - 40;
}

function createMainWindow() {
  const saved = settings.mainBounds;
  const opts = {
    width: 400,
    height: 800,
    minWidth: 340,
    minHeight: 560,
    backgroundColor: '#000000',
    title: 'MeowsConvert',
    icon: APP_ICON,
    show: false,
    alwaysOnTop: settings.mainOnTop,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#000000', symbolColor: '#ffffff', height: 34 },
    webPreferences,
  };
  if (boundsVisible(saved)) Object.assign(opts, saved);

  mainWindow = new BrowserWindow(opts);
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(RENDERER, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  const remember = () => {
    if (!mainWindow.isMinimized() && !mainWindow.isMaximized()) {
      settings.mainBounds = mainWindow.getBounds();
      saveSettings();
    }
  };
  mainWindow.on('moved', remember);
  mainWindow.on('resized', remember);

  mainWindow.on('close', (e) => {
    if (!quitting && settings.closeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (!quitting && !settings.closeToTray && !widgetWindow) app.quit();
  });
}

function showMain() {
  if (!mainWindow) createMainWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function toggleMain() {
  if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else showMain();
}

function defaultWidgetPosition(height) {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - WIDGET_WIDTH - 24, y: area.y + 24, width: WIDGET_WIDTH, height };
}

function createWidget() {
  const initialHeight = 90 + settings.currencies.length * 48;
  const saved = settings.widgetBounds && { ...settings.widgetBounds, width: WIDGET_WIDTH, height: initialHeight };
  const bounds = boundsVisible(saved) ? saved : defaultWidgetPosition(initialHeight);

  widgetWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: settings.widgetOnTop,
    title: 'MeowsConvert — виджет',
    icon: APP_ICON,
    webPreferences: { ...webPreferences, backgroundThrottling: false },
  });
  const win = widgetWindow;
  win.setOpacity(settings.widgetOpacity);
  win.loadFile(path.join(RENDERER, 'widget.html'));
  win.once('ready-to-show', () => {
    win.showInactive();
    if (!settings.widgetOnTop) pinWidget(win);
  });

  win.on('moved', () => {
    const { x, y } = win.getBounds();
    settings.widgetBounds = { x, y };
    saveSettings();
  });
  win.on('closed', () => {
    if (widgetWindow === win) widgetWindow = null;
    // Окно закреплено внутри рабочего стола и погибает вместе с Explorer — поднимаем заново
    if (!quitting && settings.widgetEnabled && !widgetWindow) setTimeout(() => setWidgetEnabled(true), 2000);
  });
}

// Explorer может ещё не создать рабочий стол (ранний автозапуск) — пробуем повторно
function pinWidget(win, attempt = 0) {
  if (win.isDestroyed() || settings.widgetOnTop) return;
  if (desktopPin.pin(win)) return;
  if (attempt < 30) setTimeout(() => pinWidget(win, attempt + 1), 2000);
}

function setWidgetEnabled(on) {
  settings.widgetEnabled = on;
  if (on && !widgetWindow) createWidget();
  if (!on && widgetWindow) widgetWindow.close();
}

// Смена режима «на рабочем столе» ↔ «поверх окон» — проще пересоздать окно
function recreateWidget() {
  if (!widgetWindow) return;
  const old = widgetWindow;
  widgetWindow = null;
  old.destroy();
  createWidget();
}

// ---------- Автозапуск ----------

function loginItemOptions() {
  if (app.isPackaged) return { args: ['--autostart'] };
  // В режиме разработки запускаем electron.exe с путём к проекту
  return { path: process.execPath, args: [path.resolve(app.getAppPath()), '--autostart'] };
}

function applyAutostart() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: settings.autostart });
}

// ---------- Трей ----------

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть MeowsConvert', click: showMain },
      {
        label: 'Виджет на рабочем столе',
        type: 'checkbox',
        checked: settings.widgetEnabled,
        click: (item) => updateSettings({ widgetEnabled: item.checked }),
      },
      { label: 'Обновить курсы', click: () => refreshRates() },
      { type: 'separator' },
      {
        label: 'Запускать вместе с Windows',
        type: 'checkbox',
        checked: settings.autostart,
        click: (item) => updateSettings({ autostart: item.checked }),
      },
      { type: 'separator' },
      { label: 'Выход', click: () => app.quit() },
    ])
  );
}

function createTray() {
  const trayIcon = process.platform === 'win32' ? path.join(ASSETS, 'tray.ico') : nativeImage.createFromPath(path.join(ASSETS, 'icon-small.png')).resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.setToolTip('MeowsConvert — конвертер валют');
  tray.on('click', toggleMain);
  buildTrayMenu();
}

// ---------- Настройки ----------

function publicState() {
  return { settings, rates: ratesState, version: app.getVersion() };
}

function updateSettings(patch) {
  const prev = { ...settings };
  Object.assign(settings, patch);

  if ('autostart' in patch && patch.autostart !== prev.autostart) applyAutostart();
  if ('widgetEnabled' in patch && patch.widgetEnabled !== prev.widgetEnabled) setWidgetEnabled(patch.widgetEnabled);
  if ('widgetOnTop' in patch && patch.widgetOnTop !== prev.widgetOnTop) recreateWidget();
  if ('widgetOpacity' in patch && widgetWindow) widgetWindow.setOpacity(settings.widgetOpacity);
  if ('mainOnTop' in patch && mainWindow) mainWindow.setAlwaysOnTop(settings.mainOnTop);
  if ('widgetBounds' in patch && patch.widgetBounds === null && widgetWindow) {
    desktopPin.setBounds(widgetWindow, defaultWidgetPosition(widgetWindow.getBounds().height));
  }
  if ('source' in patch && patch.source !== prev.source) {
    applyCachedRates();
    broadcast('rates', ratesState);
    refreshIfStale();
  }

  saveSettings();
  buildTrayMenu();
  broadcast('settings', settings);
  return settings;
}

// ---------- IPC ----------

ipcMain.handle('get-state', () => publicState());
ipcMain.handle('set-settings', (_e, patch) => updateSettings(patch));
ipcMain.handle('refresh-rates', () => refreshRates());

ipcMain.on('set-conversion', (e, conversion) => {
  settings.conversion = conversion;
  saveSettings();
  broadcast('conversion', conversion, e.sender);
});

ipcMain.on('open-main', showMain);

ipcMain.on('widget-resize', (_e, height) => {
  if (!widgetWindow) return;
  const b = widgetWindow.getBounds();
  const h = Math.max(60, Math.min(1200, Math.round(height)));
  if (b.height !== h || b.width !== WIDGET_WIDTH) desktopPin.setBounds(widgetWindow, { ...b, width: WIDGET_WIDTH, height: h });
});

ipcMain.on('widget-menu', () => {
  if (!widgetWindow) return;
  Menu.buildFromTemplate([
    { label: 'Открыть приложение', click: showMain },
    { label: 'Обновить курсы', click: () => refreshRates() },
    { type: 'separator' },
    {
      label: 'Поверх всех окон',
      type: 'checkbox',
      checked: settings.widgetOnTop,
      click: (item) => updateSettings({ widgetOnTop: item.checked }),
    },
    {
      label: 'Прозрачность',
      submenu: [1, 0.9, 0.8, 0.7, 0.6, 0.5].map((v) => ({
        label: `${Math.round(v * 100)}%`,
        type: 'radio',
        checked: Math.abs(settings.widgetOpacity - v) < 0.01,
        click: () => updateSettings({ widgetOpacity: v }),
      })),
    },
    { label: 'Вернуть в угол экрана', click: () => updateSettings({ widgetBounds: null }) },
    { type: 'separator' },
    { label: 'Скрыть виджет', click: () => updateSettings({ widgetEnabled: false }) },
  ]).popup({ window: widgetWindow });
});

// ---------- Жизненный цикл ----------

app.on('second-instance', showMain);

app.on('before-quit', () => {
  quitting = true;
  writeJsonNow('settings.json', settings);
  writeJsonNow('rates-cache.json', ratesCache);
});

app.on('window-all-closed', () => {
  // Приложение продолжает жить в трее
});

app.whenReady().then(() => {
  const stored = readJson('settings.json', {});
  settings = { ...DEFAULT_SETTINGS, ...stored };
  if (!Array.isArray(settings.currencies) || settings.currencies.length === 0) {
    settings.currencies = [...DEFAULT_SETTINGS.currencies];
  }
  ratesCache = readJson('rates-cache.json', {});
  applyCachedRates();

  // Синхронизируем флаг с реальной записью автозапуска в системе
  if (process.platform === 'win32') {
    settings.autostart = app.getLoginItemSettings(loginItemOptions()).openAtLogin;
  }

  createTray();
  if (!launchedAtLogin || !settings.hideMainOnAutostart) createMainWindow();
  if (settings.widgetEnabled) createWidget();

  refreshIfStale();
  setInterval(refreshIfStale, 5 * 60e3);
  powerMonitor.on('resume', () => setTimeout(refreshIfStale, 5000));
});
