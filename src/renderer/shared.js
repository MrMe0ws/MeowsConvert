(function () {
  const NBSP = ' ';
  const OPS = '+−×÷';

  // ---------- Числа ----------

  function groupInt(s) {
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  }

  function formatValue(v, precision) {
    if (!Number.isFinite(v)) return '—';
    if (Math.abs(v) >= 1e18) return v.toExponential(3).replace('.', ',');
    const a = Math.abs(v);
    let digits;
    if (precision === 'auto') {
      if (a === 0 || a >= 1000) digits = 0;
      else if (a >= 1) digits = 2;
      else digits = Math.min(8, Math.max(2, 2 - Math.floor(Math.log10(a))));
    } else {
      digits = Number(precision);
    }
    let [int, dec = ''] = v.toFixed(digits).split('.');
    const neg = int.startsWith('-');
    if (neg) int = int.slice(1);
    if (precision === 'auto') dec = a >= 1 ? dec.replace(/^0+$/, '') : dec.replace(/0+$/, '');
    if (neg && /^0*$/.test(int + dec)) return '0';
    return (neg ? '−' : '') + groupInt(int) + (dec ? ',' + dec : '');
  }

  // Значение без пробелов, пригодное для дальнейшего редактирования
  function toRaw(v, precision) {
    if (!Number.isFinite(v) || v === 0) return '';
    return formatValue(v, precision).replace(/ /g, '');
  }

  function formatExpr(expr) {
    if (!expr) return '0';
    return expr
      .replace(/(\d+)(,\d*)?/g, (_m, int, dec) => groupInt(int) + (dec || ''))
      .replace(/(.)([+−×÷])/g, `$1${NBSP}$2${NBSP}`);
  }

  // ---------- Выражения ----------

  function tokenize(expr) {
    const tokens = [];
    let num = '';
    for (const ch of expr) {
      if (/[\d,]/.test(ch)) {
        num += ch;
      } else {
        if (num) tokens.push({ n: parseFloat(num.replace(',', '.')) || 0 });
        num = '';
        tokens.push({ op: ch });
      }
    }
    if (num) tokens.push({ n: parseFloat(num.replace(',', '.')) || 0 });
    return tokens;
  }

  // Поддерживает + − × ÷ и %: «200 + 10%» = 220, «50%» = 0,5
  function evaluate(expr) {
    const t = tokenize(expr);
    while (t.length && t[t.length - 1].op && t[t.length - 1].op !== '%') t.pop();
    if (!t.length) return 0;
    let i = 0;

    function factor() {
      let neg = false;
      while (t[i] && t[i].op === '−') {
        neg = !neg;
        i++;
      }
      const tok = t[i++];
      if (!tok || tok.n === undefined) return { v: NaN, pct: false };
      let pct = false;
      while (t[i] && t[i].op === '%') {
        pct = true;
        i++;
      }
      return { v: neg ? -tok.n : tok.n, pct };
    }

    function term() {
      const f = factor();
      let v = f.pct ? f.v / 100 : f.v;
      let single = true;
      while (t[i] && (t[i].op === '×' || t[i].op === '÷')) {
        const op = t[i++].op;
        const g = factor();
        const gv = g.pct ? g.v / 100 : g.v;
        v = op === '×' ? v * gv : v / gv;
        single = false;
      }
      return { v, pct: single && f.pct, raw: f.v };
    }

    let acc = term().v;
    while (t[i] && (t[i].op === '+' || t[i].op === '−')) {
      const op = t[i++].op;
      const r = term();
      const rv = r.pct ? (acc * r.raw) / 100 : r.v;
      acc = op === '+' ? acc + rv : acc - rv;
    }
    return acc;
  }

  function convert(amount, from, to, rates) {
    if (!rates || !rates[from] || !rates[to]) return NaN;
    return (amount / rates[from]) * rates[to];
  }

  // ---------- Строка ввода ----------

  class Calc {
    constructor() {
      this.expr = '';
      this.fresh = true;
    }

    load(raw) {
      this.expr = raw;
      this.fresh = true;
    }

    get amount() {
      return evaluate(this.expr);
    }

    get hasOperation() {
      return /[+×÷%]|.−/.test(this.expr);
    }

    lastNumber() {
      return this.expr.match(/[\d,]*$/)[0];
    }

    press(key) {
      if (key === 'C') {
        this.expr = '';
        this.fresh = false;
      } else if (key === 'back') {
        this.expr = this.fresh ? '' : this.expr.slice(0, -1);
        this.fresh = false;
      } else if (key === '=') {
        const v = evaluate(this.expr);
        this.expr = Number.isFinite(v) ? toRaw(Math.round(v * 1e8) / 1e8, 'auto') : '';
        this.fresh = true;
      } else if (/^\d$/.test(key)) {
        if (this.fresh) this.expr = '';
        this.fresh = false;
        const last = this.lastNumber();
        if (last.replace(',', '').length >= 15) return false;
        if (last === '0') this.expr = this.expr.slice(0, -1);
        this.expr += key;
      } else if (key === ',') {
        if (this.fresh) this.expr = '';
        this.fresh = false;
        const last = this.lastNumber();
        if (last.includes(',')) return false;
        this.expr += last ? ',' : '0,';
      } else if (OPS.includes(key)) {
        this.fresh = false;
        if (!this.expr || this.expr === '−') {
          this.expr = key === '−' ? '−' : this.expr;
          return true;
        }
        const last = this.expr.slice(-1);
        if (OPS.includes(last) || last === ',') this.expr = this.expr.slice(0, -1) + key;
        else this.expr += key;
      } else if (key === '%') {
        this.fresh = false;
        if (/[\d%]/.test(this.expr.slice(-1))) this.expr += '%';
        else return false;
      } else {
        return false;
      }
      return true;
    }
  }

  function keyFromEvent(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return null;
    const map = {
      '+': '+', '-': '−', '*': '×', '/': '÷', x: '×', X: '×', '%': '%',
      ',': ',', '.': ',', Enter: '=', '=': '=', Backspace: 'back',
      Escape: 'C', Delete: 'C',
    };
    if (/^\d$/.test(e.key)) return e.key;
    return map[e.key] || null;
  }

  // ---------- Интерфейс ----------

  function flag(code, extraClass = '') {
    const info = window.CURRENCIES[code];
    const country = info ? info[1] : 'xx';
    return `<span class="fi fis flag fi-${country} ${extraClass}"></span>`;
  }

  function currencyName(code) {
    return window.CURRENCIES[code]?.[0] || code;
  }

  function timeAgo(ts) {
    const min = Math.floor((Date.now() - ts) / 60e3);
    if (min < 1) return 'Только что';
    if (min < 60) return `${min} мин назад`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} ч назад`;
    return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  }

  function ratesStatus(rates) {
    if (rates.loading && !rates.rates) return { text: 'Загрузка курсов…', kind: 'muted' };
    if (!rates.rates) return { text: rates.error ? 'Нет курсов — проверьте интернет' : 'Нет курсов', kind: 'bad' };
    const ago = timeAgo(rates.fetchedAt);
    if (rates.loading) return { text: `Обновление… · ${ago}`, kind: 'muted' };
    if (rates.error) return { text: `Нет сети · ${ago}`, kind: 'warn' };
    const stale = Date.now() - rates.fetchedAt > 24 * 3600e3;
    return { text: ago, kind: stale ? 'warn' : 'ok' };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  // Общий конвертер для главного окна и виджета
  function createConverter({ rowsEl, onChipClick, onRender }) {
    const calc = new Calc();
    const state = { settings: null, rates: null, active: null };

    function amount() {
      return calc.amount;
    }

    function activate(code) {
      if (code === state.active) return;
      const value = Number.isFinite(amount()) && state.active
        ? convert(amount(), state.active, code, state.rates.rates)
        : 0;
      state.active = code;
      calc.load(toRaw(value, state.settings.precision));
      render();
      sync();
    }

    function sync() {
      const v = amount();
      window.api.setConversion({ code: state.active, amount: Number.isFinite(v) ? v : 0, expr: calc.expr });
    }

    function applyConversion(conv) {
      const list = state.settings.currencies;
      const { code, amount: value = 0, expr } = conv || {};
      if (list.includes(code)) {
        state.active = code;
        calc.load(typeof expr === 'string' ? expr : toRaw(value, 'auto'));
        return;
      }
      const first = list[0];
      const converted = code ? convert(value, code, first, state.rates?.rates) : 0;
      state.active = first;
      calc.load(toRaw(Number.isFinite(converted) ? converted : 0, state.settings.precision));
    }

    function press(key) {
      if (!state.active) return;
      if (calc.press(key)) {
        render();
        sync();
      }
    }

    function render() {
      const { settings, rates } = state;
      if (!settings) return;
      const value = amount();
      rowsEl.innerHTML = settings.currencies
        .map((code, index) => {
          const isActive = code === state.active;
          let text;
          let hint = '';
          if (isActive) {
            text = formatExpr(calc.expr);
            if (calc.hasOperation && Number.isFinite(value)) hint = '= ' + formatValue(value, settings.precision);
          } else {
            text = formatValue(convert(value, state.active, code, rates.rates), settings.precision);
          }
          return `
            <div class="row${isActive ? ' active' : ''}" data-code="${code}" data-index="${index}">
              <button class="chip" title="${escapeHtml(currencyName(code))}">${flag(code)}<span class="code">${code}</span></button>
              <div class="field" title="${escapeHtml(currencyName(code))}">
                <div class="value${text.length > 16 ? ' long' : ''}">${escapeHtml(text)}${isActive ? '<span class="caret"></span>' : ''}</div>
                ${hint ? `<div class="hint">${escapeHtml(hint)}</div>` : ''}
              </div>
            </div>`;
        })
        .join('');
      onRender?.(state);
    }

    rowsEl.addEventListener('click', (e) => {
      const row = e.target.closest('.row');
      if (!row) return;
      if (e.target.closest('.chip') && onChipClick) onChipClick(row.dataset.code, Number(row.dataset.index));
      else activate(row.dataset.code);
    });

    window.addEventListener('keydown', (e) => {
      if (e.target.closest?.('input, select, textarea') || !isKeypadEnabled()) return;
      const list = state.settings?.currencies || [];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const i = list.indexOf(state.active) + (e.key === 'ArrowDown' ? 1 : -1);
        if (list[i]) activate(list[i]);
        e.preventDefault();
        return;
      }
      if (e.ctrlKey && (e.key === 'c' || e.key === 'с')) {
        const v = amount();
        if (Number.isFinite(v)) navigator.clipboard.writeText(toRaw(v, state.settings.precision) || '0');
        return;
      }
      if (e.ctrlKey && (e.key === 'v' || e.key === 'м')) {
        navigator.clipboard.readText().then((txt) => {
          const clean = txt.replace(/[\s ]/g, '').replace('.', ',').replace(/[^\d,]/g, '');
          if (!clean) return;
          calc.load('');
          for (const ch of clean) calc.press(ch);
          render();
          sync();
        });
        return;
      }
      const key = keyFromEvent(e);
      if (key) {
        e.preventDefault();
        press(key);
      }
    });

    let keypadEnabled = () => true;
    function isKeypadEnabled() {
      return keypadEnabled();
    }

    return {
      state,
      calc,
      press,
      render,
      activate,
      setKeypadGuard(fn) {
        keypadEnabled = fn;
      },
      async init() {
        const s = await window.api.getState();
        state.settings = s.settings;
        state.rates = s.rates;
        applyConversion(s.settings.conversion);
        render();

        window.api.on('rates', (rates) => {
          state.rates = rates;
          render();
        });
        window.api.on('settings', (settings) => {
          const prevActive = state.active;
          state.settings = settings;
          if (!settings.currencies.includes(prevActive)) {
            applyConversion({ code: prevActive, amount: amount() });
            sync();
          }
          render();
        });
        window.api.on('conversion', (conv) => {
          applyConversion(conv);
          render();
        });
        setInterval(render, 30e3);
        return s;
      },
    };
  }

  window.MC = {
    formatValue, formatExpr, evaluate, convert, toRaw, flag, currencyName,
    ratesStatus, timeAgo, escapeHtml, createConverter,
  };
})();
