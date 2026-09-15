# MeowsConvert — заметки для разработки

Конвертер валют для Windows 10/11 на Electron: главное окно с калькулятором (в стиле iOS-приложения
Converter Neo), виджет на рабочий стол, трей, автозапуск. Пользовательская документация — в `README.md`.

## Структура

```
src/
  main.js              главный процесс: окна, трей, автозапуск, курсы, настройки, IPC
  preload.js           мост window.api (contextBridge), белый список каналов
  renderer/
    currencies.js      справочник: код → [русское название, код флага flag-icons]; POPULAR_CURRENCIES
    shared.js          window.MC: форматирование чисел, парсер выражений, Calc, createConverter
    index.html/app.js  главное окно: экраны main / picker / source / settings
    style.css          стили главного окна (токены в :root)
    widget.html/js/css виджет — тот же createConverter, без клавиатуры-кнопок
scripts/
  make-icon.js         режет assets/icon-source.png → icon.png, icon-small.png, icon.ico, tray.ico, build/icon.ico
  start.js             запуск electron без ELECTRON_RUN_AS_NODE (см. «Подводные камни»)
assets/                иконки (icon-source.png — исходник, в сборку не попадает)
build/icon.ico         иконка для electron-builder (генерируется)
dist/                  результат сборки, в git не хранится
```

## Команды

- `npm start` — запуск в режиме разработки (через `scripts/start.js`).
- `npm run icon` — перегенерировать иконки из `assets/icon-source.png`.
- `npm run dist` — иконки + установщик NSIS в `dist/MeowsConvert Setup <версия>.exe`.

Тестов нет. Логику `shared.js` проверять node-скриптом (подставить `global.window = { CURRENCIES: {} }`
и `require` файл), UI — запуском и скриншотом окна через PowerShell/System.Drawing
(`SetProcessDPIAware` + `GetWindowRect` + `CopyFromScreen`, экран с масштабом ~175%).

## Архитектура

**Единый источник правды — главный процесс.** В `main.js` хранятся `settings` (включая текущую
конвертацию) и `ratesState`. Окна получают состояние через `get-state` и подписываются на рассылки:

| Канал | Направление | Что |
| --- | --- | --- |
| `get-state` (invoke) | renderer → main | `{ settings, rates, version }` |
| `set-settings` (invoke) | renderer → main | частичный patch; побочные эффекты применяются в `updateSettings` |
| `refresh-rates` (invoke) | renderer → main | принудительное обновление курсов |
| `set-conversion` | renderer → main | `{ code, amount, expr }`, рассылается всем окнам, кроме отправителя |
| `open-main`, `widget-resize`, `widget-menu` | виджет → main | |
| `settings`, `rates`, `conversion` | main → все окна | рассылки |

Новый канал main → renderer нужно добавить в `CHANNELS` в `preload.js`, иначе подписка молча не сработает.

**Настройки** (`DEFAULT_SETTINGS` в `main.js`) лежат в `%APPDATA%\MeowsConvert\settings.json`
(запись с задержкой 400 мс, при выходе — сразу). Новые ключи добавлять в `DEFAULT_SETTINGS`:
сохранённый файл сливается с дефолтами. Флаг `autostart` при старте синхронизируется с реальной записью
в системе через `getLoginItemSettings`.

**Курсы** всегда хранятся как «единиц валюты за 1 единицу базы» (`rates[code]`). Перевод:
`amount / rates[from] * rates[to]` (`MC.convert`). База у источников разная (USD у er-api, RUB у ЦБ),
на расчёт это не влияет.
- `erapi`: `https://open.er-api.com/v6/latest/USD`, без ключа, обновляется раз в сутки.
- `cbr`: `https://www.cbr-xml-daily.ru/daily_json.js`, `Nominal / Value`. Валют, которых нет у ЦБ,
  досчитываются через кросс-курс er-api к USD; список — в `filled`.
