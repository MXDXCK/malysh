'use strict';
/*
 * Малыш — дневник мамы.
 * Все данные хранятся только на этом устройстве (localStorage).
 * Обновления: приложение сверяет APP_VERSION с файлом version.json на сайте.
 */

const APP_VERSION = '1.2.0';
const KEY = 'malysh.v1';
const MIN = 6e4, HOUR = 36e5, DAY = 864e5;
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = n => String(n).padStart(2, '0');
const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

/* ---------------- Хранилище ---------------- */
function defaults() {
  return { profile: { name: '', birth: '', theme: 'auto' }, events: [], growth: [], vacc: { done: {}, custom: [] }, solids: {}, solidsCustom: [], timers: {} };
}
function normalize(d) {
  const b = defaults();
  if (!d || typeof d !== 'object') return b;
  return {
    profile: { ...b.profile, ...(d.profile || {}) },
    events: Array.isArray(d.events) ? d.events : [],
    growth: Array.isArray(d.growth) ? d.growth : [],
    vacc: { done: (d.vacc && d.vacc.done) || {}, custom: (d.vacc && Array.isArray(d.vacc.custom)) ? d.vacc.custom : [] },
    solids: (d.solids && typeof d.solids === 'object') ? d.solids : {},
    solidsCustom: Array.isArray(d.solidsCustom) ? d.solidsCustom : [],
    timers: (() => { const t = { ...(d.timers || {}) }; delete t.breast; return t; })(), // грудное вскармливание убрано в 1.1.0
  };
}
function load() {
  try { return normalize(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch (e) { return defaults(); }
}
let S = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('Не получилось сохранить данные'); }
  if (window.Sync) window.Sync.push();
}

/* ---------------- Синхронизация: данные как набор отдельных записей ---------------- */
// Каждая запись — отдельный документ в облаке, поэтому мама и папа могут
// одновременно добавлять записи, и ничего не перезапишется.
function flatten(st = S) {
  const f = {};
  f.profile = JSON.stringify({ name: st.profile.name, birth: st.profile.birth });
  if (st.timers && Object.keys(st.timers).length) f.timers = JSON.stringify(st.timers);
  st.events.forEach(e => { f['ev_' + e.id] = JSON.stringify(e); });
  st.growth.forEach(g => { f['gr_' + g.id] = JSON.stringify(g); });
  Object.entries(st.vacc.done).forEach(([k, v]) => { f['vd_' + k] = JSON.stringify(v); });
  st.vacc.custom.forEach(c => { f['cu_' + c.id] = JSON.stringify(c); });
  Object.entries(st.solids || {}).forEach(([k, v]) => { f['sf_' + k] = JSON.stringify(v); });
  (st.solidsCustom || []).forEach(c => { f['sp_' + c.key] = JSON.stringify(c); });
  return f;
}
function unflatten(map) {
  const st = defaults(); st.profile.theme = S.profile.theme; // тема у каждого телефона своя
  for (const [id, raw] of Object.entries(map)) {
    let v; try { v = JSON.parse(raw); } catch (e) { continue; }
    if (!v) continue;
    if (id === 'profile') Object.assign(st.profile, { name: v.name || '', birth: v.birth || '' });
    else if (id === 'timers') st.timers = v;
    else if (id.startsWith('ev_')) st.events.push(v);
    else if (id.startsWith('gr_')) st.growth.push(v);
    else if (id.startsWith('vd_')) st.vacc.done[id.slice(3)] = v;
    else if (id.startsWith('cu_')) st.vacc.custom.push(v);
    else if (id.startsWith('sf_')) st.solids[id.slice(3)] = v;
    else if (id.startsWith('sp_')) st.solidsCustom.push(v);
  }
  return st;
}
let renderPending = false;
window.App = {
  flatten: () => flatten(S),
  applyRemote(map) {
    S = unflatten(map);
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* */ }
    if (dlg.open) renderPending = true; else render();
  },
  syncChanged() {
    const el = $('#sync-status'); if (el) el.textContent = syncLabel();
    const dot = $('.icon-btn .sync'); if (dot) dot.dataset.s = window.Sync ? window.Sync.status : 'off';
  },
};
function syncLabel() {
  const sy = window.Sync; if (!sy) return '';
  const err = String(sy.error || '');
  const why = /operation-not-allowed|admin-restricted/.test(err) ? 'в Firebase не включён анонимный вход (Authentication → Sign-in method → Anonymous)'
    : /permission-denied/.test(err) ? 'нет доступа — проверьте правила Firestore (вкладка Rules → Publish)'
    : /not-found|NOT_FOUND/.test(err) ? 'база Firestore не найдена — создайте базу (default)'
    : 'ошибка: ' + (err || 'неизвестно');
  return { off: 'выключена', connecting: 'подключаюсь…', on: 'работает ✓', offline: 'нет интернета — изменения отправятся позже', error: why }[sy.status] || sy.status;
}

/* ---------------- Даты и форматирование ---------------- */
function pl(n, f) { n = Math.abs(n) % 100; const n1 = n % 10; if (n > 10 && n < 20) return f[2]; if (n1 > 1 && n1 < 5) return f[1]; if (n1 === 1) return f[0]; return f[2]; }
function hhmm(ts) { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function dur(ms) {
  if (ms > 0 && ms < MIN) return '<1 мин';
  const m = Math.round(ms / MIN);
  if (m < 60) return m + ' мин';
  const h = Math.floor(m / 60), r = m % 60;
  return h + ' ч' + (r ? ' ' + r + ' мин' : '');
}
function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return (h ? h + ':' + pad(m) : m) + ':' + pad(x);
}
function ago(ts) { const ms = Date.now() - ts; return ms < MIN ? 'только что' : dur(ms) + ' назад'; }
function dateStr(d) { d = new Date(d); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
const todayStr = () => dateStr(Date.now());
const dayKey = ts => dateStr(ts);
function parseDate(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); }
function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function addDays(ts, n) { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); }
function addMonths(date, m) {
  const x = new Date(date); const day = x.getDate();
  x.setDate(1); x.setMonth(x.getMonth() + m);
  const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
  x.setDate(Math.min(day, last));
  return x;
}
const fmtLong = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const fmtShort = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const fmtDay = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtWd = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });
function dayLabel(ts) {
  const k = dayKey(ts);
  if (k === todayStr()) return 'Сегодня';
  if (k === dayKey(addDays(Date.now(), -1))) return 'Вчера';
  return fmtDay.format(ts);
}
function ageText(birth) {
  if (!birth) return '';
  const b = parseDate(birth), now = new Date();
  const days = Math.round((startOfDay(now) - b.getTime()) / DAY);
  if (days < 0) return 'скоро появится на свет';
  if (days === 0) return 'родился сегодня 🎉';
  if (days < 14) return days + ' ' + pl(days, ['день', 'дня', 'дней']);
  let m = (now.getFullYear() - b.getFullYear()) * 12 + now.getMonth() - b.getMonth();
  if (now.getDate() < b.getDate()) m--;
  const restDays = Math.round((startOfDay(now) - addMonths(b, m).getTime()) / DAY);
  if (m < 1) { const w = Math.floor(days / 7); return w + ' ' + pl(w, ['неделя', 'недели', 'недель']) + (days % 7 ? ' ' + days % 7 + ' дн.' : ''); }
  if (m < 12) return m + ' мес.' + (restDays ? ' ' + restDays + ' дн.' : '');
  const y = Math.floor(m / 12), mm = m % 12;
  return y + ' ' + pl(y, ['год', 'года', 'лет']) + (mm ? ' ' + mm + ' мес.' : '');
}

