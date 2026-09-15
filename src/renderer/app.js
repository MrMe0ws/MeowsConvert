const $ = (sel) => document.querySelector(sel);
const { flag, currencyName, formatValue, convert, ratesStatus, escapeHtml } = window.MC;

const MAX_CURRENCIES = 12;

const ICONS = {
  handle: '<svg viewBox="0 0 24 24"><path d="M3 15h18v-2H3v2zm0 4h18v-2H3v2zm0-8h18V9H3v2zm0-6v2h18V5H3z"/></svg>',
  remove: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm5 11H7v-2h10v2z"/></svg>',
};

// ---------- Навигация ----------

let currentView = 'main';

function showView(name) {
  currentView = name;
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`;
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-back]')) showView('main');
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && currentView !== 'main') {
    showView('main');
    e.stopImmediatePropagation();
  }
}, true);

// ---------- Конвертер ----------

const converter = window.MC.createConverter({
  rowsEl: $('#rows'),
  onChipClick: (_code, index) => openPicker({ mode: 'replace', index }),
  onRender: renderChrome,
});
converter.setKeypadGuard(() => currentView === 'main');

const state = converter.state;

function renderChrome() {
  const { settings, rates } = state;
  const st = ratesStatus(rates);
  const status = $('#status');
  status.textContent = st.text;
  status.className = `status ${st.kind}`;
  if (rates.updatedAt) {
    const src = rates.source === 'cbr' ? 'ЦБ РФ' : 'open.er-api.com';
    status.title = `Источник: ${src}\nКурс на ${new Date(rates.updatedAt).toLocaleString('ru-RU')}` +
      (rates.error ? `\nОшибка: ${rates.error}` : '');
  }
  $('#btn-refresh').classList.toggle('spin', !!rates.loading);
  $('#btn-widget').classList.toggle('on', settings.widgetEnabled);

  if (settings.currencies.length < MAX_CURRENCIES) {
    const add = document.createElement('button');
    add.className = 'add-row';
    add.textContent = '+ Добавить валюту';
    add.addEventListener('click', () => openPicker({ mode: 'manage' }));
    $('#rows').appendChild(add);
  }

  // Не перерисовываем настройки, пока пользователь двигает ползунок
  if (currentView === 'settings' && document.activeElement?.type !== 'range') renderSettings();
  if (currentView === 'source') renderSource();
  if (currentView === 'picker') renderPicker();
}

$('#keypad').addEventListener('pointerdown', (e) => {
  const key = e.target.closest('.key');
  if (!key) return;
  e.preventDefault();
  converter.press(key.dataset.key);
});

// Подсветка кнопок при вводе с клавиатуры
window.addEventListener('keydown', (e) => {
  if (currentView !== 'main') return;
  const map = { '-': '−', '*': '×', '/': '÷', '.': ',', Enter: '=', Backspace: 'back', Escape: 'C', Delete: 'C' };
  const k = map[e.key] || e.key;
  const btn = document.querySelector(`.key[data-key="${CSS.escape(k)}"]`);
  if (!btn) return;
  btn.classList.add('pressed');
  setTimeout(() => btn.classList.remove('pressed'), 120);
});

$('#btn-refresh').addEventListener('click', () => window.api.refreshRates());
$('#btn-widget').addEventListener('click', () => window.api.setSettings({ widgetEnabled: !state.settings.widgetEnabled }));
$('#btn-source').addEventListener('click', () => {
  renderSource();
  showView('source');
});
$('#btn-settings').addEventListener('click', () => {
  renderSettings();
  showView('settings');
});

function setCurrencies(list) {
  return window.api.setSettings({ currencies: list });
}

// ---------- Выбор валют ----------

let picker = { mode: 'manage', index: 0 };

function openPicker(opts) {
  picker = opts;
  $('#picker-search').value = '';
  renderPicker();
  showView('picker');
  $('#picker-search').focus();
}

function availableCodes() {
  const rates = state.rates.rates;
  const codes = new Set(Object.keys(window.CURRENCIES));
  if (rates) {
    for (const c of Object.keys(rates)) codes.add(c);
    for (const c of codes) if (!rates[c] && !state.settings.currencies.includes(c)) codes.delete(c);
  }
  const popular = window.POPULAR_CURRENCIES;
  return [...codes].sort((a, b) => {
    const pa = popular.indexOf(a), pb = popular.indexOf(b);
    if (pa !== -1 || pb !== -1) return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
    return currencyName(a).localeCompare(currencyName(b), 'ru');
  });
}

function rateText(code) {
  const base = state.active || state.settings.currencies[0];
  if (code === base) return '';
  const v = convert(1, code, base, state.rates.rates);
  if (!Number.isFinite(v)) return 'нет курса';
  return `1 ${code} = ${formatValue(v, v >= 1000 ? 0 : 'auto')} ${base}`;
}

function currencyItem(code, trailing, extra = '') {
  return `
    <button class="item" data-code="${code}" ${extra}>
      ${flag(code)}
      <div class="item-text">
        <div class="item-title">${code}</div>
        <div class="item-sub">${escapeHtml(currencyName(code))}</div>
      </div>
      <div class="item-rate">${escapeHtml(rateText(code))}</div>
      ${trailing}
    </button>`;
}

function renderPicker() {
  const list = state.settings.currencies;
  const query = $('#picker-search').value.trim().toLowerCase();
  const replacing = picker.mode === 'replace';

  $('#picker-title').textContent = replacing ? 'Замена валюты' : 'Мои валюты';
  $('#picker-sub').textContent = replacing
    ? `Вместо ${list[picker.index]} · ${currencyName(list[picker.index])}`
    : `Выбрано ${list.length} из ${MAX_CURRENCIES}`;

  const matches = availableCodes().filter(
    (c) => !query || c.toLowerCase().includes(query) || currencyName(c).toLowerCase().includes(query)
  );

  let html = '';
  if (!replacing && !query) {
    html += '<div class="section-title">Выбранные — перетащите, чтобы изменить порядок</div><div class="group" id="selected-group">';
    html += list
      .map((code) => `
        <div class="item" draggable="true" data-code="${code}">
          <span class="handle">${ICONS.handle}</span>
          ${flag(code)}
          <div class="item-text">
            <div class="item-title">${code}</div>
            <div class="item-sub">${escapeHtml(currencyName(code))}</div>
          </div>
          <button class="remove" data-remove="${code}" title="Убрать" ${list.length <= 1 ? 'disabled' : ''}>${ICONS.remove}</button>
        </div>`)
      .join('');
    html += '</div>';
  }

  html += `<div class="section-title">${query ? 'Результаты поиска' : 'Все валюты'}</div>`;
  if (!matches.length) {
    html += '<div class="empty">Ничего не найдено</div>';
  } else {
    html += '<div class="group" id="all-group">';
    html += matches
      .map((code) => {
        const selected = list.includes(code);
        const current = replacing && list[picker.index] === code;
        const on = replacing ? current : selected;
        return currencyItem(code, `<span class="check${on ? ' on' : ''}"></span>`);
      })
      .join('');
    html += '</div>';
  }

  const body = $('#picker-body');
  const scroll = body.scrollTop;
  body.innerHTML = html;
  body.scrollTop = scroll;
}

$('#picker-search').addEventListener('input', () => {
  $('#picker-body').scrollTop = 0;
  renderPicker();
});

$('#picker-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const first = document.querySelector('#all-group .item');
  if (first) first.click();
});

$('#picker-body').addEventListener('click', (e) => {
  const list = [...state.settings.currencies];

  const remove = e.target.closest('[data-remove]');
  if (remove) {
    if (list.length > 1) setCurrencies(list.filter((c) => c !== remove.dataset.remove));
    return;
  }

  const item = e.target.closest('#all-group .item');
  if (!item) return;
  const code = item.dataset.code;

  if (picker.mode === 'replace') {
    const existing = list.indexOf(code);
    if (existing !== -1) [list[existing], list[picker.index]] = [list[picker.index], list[existing]];
    else list[picker.index] = code;
    setCurrencies(list);
    showView('main');
    return;
  }

  if (list.includes(code)) {
    if (list.length > 1) setCurrencies(list.filter((c) => c !== code));
  } else if (list.length < MAX_CURRENCIES) {
    setCurrencies([...list, code]);
  }
});

// Перетаскивание выбранных валют
let dragCode = null;

$('#picker-body').addEventListener('dragstart', (e) => {
  const item = e.target.closest('#selected-group .item');
  if (!item) return;
  dragCode = item.dataset.code;
  item.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});

$('#picker-body').addEventListener('dragover', (e) => {
  const item = e.target.closest('#selected-group .item');
  if (!item || !dragCode) return;
  e.preventDefault();
  const after = e.clientY > item.getBoundingClientRect().top + item.offsetHeight / 2;
  for (const el of document.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
  item.classList.add(after ? 'drop-after' : 'drop-before');
});

$('#picker-body').addEventListener('drop', (e) => {
  const item = e.target.closest('#selected-group .item');
  if (!item || !dragCode) return;
  e.preventDefault();
  const after = item.classList.contains('drop-after');
  const list = state.settings.currencies.filter((c) => c !== dragCode);
  let index = list.indexOf(item.dataset.code);
  if (index === -1) index = list.length;
  else if (after) index++;
  list.splice(index, 0, dragCode);
  dragCode = null;
  setCurrencies(list);
});

$('#picker-body').addEventListener('dragend', () => {
  dragCode = null;
  renderPicker();
});

// ---------- Источник курсов ----------

const SOURCES = [
  { id: 'erapi', title: 'Рыночный курс', sub: 'open.er-api.com · 160+ валют, обновление раз в сутки' },
  { id: 'cbr', title: 'Центробанк России', sub: 'Официальный курс ЦБ РФ · недостающие валюты досчитываются по рынку' },
];

function renderSource() {
  const { settings, rates } = state;
  let html = '<div class="group">';
  html += SOURCES.map((s) => `
    <button class="item" data-source="${s.id}">
      <span class="radio${settings.source === s.id ? ' on' : ''}"></span>
      <div class="item-text">
        <div class="item-title">${s.title}</div>
        <div class="item-sub" style="white-space: normal">${s.sub}</div>
      </div>
    </button>`).join('');
  html += '</div>';

  const st = ratesStatus(rates);
  html += '<div class="section-title">Текущие данные</div><div class="group">';
  html += `
    <div class="item">
      <div class="item-text">
        <div class="item-title">Курс на ${rates.updatedAt ? new Date(rates.updatedAt).toLocaleString('ru-RU') : '—'}</div>
        <div class="item-sub">Загружено: ${escapeHtml(st.text)}${rates.error ? ' · ошибка: ' + escapeHtml(rates.error) : ''}</div>
      </div>
      <button class="btn" id="source-refresh">${rates.loading ? 'Обновление…' : 'Обновить'}</button>
    </div>`;
  html += '</div>';
  if (rates.source === 'cbr' && rates.filled?.length) {
    html += `<div class="note">По рыночному курсу досчитаны: ${rates.filled.filter((c) => state.settings.currencies.includes(c)).join(', ') || 'нет среди выбранных'}.</div>`;
  }
  $('#source-body').innerHTML = html;
}

$('#source-body').addEventListener('click', (e) => {
  const src = e.target.closest('[data-source]');
  if (src) window.api.setSettings({ source: src.dataset.source });
  if (e.target.closest('#source-refresh')) window.api.refreshRates();
});

// ---------- Настройки ----------

function switchRow(key, title, sub, { disabled = false } = {}) {
  return `
    <label class="item clickable">
      <div class="item-text">
        <div class="item-title">${title}</div>
        ${sub ? `<div class="item-sub" style="white-space: normal">${sub}</div>` : ''}
      </div>
      <input type="checkbox" class="switch" data-setting="${key}" ${state.settings[key] ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
    </label>`;
}

function renderSettings() {
  const s = state.settings;
  const precisionOpts = [['auto', 'Авто'], ['0', '0 знаков'], ['2', '2 знака'], ['4', '4 знака']]
    .map(([v, t]) => `<option value="${v}" ${s.precision === v ? 'selected' : ''}>${t}</option>`).join('');
  const refreshOpts = [[30, 'Каждые 30 мин'], [60, 'Каждый час'], [180, 'Каждые 3 часа'], [720, 'Каждые 12 часов'], [0, 'Только вручную']]
    .map(([v, t]) => `<option value="${v}" ${s.refreshMinutes === v ? 'selected' : ''}>${t}</option>`).join('');

  $('#settings-body').innerHTML = `
    <div class="section-title">Валюты</div>
    <div class="group">
      <button class="item" id="open-manage">
        <div class="item-text">
          <div class="item-title">Мои валюты</div>
          <div class="item-sub">${s.currencies.join(', ')}</div>
        </div>
        <span style="color: var(--muted)">›</span>
      </button>
      <div class="item">
        <div class="item-text"><div class="item-title">Точность</div><div class="item-sub">Знаков после запятой</div></div>
        <select data-select="precision">${precisionOpts}</select>
      </div>
      <div class="item">
        <div class="item-text"><div class="item-title">Обновление курсов</div></div>
        <select data-select="refreshMinutes">${refreshOpts}</select>
      </div>
    </div>

    <div class="section-title">Запуск</div>
    <div class="group">
      ${switchRow('autostart', 'Запускать вместе с Windows', 'Приложение стартует при входе в систему')}
      ${switchRow('hideMainOnAutostart', 'Не открывать окно при автозапуске', 'Только иконка в трее и виджет, если он включён', { disabled: !s.autostart })}
      ${switchRow('closeToTray', 'Сворачивать в трей при закрытии', 'Крестик прячет окно, выход через меню в трее')}
      ${switchRow('mainOnTop', 'Окно поверх всех окон', '')}
    </div>

    <div class="section-title">Виджет на рабочем столе</div>
    <div class="group">
      ${switchRow('widgetEnabled', 'Показывать виджет', 'Компактный конвертер на рабочем столе. Если включён, запускается вместе с приложением')}
      ${switchRow('widgetOnTop', 'Виджет поверх всех окон', '', { disabled: !s.widgetEnabled })}
      <div class="item">
        <div class="item-text"><div class="item-title">Непрозрачность</div><div class="item-sub">${Math.round(s.widgetOpacity * 100)}%</div></div>
        <input type="range" min="40" max="100" step="5" value="${Math.round(s.widgetOpacity * 100)}" data-range="widgetOpacity" />
      </div>
      <div class="item">
        <div class="item-text"><div class="item-title">Положение</div><div class="item-sub">Перетаскивайте виджет за верхнюю строку</div></div>
        <button class="btn" id="widget-reset">В угол экрана</button>
      </div>
    </div>
    <div class="note">Правый клик по виджету открывает его меню. Ввод в виджете с клавиатуры: кликните по нужной валюте и печатайте, можно с + − * / и %.</div>

    <div class="section-title">О программе</div>
    <div class="group">
      <div class="item">
        <div class="item-text">
          <div class="item-title">MeowsConvert</div>
          <div class="item-sub">Горячие клавиши: цифры, + − * / %, Enter — равно, Esc — сброс, ↑↓ — выбор валюты, Ctrl+C / Ctrl+V</div>
        </div>
      </div>
    </div>
  `;
}

$('#settings-body').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.setting) window.api.setSettings({ [t.dataset.setting]: t.checked });
  if (t.dataset.select === 'precision') window.api.setSettings({ precision: t.value });
  if (t.dataset.select === 'refreshMinutes') window.api.setSettings({ refreshMinutes: Number(t.value) });
});

$('#settings-body').addEventListener('input', (e) => {
  if (e.target.dataset.range === 'widgetOpacity') {
    const v = Number(e.target.value) / 100;
    e.target.previousElementSibling.querySelector('.item-sub').textContent = `${Math.round(v * 100)}%`;
    window.api.setSettings({ widgetOpacity: v });
  }
});

$('#settings-body').addEventListener('click', (e) => {
  if (e.target.closest('#open-manage')) openPicker({ mode: 'manage' });
  if (e.target.closest('#widget-reset')) window.api.setSettings({ widgetBounds: null });
});

converter.init();