- Кеш: `rates-cache.json` в userData, по ключу источника. Запросы идут через `net.fetch` в main
  (нет CORS, CSP renderer'а не трогается). `refreshIfStale` вызывается при старте, раз в 5 мин
  (сравнивает с `refreshMinutes`) и после выхода из сна.

**Калькулятор** (`shared.js`):
- `Calc.expr` — сырая строка из символов `0-9 , + − × ÷ %` (минус и знаки — юникодные, не ASCII).
- `fresh = true` после выбора поля или `=`: первая цифра заменяет значение, операция дописывается.
- `evaluate` — рекурсивный разбор с приоритетами; `a + b%` = `a + a*b/100`, отдельное `b%` = `b/100`.
  Висящий оператор в конце игнорируется.
- Активная строка показывает `formatExpr(expr)`, остальные — `formatValue(convert(...))`.
  Точность `auto`: ≥1000 → 0 знаков, ≥1 → 2 знака, <1 → значащие цифры.
- При синхронизации передаётся `expr`, чтобы окна показывали одно и то же без потери точности.

**Окна:**
- Главное: `titleBarStyle: 'hidden'` + `titleBarOverlay` (родные кнопки Windows), своя полоса
  `.titlebar` (drag-region) с иконкой. Крестик прячет окно в трей, если включён `closeToTray`.
- Виджет: `frame: false`, `transparent`, `skipTaskbar`, ширина фиксирована (`WIDGET_WIDTH`),
  высота подстраивается через `ResizeObserver` → `widget-resize`. Сохраняется только позиция.
  Перетаскивание — `-webkit-app-region: drag` на `.w-head`; кнопки в `no-drag`.
- Single instance: повторный запуск показывает главное окно.
- Автозапуск: `setLoginItemSettings` с аргументом `--autostart`; в dev прописывается `electron.exe`
  с путём проекта. При `--autostart` и `hideMainOnAutostart` главное окно не создаётся, только трей
  и виджет (если `widgetEnabled`).

## Правила

- Интерфейс, комментарии и сообщения — на русском. Названия валют — в `currencies.js`.
- Без фреймворков и сборщиков в renderer: обычные `<script>`, глобальные `window.MC`,
  `window.CURRENCIES`. Скрипты подключаются в порядке `currencies.js` → `shared.js` → `app.js`/`widget.js`.
- Безопасность renderer'а: `contextIsolation`, `sandbox`, без `nodeIntegration`, CSP в `<head>`.
  Никаких внешних ресурсов в renderer — всё из пакета (флаги из `node_modules/flag-icons`).
  Сетевые запросы — только из main.
- Пользовательский текст в `innerHTML` — через `MC.escapeHtml`.
- Тёмная тема и цвета — через CSS-переменные в `style.css`; акцент `#ff9f0a`, активное поле `#3d3222`.
- Иконки не править вручную — менять `icon-source.png` и запускать `npm run icon`. Для ≤48px
  используется крупный план (`CLOSE_CROP`), для больших — полный кадр.
- Зависимости: в `dependencies` только то, что нужно в рантайме (сейчас `flag-icons`);
  electron и electron-builder — в `devDependencies`.

## Подводные камни

- **ELECTRON_RUN_AS_NODE.** Терминал VS Code выставляет эту переменную, и `npx electron .` падает
  с `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`. Собранный exe тоже её
  учитывает. Запускать через `npm start` или обнулять переменную (`$env:ELECTRON_RUN_AS_NODE = $null`).
- Эмодзи-флаги в Windows не рисуются, поэтому используется `flag-icons` (`fi fis fi-xx`, круг через CSS).
  Путь в HTML `../../node_modules/flag-icons/...` работает и в asar.
- `Win+D` прячет виджет, как любое окно. Закрепить «под окнами» в Electron нельзя; есть опция «поверх всех окон».
- После смены иконки Windows может показывать старую из кеша — `ie4uinit.exe -show` или перезагрузка.
- Прозрачное окно на Windows нельзя нормально ресайзить мышью, поэтому высота виджета управляется из кода.
- Проект лежит в OneDrive по пути с кириллицей — сборка работает, но при странных ошибках electron-builder
  это первое, что стоит проверить.

## Открытые вопросы

- Пользователь обещал скриншот страницы выбора валют из оригинального приложения — текущий экран
  (`view-picker`) сделан по собственному дизайну и может быть переделан под него.