/* ---------------- Иконки ---------------- */
const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  home: svg('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  heart: svg('<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/>'),
  bottle: svg('<path d="M9.5 2.5h5M10.5 2.5v3L8 9v11a1.5 1.5 0 0 0 1.5 1.5h5A1.5 1.5 0 0 0 16 20V9l-2.5-3.5v-3M8 13h8M8 17h8"/>'),
  bowl: svg('<path d="M3 11h18a9 9 0 0 1-18 0z"/><path d="M12 3v4M7.5 4.5l1.5 3M16.5 4.5 15 7.5"/>'),
  moon: svg('<path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a6.6 6.6 0 0 0 10 10z"/>'),
  chart: svg('<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 6-7"/>'),
  shield: svg('<path d="M12 3 4.5 6v5.5c0 4.7 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.8 7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>'),
  sliders: svg('<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  chevL: svg('<path d="m15 18-6-6 6-6"/>'),
  chevR: svg('<path d="m9 18 6-6-6-6"/>'),
};

/* ---------------- Календарь прививок (национальный календарь РФ) ---------------- */
const VACC = [
  { k: 'hb1', n: 'Гепатит B — 1-я', when: 'Первые сутки', at: { d: 0 } },
  { k: 'bcg', n: 'Туберкулёз (БЦЖ)', when: '3–7 день', at: { d: 3 } },
  { k: 'hb2', n: 'Гепатит B — 2-я', when: '1 месяц', at: { m: 1 } },
  { k: 'pn1', n: 'Пневмококк — 1-я', when: '2 месяца', at: { m: 2 } },
  { k: 'dtp1', n: 'АКДС — 1-я (дифтерия, коклюш, столбняк)', when: '3 месяца', at: { m: 3 } },
  { k: 'pol1', n: 'Полиомиелит — 1-я', when: '3 месяца', at: { m: 3 } },
  { k: 'hib1', n: 'Гемофильная инфекция — 1-я', when: '3 месяца', at: { m: 3 } },
  { k: 'dtp2', n: 'АКДС — 2-я', when: '4,5 месяца', at: { m: 4, d: 15 } },
  { k: 'pol2', n: 'Полиомиелит — 2-я', when: '4,5 месяца', at: { m: 4, d: 15 } },
  { k: 'hib2', n: 'Гемофильная инфекция — 2-я', when: '4,5 месяца', at: { m: 4, d: 15 } },
  { k: 'pn2', n: 'Пневмококк — 2-я', when: '4,5 месяца', at: { m: 4, d: 15 } },
  { k: 'dtp3', n: 'АКДС — 3-я', when: '6 месяцев', at: { m: 6 } },
  { k: 'pol3', n: 'Полиомиелит — 3-я', when: '6 месяцев', at: { m: 6 } },
  { k: 'hb3', n: 'Гепатит B — 3-я', when: '6 месяцев', at: { m: 6 } },
  { k: 'hib3', n: 'Гемофильная инфекция — 3-я', when: '6 месяцев', at: { m: 6 } },
  { k: 'mmr1', n: 'Корь, краснуха, паротит', when: '12 месяцев', at: { m: 12 } },
  { k: 'pnR', n: 'Пневмококк — ревакцинация', when: '15 месяцев', at: { m: 15 } },
  { k: 'dtpR1', n: 'АКДС — 1-я ревакцинация', when: '18 месяцев', at: { m: 18 } },
  { k: 'polR1', n: 'Полиомиелит — 1-я ревакцинация', when: '18 месяцев', at: { m: 18 } },
  { k: 'hibR', n: 'Гемофильная инфекция — ревакцинация', when: '18 месяцев', at: { m: 18 } },
  { k: 'polR2', n: 'Полиомиелит — 2-я ревакцинация', when: '20 месяцев', at: { m: 20 } },
  { k: 'mmr2', n: 'Корь, краснуха, паротит — ревакцинация', when: '6 лет', at: { m: 72 } },
  { k: 'polR3', n: 'Полиомиелит — 3-я ревакцинация', when: '6 лет', at: { m: 72 } },
  { k: 'adsR2', n: 'АДС-М — 2-я ревакцинация (дифтерия, столбняк)', when: '6–7 лет', at: { m: 72 } },
  { k: 'bcgR', n: 'БЦЖ — ревакцинация (по показаниям)', when: '6–7 лет', at: { m: 72 } },
];
function vaccDue(v) {
  const b = parseDate(S.profile.birth);
  return addDays(addMonths(b, v.at.m || 0).getTime(), v.at.d || 0);
}
function vStatus(due, done) {
  if (done) return ['done', 'Сделано'];
  const diff = (due - startOfDay(Date.now())) / DAY;
  if (diff < -30) return ['late', 'Просрочено'];
  if (diff <= 0) return ['now', 'Пора'];
  if (diff <= 30) return ['soon', 'Скоро'];
  return ['later', ''];
}
function schedule() {
  return VACC.map(v => { const due = vaccDue(v); const done = S.vacc.done[v.k]; return { ...v, due, done, st: vStatus(due, done) }; });
}

/* ---------------- Расчёты ---------------- */
const isFeed = e => e.type === 'breast' || e.type === 'bottle';
const isFeedAny = e => isFeed(e) || e.type === 'solid';
function latest(list, f = 'start') { return list.reduce((a, e) => (!a || e[f] > a[f] ? e : a), null); }
function sleepOn(dayStart) {
  const dayEnd = addDays(dayStart, 1);
  const parts = S.events.filter(e => e.type === 'sleep').map(e => [e.start, e.end]);
  if (S.timers.sleep) parts.push([S.timers.sleep.start, Date.now()]);
  return sum(parts, ([a, b]) => Math.max(0, Math.min(b, dayEnd) - Math.max(a, dayStart)));
}
function breastMs(e) { return (e.L || 0) + (e.R || 0); }
function nextSideSuggestion() {
  const last = latest(S.events.filter(e => e.type === 'breast'));
  if (!last) return null;
  const side = last.last || (last.R && !last.L ? 'R' : 'L');
  return side === 'L' ? 'R' : 'L';
}
const REACTIONS = { '': 'Нет', rash: 'Сыпь', tummy: 'Животик', stool: 'Стул', dislike: 'Не понравилось' };
function foodSummary() {
  const m = new Map();
  S.events.filter(e => e.type === 'solid' && e.food).sort((a, b) => a.start - b.start).forEach(e => {
    const key = e.food.trim().toLowerCase();
    const f = m.get(key) || { name: e.food.trim(), first: e.start, times: 0, reaction: false };
    f.times++; if (e.reaction) f.reaction = true;
    m.set(key, f);
  });
  return [...m.values()].sort((a, b) => b.first - a.first);
}

/* ---------------- Обновления ---------------- */
let update = null; // { version, date, notes[] } если на сайте есть версия новее
function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}
async function checkUpdate(manual) {
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const remote = await r.json();
    update = newer(remote.version, APP_VERSION) ? remote : null;
    if (manual) toast(update ? 'Есть новая версия ' + remote.version : 'У вас последняя версия');
  } catch (e) {
    if (manual) toast('Не удалось проверить — нет интернета?');
  }
  if (!dlg.open) render(); else if (manual) settingsForm();
}
async function applyUpdate() {
  toast('Обновляю…');
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
    }
    if (window.caches) { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); }
  } catch (e) { /* ничего страшного — просто перезагрузим */ }
  location.reload();
}
function updateBanner() {
  if (!update) return '';
  return `<section class="card update-banner"><span class="dot growth">${I.refresh}</span><div><b>Доступна версия ${esc(update.version)}</b><small>Данные сохранятся</small></div><button class="btn ok small" data-act="whatsnew">Обновить</button></section>`;
}
function whatsNew() {
  if (!update) return;
  openSheet('Новая версия ' + update.version,
    `<p class="muted">Сейчас установлена ${APP_VERSION}${update.date ? ' · обновление от ' + esc(fmtLong.format(parseDate(update.date))) : ''}</p>` +
    (Array.isArray(update.notes) && update.notes.length ? `<div class="field"><span>Что нового</span><ul class="whatsnew">${update.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>` : '') +
    `<p class="muted">Все записи о малыше останутся на месте.</p>`,
    () => { applyUpdate(); return false; }, { ok: 'Обновить сейчас' });
}

/* ---------------- Рендер ---------------- */
let tab = location.hash.slice(1) || 'today';
let metric = 'weight';
const TABS = [['today', 'Сегодня', I.home], ['sleep', 'Сон', I.moon], ['feed', 'Кормление', I.bottle], ['solid', 'Прикорм', I.bowl], ['growth', 'Рост', I.chart], ['vacc', 'Прививки', I.shield]];

