const $ = (sel) => document.querySelector(sel);

const converter = window.MC.createConverter({
  rowsEl: $('#rows'),
  onRender: (state) => {
    const st = window.MC.ratesStatus(state.rates);
    const status = $('#status');
    status.textContent = st.text;
    status.className = `status ${st.kind}`;
    $('#w-refresh').classList.toggle('spin', !!state.rates.loading);
  },
});

// Высота окна подстраивается под количество валют
new ResizeObserver(() => {
  window.api.widgetResize($('#widget').getBoundingClientRect().height);
}).observe($('#widget'));

window.addEventListener('focus', () => document.body.classList.add('focused'));
window.addEventListener('blur', () => document.body.classList.remove('focused'));

$('#w-refresh').addEventListener('click', () => window.api.refreshRates());
$('#w-open').addEventListener('click', () => window.api.openMain());
$('#w-menu').addEventListener('click', () => window.api.widgetMenu());
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.api.widgetMenu();
});

converter.init();