function applyTheme() {
  const t = S.profile.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
function header() {
  const p = S.profile;
  return `<header class="top"><div class="who"><div class="avatar">${esc((p.name || 'М').trim()[0] || 'М').toUpperCase()}</div><div><h1>${esc(p.name || 'Малыш')}</h1><p>${p.birth ? ageText(p.birth) : 'Дневник мамы'}</p></div></div>
  <button class="icon-btn" data-act="settings" aria-label="Настройки">${I.sliders}${update ? '<i class="badge"></i>' : ''}${window.Sync && window.Sync.family ? `<i class="sync" data-s="${window.Sync.status}" title="Синхронизация"></i>` : ''}</button></header>`;
}
function tabbar() {
  return `<div class="tabbar"><nav>${TABS.map(([k, l, ic]) => `<a href="#${k}" class="${tab === k ? 'on' : ''}" ${tab === k ? 'aria-current="page"' : ''}><span class="pip">${ic}</span>${l}</a>`).join('')}</nav></div>`;
}
function render() {
  applyTheme();
  if (!VIEWS[tab]) tab = 'today';
  $('#app').innerHTML = header() + `<main class="view">${VIEWS[tab]()}</main>` + tabbar();
  tick();
}
function tick() {
  const now = Date.now();
  document.querySelectorAll('[data-base],[data-since]').forEach(el => {
    const base = +el.dataset.base || 0, since = el.dataset.since ? +el.dataset.since : 0;
    el.textContent = clock(base + (since ? now - since : 0));
  });
}

/* ---- Сон: дневной и ночной ---- */
// Ночной сон относится к дате утра, когда малыш проснулся (ночь «на 31 октября»)
function autoKind(ts) { const h = new Date(ts).getHours(); return (h >= 19 || h < 6) ? 'night' : 'day'; }
const sleepKind = e => e.kind || autoKind(e.start);
function nightKey(ts) { return new Date(ts).getHours() >= 12 ? dateStr(addDays(ts, 1)) : dateStr(ts); }
function allSleeps() {
  const l = S.events.filter(e => e.type === 'sleep');
  const t = S.timers.sleep;
  if (t) l.push({ id: 'live', type: 'sleep', start: t.start, end: Date.now(), live: true, kind: t.kind || autoKind(t.start) });
  return l;
}
function sleepsFor(D) {
  const all = allSleeps(), by = (a, b) => a.start - b.start;
  return {
    night: all.filter(e => sleepKind(e) === 'night' && nightKey(e.start) === D).sort(by),
    day: all.filter(e => sleepKind(e) === 'day' && dayKey(e.start) === D).sort(by),
  };
}
const sleepDur = l => sum(l, e => e.end - e.start);
function durS(ms) { const m = Math.round(ms / MIN); if (m < 60) return m + ' мин'; return Math.floor(m / 60) + ' ч' + (m % 60 ? ' ' + m % 60 + ' м' : ''); }
function sleepTile(e, label) {
  const inner = `<small>${label}</small><b>${e.live ? `<span data-since="${e.start}"></span>` : durS(e.end - e.start)}</b><span>${hhmm(e.start)} – ${e.live ? 'спит' : hhmm(e.end)}</span>`;
  return e.live ? `<div class="tile ${sleepKind(e)} live">${inner}</div>` : `<button class="tile ${sleepKind(e)}" data-ev="${e.id}">${inner}</button>`;
}
const fmtDM = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
// Блок плашек сна за дату D. nightD — дата ночи, которую показываем (по умолчанию ночь на D)
function sleepBlocks(D, nightD = D, nightTitle) {
  const n = sleepsFor(nightD).night, d = sleepsFor(D).day;
  const nt = nightTitle || 'Ночь на ' + fmtDM.format(parseDate(nightD));
  const wakes = n.length > 1 ? ` · просыпался ${n.length - 1} ${pl(n.length - 1, ['раз', 'раза', 'раз'])}` : '';
  return `<div class="sp-head night"><h4>${I.moon}${nt}</h4><span>${n.length ? dur(sleepDur(n)) + wakes : ''}</span></div>
    <div class="tiles">${n.map((e, i) => sleepTile(e, n.length > 1 ? 'Часть ' + (i + 1) : 'Ночной сон')).join('')}<button class="tile add night" data-act="add-sleep" data-kind="night" data-d="${nightD}">${I.plus}<span>Ночь</span></button></div>
    <div class="sp-head day"><h4>${I.sun}Дневной сон</h4><span>${d.length ? d.length + ' ' + pl(d.length, ['раз', 'раза', 'раз']) + ' · ' + dur(sleepDur(d)) : ''}</span></div>
    <div class="tiles">${d.map((e, i) => sleepTile(e, 'Сон ' + (i + 1))).join('')}<button class="tile add day" data-act="add-sleep" data-kind="day" data-d="${D}">${I.plus}<span>Дневной</span></button></div>`;
}
function sleepButton() {
  const t = S.timers.sleep;
  if (t) {
    const k = t.kind || autoKind(t.start);
    return `<div class="sleep-now ${k}"><div><small>${k === 'night' ? 'Ночной сон' : 'Дневной сон'} · с ${hhmm(t.start)}</small><b data-since="${t.start}"></b></div>
      <button class="btn ghost small" data-act="sleep-cancel">Отмена</button><button class="btn sleep" data-act="sleep-toggle">${I.sun} Проснулся</button></div>`;
  }
  const k = autoKind(Date.now());
  const last = latest(S.events.filter(e => e.type === 'sleep'), 'end');
  return `<div class="sleep-now idle"><div><small>${last ? 'Бодрствует · проснулся в ' + hhmm(last.end) : 'Малыш бодрствует'}</small><b>${last ? dur(Date.now() - last.end) : '—'}</b></div>
    <button class="btn sleep" data-act="sleep-toggle">${I.moon} Уснул</button></div><p class="hint" style="margin:8px 0 0">Начнётся ${k === 'night' ? 'ночной' : 'дневной'} сон — тип можно поменять, нажав на плашку</p>`;
}
function partOfDay(h) { return h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 17 ? 'Добрый день' : h < 23 ? 'Добрый вечер' : 'Доброй ночи'; }

/* ---- Прикорм: продукты ---- */
const SOLID_GROUPS = [
  { g: 'veg', title: 'Овощи', from: 'с 4–6 мес', tip: 'Чаще всего первый прикорм. Начинают с одного светлого овоща — кабачка или цветной капусты.', items: [['zucchini', 'Кабачок'], ['cauliflower', 'Цветная капуста'], ['broccoli', 'Брокколи'], ['pumpkin', 'Тыква'], ['carrot', 'Морковь'], ['potato', 'Картофель']] },
  { g: 'cereal', title: 'Безмолочные каши', from: 'с 4–6 мес', tip: 'Сначала безглютеновые — гречневая, рисовая, кукурузная. Разводят смесью, которую пьёт малыш.', items: [['buckwheat', 'Гречневая каша'], ['rice', 'Рисовая каша'], ['corn', 'Кукурузная каша'], ['oat', 'Овсяная каша'], ['multigrain', 'Мультизлаковая каша']] },
  { g: 'oil', title: 'Масло', from: 'с 4–6 мес', tip: 'Растительное добавляют в овощное пюре, сливочное — в кашу, начиная с нескольких капель.', items: [['vegoil', 'Растительное масло'], ['butter', 'Сливочное масло']] },
  { g: 'fruit', title: 'Фрукты', from: 'с 4–6 мес', tip: 'Обычно после овощей и каш, чтобы малыш не привык сразу к сладкому.', items: [['apple', 'Яблоко'], ['pear', 'Груша'], ['banana', 'Банан'], ['prune', 'Чернослив'], ['peach', 'Персик'], ['apricot', 'Абрикос']] },
  { g: 'meat', title: 'Мясо', from: 'с 6 мес', tip: 'Начинают с нежирных сортов — индейка, кролик.', items: [['turkey', 'Индейка'], ['rabbit', 'Кролик'], ['beef', 'Говядина / телятина'], ['chicken', 'Курица']] },
  { g: 'dairy', title: 'Творог и яйцо', from: 'с 6–7 мес', tip: 'Творог — примерно с 6 мес, желток — с 7 мес, начиная с крошки.', items: [['cottage', 'Творог'], ['yolk', 'Желток']] },
  { g: 'bread', title: 'Печенье и хлеб', from: 'с 7–8 мес', tip: '', items: [['cookie', 'Детское печенье / сухарик'], ['bread', 'Пшеничный хлеб']] },
  { g: 'kefir', title: 'Кисломолочные', from: 'с 8 мес', tip: '', items: [['kefir', 'Детский кефир'], ['yogurt', 'Детский йогурт']] },
  { g: 'fish', title: 'Рыба', from: 'с 8–9 мес', tip: 'Нежирная белая рыба, 1–2 раза в неделю вместо мяса.', items: [['cod', 'Треска'], ['hake', 'Хек']] },
];
function allProducts() {
  const l = [];
  SOLID_GROUPS.forEach(gr => gr.items.forEach(([key, name]) => l.push({ key, name, g: gr.g })));
  (S.solidsCustom || []).forEach(c => l.push({ ...c, custom: true }));
  return l;
}
const findProduct = name => { const n = String(name || '').trim().toLowerCase(); return allProducts().find(p => p.name.toLowerCase() === n); };
function servingsOf(p) {
  const n = p.name.toLowerCase();
  return S.events.filter(e => e.type === 'solid' && (e.product === p.key || (e.food || '').trim().toLowerCase() === n)).sort((a, b) => a.start - b.start);
}
function productState(p) {
  const st = S.solids[p.key] || {};
  const sv = servingsOf(p);
  const start = st.start || (sv[0] ? dateStr(sv[0].start) : '');
  const reaction = sv.some(e => e.reaction);
  return { start, done: st.done || '', note: st.note || '', servings: sv, reaction };
}
function daysSince(dstr) { return Math.round((startOfDay(Date.now()) - parseDate(dstr).getTime()) / DAY) + 1; }
function productRow(p) {
  const s = productState(p);
  let sub = 'ещё не пробовали', pill = '';
  if (s.done) { sub = 'Введён ' + fmtDM.format(parseDate(s.done)) + (s.start ? ' · начали ' + fmtShort.format(parseDate(s.start)) : ''); }
  else if (s.start) { const n = daysSince(s.start); sub = 'Вводим с ' + fmtDM.format(parseDate(s.start)) + ' · день ' + n; pill = n >= 7 ? '<span class="pill done">можно отметить</span>' : '<span class="pill soon">вводим</span>'; }
  if (s.reaction) pill = '<span class="pill late">реакция</span>';
  return `<div class="row prod ${s.done ? 'done' : ''}"><button class="check" data-spc="${p.key}" aria-label="${s.done ? 'Снять отметку' : 'Отметить введённым'}">${s.done ? I.check : ''}</button><button class="row-main" data-sp="${p.key}"><b>${esc(p.name)}</b><small>${sub}</small></button>${pill}</div>`;
}

/* ---- Строки истории ---- */
function meta(e) {
  const note = e.note ? ' · ' + esc(e.note) : '';
  switch (e.type) {
    case 'breast': return { cls: 'feed', icon: I.heart, title: 'Грудь · ' + dur(breastMs(e)), sub: 'запись из прошлой версии' + note };
    case 'bottle': return { cls: 'feed', icon: I.bottle, title: 'Бутылочка · ' + (e.ml || 0) + ' мл', sub: (e.kind === 'breastmilk' ? 'Сцеженное молоко' : 'Смесь') + note };
    case 'solid': return { cls: 'solid', icon: I.bowl, title: esc(e.food || 'Прикорм') + (e.grams ? ' · ' + e.grams + ' г' : ''), sub: 'Прикорм' + (e.reaction ? ' · реакция: ' + REACTIONS[e.reaction].toLowerCase() : '') + note };
    case 'sleep': return { cls: 'sleep', icon: sleepKind(e) === 'night' ? I.moon : I.sun, title: (sleepKind(e) === 'night' ? 'Ночной сон · ' : 'Дневной сон · ') + dur(e.end - e.start), sub: hhmm(e.start) + ' – ' + hhmm(e.end) + (dayKey(e.start) !== dayKey(e.end) ? ' (след. день)' : '') + note };
  }
  return { cls: '', icon: '', title: '', sub: '' };
}
function evRow(e, withDate) {
  const m = meta(e);
  return `<button class="row" data-ev="${e.id}"><span class="dot ${m.cls}">${m.icon}</span><span class="row-main"><b>${m.title}</b><small>${m.sub}</small></span><span class="row-time">${withDate === true ? fmtShort.format(e.start) + '<br>' : ''}${hhmm(e.start)}</span></button>`;
}
function daySummary(items) {
  const f = items.filter(isFeed).length, ml = sum(items.filter(e => e.type === 'bottle'), e => +e.ml);
  const sl = sum(items.filter(e => e.type === 'sleep'), e => e.end - e.start);
  const so = items.filter(e => e.type === 'solid').length;
  return [f ? f + ' ' + pl(f, ['кормление', 'кормления', 'кормлений']) : '', ml ? ml + ' мл' : '', so ? 'прикорм ' + so : '', sl ? 'сон ' + dur(sl) : ''].filter(Boolean).join(' · ');
}
function history(list, emptyText, limit = 30) {
  if (!list.length) return `<p class="empty">${emptyText}</p>`;
  const g = new Map();
  [...list].sort((a, b) => b.start - a.start).forEach(e => { const k = dayKey(e.start); if (!g.has(k)) g.set(k, []); g.get(k).push(e); });
  return [...g.values()].slice(0, limit).map(items => `<section class="day"><h3>${dayLabel(items[0].start)}<small>${daySummary(items)}</small></h3><div class="list">${items.map(evRow).join('')}</div></section>`).join('');
}
function bars(days, fmtV, cls = '') {
  const max = Math.max(1, ...days.map(d => d.total));
  const today = startOfDay(Date.now());
  return `<div class="bars ${cls}">${days.map(d => `<div class="bar ${d.t === today ? 'today' : ''}"><span class="v">${d.total ? fmtV(d.total) : ''}</span><span class="track">${(d.parts || [{ v: d.total, c: '' }]).map(p => `<i class="${p.c}" style="height:${p.v / max * 100}%"></i>`).join('')}</span><small>${d.t === today ? 'сег' : fmtWd.format(d.t)}</small></div>`).join('')}</div>`;
}
const lastDays = n => { const t = startOfDay(Date.now()), l = []; for (let i = n - 1; i >= 0; i--) l.push(startOfDay(addDays(t, -i))); return l; };

/* ---- Экраны ---- */
let sleepDay = todayStr();
const VIEWS = {
  today() {
    const now = Date.now(), t0 = startOfDay(now), D = todayStr(), h = new Date(now).getHours();
    const ev = S.events.filter(e => e.start >= t0);
    const bottles = ev.filter(isFeed);
    const ml = sum(ev.filter(e => e.type === 'bottle'), e => +e.ml);
    const lastFeed = latest(S.events.filter(isFeed));
    let out = updateBanner() + installHint();
    out += `<section class="hero"><small>${fmtDay.format(now)}</small><h2>${partOfDay(h)}${S.profile.name ? ', ' + esc(S.profile.name) : ''}!</h2></section>`;
    if (!S.profile.birth) out += `<section class="card hello"><h3>Добро пожаловать! 👋</h3><p>Укажите имя и дату рождения малыша — приложение посчитает возраст и составит календарь прививок.</p><button class="btn primary" data-act="settings">Заполнить профиль</button></section>`;
    // Вечером показываем наступающую ночь, днём — прошедшую
    const evening = h >= 17 || (S.timers.sleep && nightKey(S.timers.sleep.start) !== D && (S.timers.sleep.kind || autoKind(S.timers.sleep.start)) === 'night');
    const nightD = evening ? dateStr(addDays(t0, 1)) : D;
    const { night: n } = sleepsFor(nightD), { day: dd } = sleepsFor(D);
    out += `<section class="card sleep-card"><div class="card-head"><h3>Сон</h3><a href="#sleep" class="link">Все дни ›</a></div>
      ${sleepButton()}
      <div class="sleep-sum"><div class="night"><small>${evening ? 'Эта ночь' : 'Прошлая ночь'}</small><b>${n.length ? durS(sleepDur(n)) : '—'}</b></div><div class="day"><small>Днём сегодня</small><b>${dd.length ? durS(sleepDur(dd)) : '—'}</b></div></div>
      ${sleepBlocks(D, nightD, evening ? 'Эта ночь' : 'Прошлая ночь')}</section>`;
    out += `<section class="quick">
      <button class="q feed" data-act="add-bottle">${I.bottle}<span>Бутылочка</span></button>
      <button class="q solid" data-act="add-solid">${I.bowl}<span>Прикорм</span></button>
      <button class="q growth" data-act="add-growth">${I.chart}<span>Рост и вес</span></button>
    </section>`;
    out += `<section class="stats">
      <div class="stat feed"><small>Бутылочек сегодня</small><b>${bottles.length}</b><span>${ml ? ml + ' мл всего' : 'пока не было'}</span></div>
      <div class="stat"><small>Последнее кормление</small><b>${lastFeed ? hhmm(lastFeed.start) : '—'}</b><span>${lastFeed ? ago(lastFeed.start) : '&nbsp;'}</span></div>
    </section>`;
    if (S.profile.birth) {
      const next = schedule().filter(v => !v.done).sort((a, b) => a.due - b.due)[0];
      if (next) out += `<section class="list"><button class="row" data-tab="vacc"><span class="dot vacc">${I.shield}</span><span class="row-main"><b>${esc(next.n)}</b><small>Ближайшая прививка · ${fmtLong.format(next.due)}</small></span>${next.st[1] ? `<span class="pill ${next.st[0]}">${next.st[1]}</span>` : ''}</button></section>`;
    }
    const other = ev.filter(e => e.type !== 'sleep');
    if (other.length) out += `<section class="day"><h3>Кормления и прикорм сегодня</h3><div class="list">${[...other].sort((a, b) => b.start - a.start).map(evRow).join('')}</div></section>`;
    return out;
  },

  sleep() {
    const D = sleepDay, isToday = D === todayStr();
    const label = D === todayStr() ? 'Сегодня' : D === dateStr(addDays(Date.now(), -1)) ? 'Вчера' : fmtDay.format(parseDate(D));
    const { night, day } = sleepsFor(D);
    let out = `<section class="card sleep-card">${sleepButton()}</section>`;
    out += `<section class="card"><div class="daynav"><button class="icon-btn" data-day="-1" aria-label="Предыдущий день">${I.chevL}</button>
      <label><b>${label}</b><input type="date" id="sleep-date" value="${D}" max="${todayStr()}"></label>
      <button class="icon-btn" data-day="1" aria-label="Следующий день" ${isToday ? 'disabled' : ''}>${I.chevR}</button></div>
      <div class="sleep-sum"><div class="night"><small>Ночью</small><b>${night.length ? durS(sleepDur(night)) : '—'}</b></div><div class="day"><small>Днём</small><b>${day.length ? durS(sleepDur(day)) : '—'}</b></div><div><small>Всего</small><b>${durS(sleepDur(night) + sleepDur(day))}</b></div></div>
      ${sleepBlocks(D)}
      <p class="hint" style="margin:12px 0 0">Нажмите на плашку, чтобы изменить время, тип сна или удалить запись. Стрелками или по дате можно открыть любой прошлый день и дописать сон.</p></section>`;
    const days = lastDays(7).map(t => { const s = sleepsFor(dateStr(t)); const nv = sleepDur(s.night), dv = sleepDur(s.day); return { t, total: nv + dv, parts: [{ v: dv, c: 'day' }, { v: nv, c: 'night' }] }; });
    const withData = days.filter(d => d.total && d.t !== startOfDay(Date.now()));
    out += `<section class="card"><h3>Сон за неделю</h3><p class="hint">${withData.length ? 'В среднем ' + dur(sum(withData, d => d.total) / withData.length) + ' в сутки · ' : ''}<span class="lg night"></span> ночь <span class="lg day"></span> день</p>${bars(days, v => (v / HOUR).toFixed(1).replace('.', ','), 'stack')}</section>`;
    out += history(S.events.filter(e => e.type === 'sleep'), 'Пока нет записей о сне');
    return out;
  },

  feed() {
    const now = Date.now(), t0 = startOfDay(now);
    const today = S.events.filter(e => e.start >= t0 && e.type === 'bottle');
    const last = latest(S.events.filter(isFeed));
    let out = `<section class="card feed-card"><div class="stats" style="grid-template-columns:1fr 1fr 1fr">
        <div class="stat feed"><small>Сегодня</small><b>${sum(today, e => +e.ml)}</b><span>мл</span></div>
        <div class="stat feed"><small>Бутылочек</small><b>${today.length}</b><span>за день</span></div>
        <div class="stat"><small>Последняя</small><b>${last ? hhmm(last.start) : '—'}</b><span>${last ? ago(last.start) : '&nbsp;'}</span></div></div>
      <button class="btn primary big-add" data-act="add-bottle">${I.plus} Записать бутылочку</button></section>`;
    const days = lastDays(7).map(t => ({ t, total: sum(S.events.filter(e => e.type === 'bottle' && startOfDay(e.start) === t), e => +e.ml) }));
    out += `<section class="card"><h3>Смесь за неделю, мл</h3>${bars(days, v => v, 'feedbars')}</section>`;
    out += history(S.events.filter(isFeed), 'Пока нет записей о кормлениях');
    return out;
  },

  solid() {
    const prods = allProducts();
    const states = prods.map(p => ({ p, s: productState(p) }));
    const done = states.filter(x => x.s.done).length;
    const now = states.filter(x => x.s.start && !x.s.done);
    let out = `<section class="card"><h3>Введено ${done} из ${prods.length}</h3><div class="progress"><i style="width:${done / prods.length * 100}%"></i></div>
      ${now.length ? `<p class="hint" style="margin:12px 0 8px">Сейчас вводим:</p><div class="chips">${now.map(x => `<button class="chip" data-sp="${x.p.key}">${esc(x.p.name)}<small>&nbsp;· день ${daysSince(x.s.start)}</small></button>`).join('')}</div>` : ''}
      <div class="actions-row" style="margin-top:12px"><button class="btn primary" data-act="add-solid">${I.plus} Записать прикорм</button></div></section>`;
    out += `<details class="card tips"><summary>Как вводить новый продукт</summary><ul>
      <li>Первый прикорм — обычно в 4–6 месяцев, когда малыш готов: уверенно держит голову, интересуется едой, не выталкивает ложку языком.</li>
      <li>Один новый продукт за раз: начните с ½–1 чайной ложки и за 5–7 дней доведите до нужного объёма.</li>
      <li>Новое давайте в первой половине дня, чтобы успеть заметить реакцию.</li>
      <li>Сначала однокомпонентные пюре и каши, потом смешивайте уже знакомые продукты.</li>
      <li>Не вводите новое во время болезни и в дни прививок.</li>
      <li>Когда продукт съедается в нужном объёме без реакции — ставьте галочку «введён».</li></ul>
      <p class="hint">Порядок и сроки — ориентир по рекомендациям российских педиатров. Обсудите схему с вашим педиатром.</p></details>`;
    for (const gr of SOLID_GROUPS) {
      const items = prods.filter(p => p.g === gr.g);
      const dn = items.filter(p => productState(p).done).length;
      out += `<section class="vgroup"><h3>${gr.title} · ${gr.from}<small>${dn}/${items.length}</small></h3>${gr.tip ? `<p class="note" style="margin:-4px 0 8px">${gr.tip}</p>` : ''}<div class="list">${items.map(productRow).join('')}</div></section>`;
    }
    const own = prods.filter(p => p.custom && !SOLID_GROUPS.some(gr => gr.g === p.g));
    out += `<section class="vgroup"><h3>Свои продукты</h3>${own.length ? `<div class="list">${own.map(productRow).join('')}</div>` : ''}
      <div class="actions-row" style="margin-top:10px"><button class="btn soft" data-act="add-product">${I.plus} Добавить продукт</button></div></section>`;
    out += history(S.events.filter(e => e.type === 'solid'), 'Пока нет записей о прикорме');
    return out;
  },

  growth() {
    const g = [...S.growth].sort((a, b) => a.date.localeCompare(b.date));
    const M = { weight: ['Вес', 'кг', 2], height: ['Рост', 'см', 1], head: ['Голова', 'см', 1] };
    const lastOf = k => { const l = g.filter(x => x[k]); return [l[l.length - 1], l[l.length - 2]]; };
    const num = (v, d) => (+v).toFixed(d).replace('.', ',');
    let h = `<section class="stats" style="grid-template-columns:repeat(3,1fr)">${Object.entries(M).map(([k, [l, u, d]]) => {
      const [a, b] = lastOf(k);
      const delta = a && b ? a[k] - b[k] : 0;
      const dTxt = k === 'weight' ? Math.round(delta * 1000) + ' г' : num(delta, 1) + ' см';
      return `<div class="stat growth"><small>${l}</small><b>${a ? num(a[k], d) : '—'}</b><span>${a ? u : '&nbsp;'}${delta ? ` <span class="delta">${delta > 0 ? '+' : ''}${dTxt}</span>` : ''}</span></div>`;
    }).join('')}</section>`;
    h += `<div class="actions-row"><button class="btn soft growth" data-act="add-growth">${I.plus} Новый замер</button></div>`;
    h += `<section class="card"><div class="metric-tabs">${Object.entries(M).map(([k, [l]]) => `<button data-metric="${k}" class="${metric === k ? 'on' : ''}">${l}</button>`).join('')}</div>${growthChart(g, metric, M[metric])}</section>`;
    if (g.length) h += `<section class="day"><h3>Все замеры</h3><div class="list">${[...g].reverse().map(x => `<button class="row" data-gr="${x.id}"><span class="dot growth">${I.chart}</span><span class="row-main"><b>${[x.weight ? num(x.weight, 2) + ' кг' : '', x.height ? num(x.height, 1) + ' см' : '', x.head ? 'голова ' + num(x.head, 1) + ' см' : ''].filter(Boolean).join(' · ')}</b><small>${fmtLong.format(parseDate(x.date))}${S.profile.birth ? ' · ' + ageAt(x.date) : ''}${x.note ? ' · ' + esc(x.note) : ''}</small></span></button>`).join('')}</div></section>`;
    else h += `<p class="empty">Добавьте первый замер — например, данные из роддома или с приёма педиатра.</p>`;
    return h;
  },

  vacc() {
    if (!S.profile.birth) return `<section class="card hello"><h3>Нужна дата рождения</h3><p>По ней приложение рассчитает сроки прививок по национальному календарю.</p><button class="btn primary" data-act="settings">Указать дату рождения</button></section>`;
    const list = schedule();
    const done = list.filter(v => v.done).length;
    const pending = list.filter(v => !v.done && v.due <= startOfDay(Date.now())).length;
    let h = `<section class="card"><h3>Прививки · ${done} из ${list.length}</h3><div class="progress"><i style="width:${done / list.length * 100}%"></i></div>
      ${pending ? `<p class="hint" style="margin:12px 0 0">${pending} ${pl(pending, ['прививка', 'прививки', 'прививок'])} по срокам уже ${pl(pending, ['должна', 'должны', 'должны'])} быть сделаны. Если они сделаны — отметьте их.</p><div class="actions-row" style="margin-top:10px"><button class="btn small" data-act="mark-past">Отметить прошедшие как сделанные</button></div>` : ''}</section>`;
    const groups = new Map();
    list.forEach(v => { if (!groups.has(v.when)) groups.set(v.when, []); groups.get(v.when).push(v); });
    for (const [when, items] of groups) {
      h += `<section class="vgroup"><h3>${when} · ${fmtShort.format(items[0].due)}</h3><div class="list">${items.map(v => `<button class="row vrow ${v.done ? 'done' : ''}" data-vk="${v.k}"><span class="check">${v.done ? I.check : ''}</span><span class="row-main"><b>${esc(v.n)}</b><small>${v.done ? 'Сделано ' + fmtLong.format(parseDate(v.done.date)) + (v.done.note ? ' · ' + esc(v.done.note) : '') : 'По календарю — ' + fmtLong.format(v.due)}</small></span>${v.st[1] && !v.done ? `<span class="pill ${v.st[0]}">${v.st[1]}</span>` : ''}</button>`).join('')}</div></section>`;
    }
    const custom = [...S.vacc.custom].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    h += `<section class="vgroup"><h3>Дополнительно и визиты к врачам</h3>${custom.length ? `<div class="list">${custom.map(c => `<button class="row vrow ${c.done ? 'done' : ''}" data-ck="${c.id}"><span class="check">${c.done ? I.check : ''}</span><span class="row-main"><b>${esc(c.name)}</b><small>${c.date ? fmtLong.format(parseDate(c.date)) : 'без даты'}${c.note ? ' · ' + esc(c.note) : ''}</small></span></button>`).join('')}</div>` : ''}
      <div class="actions-row" style="margin-top:10px"><button class="btn soft" data-act="add-custom">${I.plus} Добавить прививку или визит</button></div></section>`;
    h += `<p class="note">Сроки рассчитаны по национальному календарю профилактических прививок РФ. Схема может отличаться (например, для групп риска или при сдвиге графика) — точные даты согласуйте с педиатром.</p>`;
    return h;
  },
};
// Подсказка «Установить на экран Домой» — только в Safari на iPhone/iPad, пока приложение не установлено
function installHint() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  let hidden = false; try { hidden = localStorage.getItem('malysh.hideInstall') === '1'; } catch (e) { /* */ }
  if (!ios || standalone || hidden) return '';
  return `<section class="card hello"><h3>Установите на экран «Домой»</h3>
    <p>Нажмите в Safari кнопку «Поделиться» <b>⎋</b> → «На экран „Домой“». Приложение откроется во весь экран и будет работать без интернета.</p>
    <p class="muted" style="font-size:14px">Важно: на iPhone записи из Safari и из установленного приложения хранятся отдельно — вносите их уже в установленном.</p>
    <button class="btn" data-x="hide-install">Понятно</button></section>`;
}
function ageAt(date) {
  const b = parseDate(S.profile.birth), d = parseDate(date);
  const days = Math.round((d - b) / DAY);
  if (days < 0) return '';
  if (days < 31) return days + ' дн.';
  let m = (d.getFullYear() - b.getFullYear()) * 12 + d.getMonth() - b.getMonth(); if (d.getDate() < b.getDate()) m--;
  return m < 24 ? m + ' мес.' : Math.floor(m / 12) + ' ' + pl(Math.floor(m / 12), ['год', 'года', 'лет']);
}
function growthChart(g, k, [label, unit, dec]) {
  const pts = g.filter(x => x[k]).map(x => ({ t: parseDate(x.date).getTime(), v: +x[k] }));
  if (!pts.length) return `<p class="empty">Нет данных: ${label.toLowerCase()}</p>`;
  const W = 320, H = 170, L = 38, R = 12, T = 12, B = 26;
  let t0 = pts[0].t, t1 = pts[pts.length - 1].t; if (t1 === t0) { t0 -= DAY * 15; t1 += DAY * 15; }
  let v0 = Math.min(...pts.map(p => p.v)), v1 = Math.max(...pts.map(p => p.v));
  const padV = (v1 - v0) * 0.15 || v1 * 0.05 || 1; v0 -= padV; v1 += padV;
  const x = t => L + (t - t0) / (t1 - t0) * (W - L - R);
  const y = v => T + (1 - (v - v0) / (v1 - v0)) * (H - T - B);
  const fmt = v => v.toFixed(dec).replace('.', ',');
  const ticks = [v0 + padV, (v0 + v1) / 2, v1 - padV].filter((v, i, a) => i === 0 || Math.abs(v - a[i - 1]) > 1e-9);
  const xl = t => S.profile.birth ? ageAt(dateStr(t)) || fmtShort.format(t) : fmtShort.format(t);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="График: ${label}">
    ${ticks.map(v => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join('')}
    <polyline class="line" points="${pts.map(p => x(p.t) + ',' + y(p.v)).join(' ')}"/>
    ${pts.map(p => `<circle class="pt" cx="${x(p.t)}" cy="${y(p.v)}" r="4"/>`).join('')}
    <text x="${x(pts[0].t)}" y="${H - 6}" text-anchor="${pts.length > 1 ? 'start' : 'middle'}">${xl(pts[0].t)}</text>
    ${pts.length > 1 ? `<text x="${x(pts[pts.length - 1].t)}" y="${H - 6}" text-anchor="end">${xl(pts[pts.length - 1].t)}</text>` : ''}
  </svg><p class="hint" style="margin:6px 0 0">${label}, ${unit}</p>`;
}

/* ---------------- Шторка-форма ---------------- */
const dlg = $('#sheet');
let sheetDel = null;
function openSheet(title, body, onSubmit, opts = {}) {
  dlg.innerHTML = `<form class="sheet" novalidate><header><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Закрыть">${I.x}</button></header>
    <div class="sheet-body">${body}</div>
    ${onSubmit ? `<footer>${opts.del ? `<button type="button" class="btn ghost danger" data-del>${opts.delLabel || 'Удалить'}</button>` : ''}<button class="btn primary">${opts.ok || 'Сохранить'}</button></footer>` : ''}</form>`;
  sheetDel = opts.del || null;
  const f = dlg.querySelector('form');
  f.onsubmit = e => {
    e.preventDefault();
    if (!f.checkValidity()) { f.reportValidity(); return; }
    const fd = Object.fromEntries(new FormData(f));
    if (onSubmit(fd, f) === false) return;
    dlg.close(); save(); render();
  };
  if (!dlg.open) dlg.showModal();
  const af = f.querySelector('[autofocus]'); if (af && !matchMedia('(pointer:coarse)').matches) af.focus();
}
dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
dlg.addEventListener('close', () => { if (renderPending) { renderPending = false; render(); } });

const field = (label, input, hint = '') => `<label class="field"><span>${label}</span>${input}${hint ? `<small>${hint}</small>` : ''}</label>`;
const group = (label, html) => `<div class="field"><span>${label}</span>${html}</div>`;
const seg = (name, opts, val) => `<div class="seg">${opts.map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}" ${v === val ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>`;
const dtl = ts => { const d = new Date(ts); return `${dateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const parseDtl = s => (s ? new Date(s).getTime() : NaN);
const noteField = v => field('Заметка', `<input name="note" value="${esc(v)}" placeholder="необязательно" maxlength="200">`);

// Ищем запись заново по id: пока форма была открыта, данные могли обновиться с другого телефона
function upsertIn(list, old, data) {
  const cur = old && list.find(x => x.id === old.id);
  if (cur) Object.assign(cur, data);
  else list.push({ ...(old || {}), id: (old && old.id) || uid(), ...data });
}
const upsertEv = (old, data) => upsertIn(S.events, old, data);
function delEv(id) {
  if (!confirm('Удалить эту запись?')) return false;
  S.events = S.events.filter(e => e.id !== id);
}

function bottleForm(e) {
  const isNew = !e;
  const lastB = latest(S.events.filter(x => x.type === 'bottle'));
  const v = e || { start: Date.now(), ml: '', kind: lastB ? lastB.kind : 'formula' };
  openSheet('Бутылочка',
    field('Время', `<input type="datetime-local" name="start" value="${dtl(v.start)}" required>`) +
    field('Объём, мл', `<input type="number" name="ml" inputmode="numeric" min="1" max="500" step="1" value="${esc(v.ml)}" required autofocus>`) +
    `<div class="chips">${[30, 60, 90, 120, 150, 180, 210].map(n => `<button type="button" class="chip" data-ml="${n}">${n}</button>`).join('')}</div>` +
    group('Что в бутылочке', seg('kind', [['formula', 'Смесь'], ['breastmilk', 'Сцеженное молоко']], v.kind || 'formula')) +
    noteField(v.note),
    fd => {
      const start = parseDtl(fd.start); if (!start) return false;
      upsertEv(e, { type: 'bottle', start, end: start, ml: Math.round(+fd.ml) || 0, kind: fd.kind, note: fd.note.trim() });
      toast(isNew ? 'Записано' : 'Изменения сохранены');
    }, { del: !isNew && (() => delEv(e.id)) });
}
function solidForm(e, preset = {}) {
  const isNew = !e, v = e || { start: Date.now(), food: preset.food || '' };
  const names = allProducts().map(p => p.name);
  openSheet('Прикорм',
    field('Время', `<input type="datetime-local" name="start" value="${dtl(v.start)}" required>`) +
    field('Продукт', `<input name="food" list="foods" value="${esc(v.food)}" placeholder="например, кабачок" required maxlength="60" ${v.food ? '' : 'autofocus'}><datalist id="foods">${names.map(f => `<option value="${esc(f)}">`).join('')}</datalist>`, 'Выберите из списка или впишите свой — он появится во вкладке «Прикорм»') +
    field('Сколько съел, г', `<input type="number" name="grams" inputmode="numeric" min="0" max="500" value="${esc(v.grams)}" placeholder="необязательно" ${v.food ? 'autofocus' : ''}>`) +
    `<div class="chips">${[5, 10, 20, 30, 50, 80, 100].map(n => `<button type="button" class="chip" data-g="${n}">${n} г</button>`).join('')}</div>` +
    group('Реакция', seg('reaction', Object.entries(REACTIONS), v.reaction || '')) +
    noteField(v.note),
    fd => {
      const start = parseDtl(fd.start); if (!start) return false;
      const food = fd.food.trim();
      let p = findProduct(food);
      if (!p && food) { p = { key: 'c_' + uid(), name: food, g: 'own' }; S.solidsCustom.push(p); }
      upsertEv(e, { type: 'solid', start, end: start, food, product: p ? p.key : '', grams: fd.grams ? Math.round(+fd.grams) : '', reaction: fd.reaction || '', note: fd.note.trim() });
      if (p) { const st = S.solids[p.key] || {}; if (!st.start || st.start > dateStr(start)) S.solids[p.key] = { ...st, start: dateStr(start) }; }
      toast(isNew ? 'Записано' : 'Изменения сохранены');
    }, { del: !isNew && (() => delEv(e.id)) });
}
function productForm(key) {
  const p = allProducts().find(x => x.key === key); if (!p) return;
  const s = productState(p), gr = SOLID_GROUPS.find(g => g.g === p.g), max = todayStr();
  openSheet(p.name,
    `<p class="muted">${gr ? gr.title + ' · ' + gr.from : 'Свой продукт'}${s.servings.length ? ' · порций: ' + s.servings.length : ''}</p>` +
    `<div class="two">${field('Начали вводить', `<input type="date" name="start" value="${s.start}" max="${max}">`)}${field('Введён полностью', `<input type="date" name="done" value="${s.done}" max="${max}">`)}</div>` +
    `<div class="actions-row"><button type="button" class="btn small" data-fill="start">Начали сегодня</button><button type="button" class="btn small" data-fill="done">${I.check} Введён сегодня</button></div>` +
    field('Заметка', `<input name="note" value="${esc(s.note)}" placeholder="как ест, была ли реакция…" maxlength="200">`) +
    (s.servings.length ? group('Последние порции', `<div class="list">${[...s.servings].reverse().slice(0, 7).map(e => evRow(e, true)).join('')}</div>`) : '') +
    `<button type="button" class="btn soft solid" data-act="add-serving" data-key="${key}">${I.plus} Записать порцию</button>`,
    fd => {
      const st = { start: fd.start, done: fd.done, note: fd.note.trim() };
      if (st.done && !st.start) st.start = st.done;
      if (st.done && st.start > st.done) { toast('Дата «введён» раньше начала'); return false; }
      if (!st.start && !st.done && !st.note) delete S.solids[key]; else S.solids[key] = st;
      toast('Сохранено');
    }, { del: p.custom && (() => { if (!confirm('Убрать продукт из списка? Записи о порциях останутся.')) return false; S.solidsCustom = S.solidsCustom.filter(c => c.key !== key); delete S.solids[key]; }), delLabel: 'Убрать' });
}
function addProductForm() {
  openSheet('Новый продукт',
    field('Название', `<input name="name" required maxlength="60" placeholder="например, кролик с кабачком" autofocus>`) +
    field('Группа', `<select name="g"><option value="own">Свои продукты</option>${SOLID_GROUPS.map(g => `<option value="${g.g}">${g.title}</option>`).join('')}</select>`),
    fd => {
      const name = fd.name.trim(); if (!name) return false;
      if (findProduct(name)) { toast('Такой продукт уже есть в списке'); return false; }
      S.solidsCustom.push({ key: 'c_' + uid(), name, g: fd.g });
      toast('Продукт добавлен');
    });
}
function toggleProduct(key) {
  const p = allProducts().find(x => x.key === key); if (!p) return;
  const s = productState(p), st = { ...(S.solids[key] || {}) };
  if (s.done) { st.done = ''; st.start = st.start || s.start; toast('Отметка снята'); }
  else { st.done = todayStr(); st.start = st.start || s.start || todayStr(); toast(p.name + ' — введён ✓'); }
  S.solids[key] = st; save(); render();
}
function sleepForm(e, preset = {}) {
  const isNew = !e;
  let v = e;
  if (!v) {
    const D = preset.d || todayStr(), kind = preset.kind || autoKind(Date.now()), now = Date.now();
    if (kind === 'night') {
      const s = parseDate(D); s.setDate(s.getDate() - 1); s.setHours(21, 0, 0, 0);
      const en = parseDate(D); en.setHours(7, 0, 0, 0);
      v = { start: Math.min(s.getTime(), now - HOUR), end: Math.min(en.getTime(), now), kind };
    } else {
      const s = parseDate(D); s.setHours(13, 0, 0, 0);
      let st = s.getTime(), en = st + 90 * MIN;
      if (en > now) { en = now; st = now - HOUR; }
      v = { start: st, end: en, kind };
    }
  }
  openSheet(isNew ? (v.kind === 'night' ? 'Ночной сон' : 'Дневной сон') : 'Сон',
    group('Тип сна', seg('kind', [['day', 'Дневной'], ['night', 'Ночной']], sleepKind(v))) +
    field('Уснул', `<input type="datetime-local" name="start" value="${dtl(v.start)}" required>`) +
    field('Проснулся', `<input type="datetime-local" name="end" value="${dtl(v.end)}" required>`) +
    noteField(v.note),
    fd => {
      const start = parseDtl(fd.start), end = parseDtl(fd.end);
      if (!start || !end) return false;
      if (end <= start) { toast('Время пробуждения должно быть позже'); return false; }
      if (end - start > 16 * HOUR) { toast('Сон дольше 16 часов — проверьте даты'); return false; }
      upsertEv(e, { type: 'sleep', start, end, kind: fd.kind, note: fd.note.trim() });
      toast(isNew ? 'Сон записан' : 'Изменения сохранены');
    }, { del: !isNew && (() => delEv(e.id)) });
}
function growthForm(x) {
  const isNew = !x, v = x || { date: todayStr() };
  openSheet('Замер',
    field('Дата', `<input type="date" name="date" value="${esc(v.date)}" required>`) +
    `<div class="three">${field('Вес, кг', `<input type="number" name="weight" inputmode="decimal" step="0.001" min="0.3" max="40" value="${esc(v.weight)}" placeholder="4,25" autofocus>`)}${field('Рост, см', `<input type="number" name="height" inputmode="decimal" step="0.1" min="20" max="150" value="${esc(v.height)}">`)}${field('Голова, см', `<input type="number" name="head" inputmode="decimal" step="0.1" min="20" max="70" value="${esc(v.head)}">`)}</div>` +
    noteField(v.note),
    fd => {
      const n = s => (s === '' ? '' : +String(s).replace(',', '.'));
      const data = { date: fd.date, weight: n(fd.weight), height: n(fd.height), head: n(fd.head), note: fd.note.trim() };
      if (!data.weight && !data.height && !data.head) { toast('Заполните хотя бы одно значение'); return false; }
      upsertIn(S.growth, x, data);
      toast('Замер сохранён');
    }, { del: !isNew && (() => { if (!confirm('Удалить замер?')) return false; S.growth = S.growth.filter(g => g.id !== x.id); }) });
}
function vaccForm(k) {
  const v = schedule().find(x => x.k === k); if (!v) return;
  const d = v.done;
  openSheet(v.n,
    `<p class="muted">${v.when} · по календарю ${fmtLong.format(v.due)}</p>` +
    field('Дата прививки', `<input type="date" name="date" value="${d ? d.date : (v.due < Date.now() ? todayStr() : dateStr(v.due))}" required>`) +
    field('Заметка', `<input name="note" value="${esc(d && d.note)}" placeholder="препарат, реакция…" maxlength="200">`),
    fd => { S.vacc.done[k] = { date: fd.date, note: fd.note.trim() }; toast('Отмечено'); },
    { ok: d ? 'Сохранить' : 'Отметить сделанной', del: d && (() => { delete S.vacc.done[k]; }), delLabel: 'Снять отметку' });
}
function customForm(c) {
  const isNew = !c, v = c || { date: todayStr(), done: false };
  openSheet(isNew ? 'Прививка или визит' : v.name,
    field('Название', `<input name="name" value="${esc(v.name)}" placeholder="Невролог, прививка от гриппа…" required maxlength="80" autofocus>`) +
    field('Дата', `<input type="date" name="date" value="${esc(v.date)}">`) +
    `<label class="checkline"><input type="checkbox" name="done" ${v.done ? 'checked' : ''}> Уже сделано / посетили</label>` +
    noteField(v.note),
    fd => {
      const data = { name: fd.name.trim(), date: fd.date, done: !!fd.done, note: fd.note.trim() };
      upsertIn(S.vacc.custom, c, data);
    }, { del: !isNew && (() => { if (!confirm('Удалить запись?')) return false; S.vacc.custom = S.vacc.custom.filter(x => x.id !== c.id); }) });
}
function settingsForm() {
  const p = S.profile;
  openSheet('Настройки',
    field('Имя малыша', `<input name="name" value="${esc(p.name)}" placeholder="Например, Миша" maxlength="40">`) +
    field('Дата рождения', `<input type="date" name="birth" value="${esc(p.birth)}" max="${todayStr()}">`) +
    group('Тема', seg('theme', [['auto', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']], p.theme || 'auto')) +
    syncBlock() +
    `<div class="settings-block"><h4>Обновление</h4>
      <p>Установлена версия ${APP_VERSION}. ${update ? `<b style="color:var(--ok)">Доступна ${esc(update.version)}.</b>` : 'Приложение само проверяет обновления при запуске.'}</p>
      ${update ? `<button type="button" class="btn ok" data-x="whatsnew">${I.refresh} Обновить до ${esc(update.version)}</button>` : `<button type="button" class="btn" data-x="check">${I.refresh} Проверить обновления</button>`}
    </div>
    <div class="settings-block"><h4>Данные</h4>
      <p>Записи хранятся только на этом телефоне. Время от времени сохраняйте резервную копию — она пригодится при смене телефона.</p>
      <button type="button" class="btn" data-x="export">Сохранить резервную копию</button>
      <button type="button" class="btn" data-x="import">Восстановить из копии</button>
      <button type="button" class="btn ghost danger" data-x="clear">Удалить все данные</button>
    </div>`,
    fd => { Object.assign(S.profile, { name: fd.name.trim(), birth: fd.birth, theme: fd.theme }); toast('Сохранено'); });
}

function syncBlock() {
  const sy = window.Sync;
  const title = '<h4>Синхронизация с другим телефоном</h4>';
  if (!sy || !sy.configured) return `<div class="settings-block">${title}<p>Пока не настроена: нужно подключить бесплатное облако Firebase (инструкция в README репозитория). После этого здесь появится кнопка «Создать семью».</p></div>`;
  if (!sy.family) return `<div class="settings-block">${title}
    <p>Мама и папа будут видеть и редактировать одни и те же записи. Создайте семью на одном телефоне, а на втором введите её код.</p>
    <button type="button" class="btn primary" data-x="sync-create">Создать семью</button>
    <label class="field"><span>Код семьи с другого телефона</span><input name="joincode" placeholder="XXXX-XXXX-XXXX-XXXX" autocapitalize="characters" autocomplete="off" spellcheck="false"></label>
    <button type="button" class="btn" data-x="sync-join">Присоединиться</button></div>`;
  return `<div class="settings-block">${title}
    <p>Статус: <b id="sync-status">${syncLabel()}</b></p>
    <label class="field"><span>Код семьи — введите его на втором телефоне</span><input readonly value="${esc(sy.family)}" class="code" onclick="this.select()"></label>
    <button type="button" class="btn" data-x="sync-share">Отправить код</button>
    <button type="button" class="btn ghost danger" data-x="sync-off">Отключить на этом телефоне</button></div>`;
}

// Сохраняем имя/дату/тему, введённые в настройках, перед перерисовкой шторки
function keepSettingsFields() {
  const f = dlg.querySelector('form'); if (!f || !f.elements.birth) return;
  const fd = Object.fromEntries(new FormData(f));
  Object.assign(S.profile, { name: (fd.name || '').trim(), birth: fd.birth || '', theme: fd.theme || S.profile.theme });
  save();
}

/* ---------------- Резервная копия ---------------- */
async function exportData() {
  const json = JSON.stringify({ app: 'malysh', version: APP_VERSION, exported: new Date().toISOString(), data: S }, null, 2);
  const name = `malysh-backup-${todayStr()}.json`;
  // На iPhone удобнее через «Поделиться» → «Сохранить в Файлы»
  try {
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Резервная копия «Малыш»' }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Файл копии сохранён');
}
function importData() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.onchange = async () => {
    try {
      const j = JSON.parse(await inp.files[0].text());
      const d = j.data || j;
      if (!Array.isArray(d.events)) throw new Error('bad');
      if (!confirm('Заменить текущие данные данными из копии?')) return;
      S = normalize(d); save(); dlg.close(); render(); toast('Данные восстановлены');
    } catch (e) { toast('Это не похоже на файл копии'); }
  };
  inp.click();
}

/* ---------------- Действия ---------------- */
function sleepToggle() {
  const now = Date.now();
  if (S.timers.sleep) {
    const t = S.timers.sleep; delete S.timers.sleep;
    if (now - t.start < MIN) toast('Меньше минуты — не сохранено');
    else { S.events.push({ id: uid(), type: 'sleep', start: t.start, end: now, kind: t.kind || autoKind(t.start) }); toast('Сон записан · ' + dur(now - t.start)); }
  } else { S.timers.sleep = { start: now, kind: autoKind(now) }; toast('Сладких снов 🌙'); }
  save(); render();
}
function markPast() {
  const items = schedule().filter(v => !v.done && v.due <= startOfDay(Date.now()));
  if (!items.length || !confirm(`Отметить ${items.length} ${pl(items.length, ['прививку', 'прививки', 'прививок'])} как сделанные (датой по календарю)? Даты потом можно поправить.`)) return;
  items.forEach(v => { S.vacc.done[v.k] = { date: dateStr(v.due), note: '' }; });
  save(); render(); toast('Готово');
}

const ACTIONS = {
  'sleep-toggle': sleepToggle,
  'sleep-cancel': () => { if (confirm('Отменить сон без сохранения?')) { delete S.timers.sleep; save(); render(); } },
  'add-sleep': t => sleepForm(null, { d: t.dataset.d, kind: t.dataset.kind }),
  'add-bottle': () => bottleForm(), 'add-solid': () => solidForm(), 'add-growth': () => growthForm(),
  'add-serving': t => { const p = allProducts().find(x => x.key === t.dataset.key); solidForm(null, { food: p ? p.name : '' }); },
  'add-product': () => addProductForm(),
  'add-custom': () => customForm(), 'mark-past': markPast,
  settings: settingsForm, whatsnew: whatsNew,
};
const FORMS = { bottle: bottleForm, solid: solidForm, sleep: sleepForm };

document.addEventListener('click', e => {
  const t = e.target.closest('[data-act],[data-ev],[data-gr],[data-vk],[data-ck],[data-sp],[data-spc],[data-day],[data-metric],[data-tab],[data-close],[data-del],[data-ml],[data-g],[data-fill],[data-x]');
  if (!t) return;
  const d = t.dataset;
  if (d.act && ACTIONS[d.act]) return ACTIONS[d.act](t);
  if (d.spc) return toggleProduct(d.spc);
  if (d.sp) return productForm(d.sp);
  if (d.day) { const n = dateStr(addDays(parseDate(sleepDay).getTime(), +d.day)); sleepDay = n > todayStr() ? todayStr() : n; return render(); }
  if (d.fill) { const f = dlg.querySelector(`[name=${d.fill}]`); if (f) f.value = todayStr(); if (d.fill === 'done') { const st = dlg.querySelector('[name=start]'); if (st && !st.value) st.value = todayStr(); } return; }
  if (d.g) { const f = dlg.querySelector('[name=grams]'); if (f) f.value = d.g; return; }
  if (d.ev) { const ev = S.events.find(x => x.id === d.ev); return ev && FORMS[ev.type] && FORMS[ev.type](ev); }
  if (d.gr) { const g = S.growth.find(x => x.id === d.gr); return g && growthForm(g); }
  if (d.vk) return vaccForm(d.vk);
  if (d.ck) { const c = S.vacc.custom.find(x => x.id === d.ck); return c && customForm(c); }
  if (d.metric) { metric = d.metric; return render(); }
  if (d.tab) { location.hash = d.tab; return; }
  if ('close' in d) return dlg.close();
  if ('del' in d) { if (sheetDel && sheetDel() !== false) { dlg.close(); save(); render(); } return; }
  if (d.ml) { const f = dlg.querySelector('[name=ml]'); if (f) f.value = d.ml; return; }
  if (d.x === 'export') return exportData();
  if (d.x === 'import') return importData();
  if (d.x === 'check') return checkUpdate(true);
  if (d.x === 'whatsnew') return whatsNew();
  if (d.x && d.x.startsWith('sync-')) keepSettingsFields();
  if (d.x === 'sync-create') return window.Sync && window.Sync.create().then(() => settingsForm());
  if (d.x === 'sync-join') {
    const code = (dlg.querySelector('[name=joincode]') || {}).value || '';
    return window.Sync && window.Sync.join(code).then(ok => { if (ok) settingsForm(); });
  }
  if (d.x === 'sync-share') return window.Sync && window.Sync.share();
  if (d.x === 'sync-off') {
    if (confirm('Отключить синхронизацию на этом телефоне? Записи останутся, но перестанут обновляться.')) { window.Sync.leave(); settingsForm(); }
    return;
  }
  if (d.x === 'hide-install') { try { localStorage.setItem('malysh.hideInstall', '1'); } catch (er) { /* */ } return render(); }
  if (d.x === 'clear') {
    const shared = window.Sync && window.Sync.family;
    if (confirm('Удалить ВСЕ записи о малыше? Это нельзя отменить.' + (shared ? ' Они удалятся и на втором телефоне.' : '')) && confirm('Точно удалить? Рекомендуем сначала сохранить резервную копию.')) {
      S = defaults(); save(); dlg.close(); render(); toast('Все данные удалены');
    }
  }
});

document.addEventListener('change', e => {
  if (e.target.id === 'sleep-date' && e.target.value) { sleepDay = e.target.value > todayStr() ? todayStr() : e.target.value; render(); }
});

/* ---------------- Уведомления ---------------- */
let toastT;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2400);
}

/* ---------------- Запуск ---------------- */
window.addEventListener('hashchange', () => { tab = location.hash.slice(1) || 'today'; if (tab === 'sleep') sleepDay = todayStr(); render(); window.scrollTo(0, 0); });
window.addEventListener('storage', e => { if (e.key === KEY) { S = load(); if (!dlg.open) render(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { S = load(); if (!dlg.open) render(); checkUpdate(false); } });
setInterval(tick, 1000);
setInterval(() => { if (!dlg.open) render(); }, 30000);
render();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (location.protocol !== 'file:') checkUpdate(false);
