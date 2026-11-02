'use strict';
/*
 * Малыш — дневник мамы.
 * Все данные хранятся только на этом устройстве (localStorage).
 * Обновления: приложение сверяет APP_VERSION с файлом version.json на сайте.
 */

const APP_VERSION = '1.11.0';
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
  nightCache = null; gapCache = null;
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('Не получилось сохранить данные'); }
  if (window.Sync) window.Sync.push();
}

/* ---------------- Синхронизация: данные как набор отдельных записей ---------------- */
// Каждая запись — отдельный документ в облаке, поэтому мама и папа могут
// одновременно добавлять записи, и ничего не перезапишется.
function flatten(st = S) {
  const f = {};
  {
    const { name, birth, sleepCfg, theme, ...rest } = st.profile;
    const extra = {}; Object.keys(rest).sort().forEach(k => { if (rest[k] !== undefined && rest[k] !== '') extra[k] = rest[k]; });
    f.profile = JSON.stringify({ name, birth, ...(sleepCfg ? { sleepCfg } : {}), ...extra });
  }
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
    if (id === 'profile') { const { theme, ...pub } = v; Object.assign(st.profile, pub, { name: v.name || '', birth: v.birth || '' }); }
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
    if (dlg.open) { renderPending = true; refreshSettingsFields(); } else render();
  },
  // Порция изменений из облака: { id: значение | null (удалено) }
  applyChanges(changes) {
    nightCache = null; gapCache = null;
    const f = flatten(S);
    for (const [id, v] of Object.entries(changes)) {
      if (v == null && id === 'profile') continue; // профиль малыша через синхронизацию не удаляется никогда
      if (v == null) delete f[id]; else f[id] = v;
    }
    S = unflatten(f);
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* */ }
    if (dlg.open) { renderPending = true; refreshSettingsFields(); } else render();
  },
  syncChanged() {
    const el = $('#sync-status'); if (el) el.textContent = syncLabel();
    const dot = $('.icon-btn .sync'); if (dot) dot.dataset.s = window.Sync ? window.Sync.status : 'off';
  },
};
function syncLabel() {
  const sy = window.Sync; if (!sy) return '';
  const err = String(sy.error || '');
  const why = /timeout/.test(err) ? 'облако не отвечает — пробую снова' : /operation-not-allowed|admin-restricted/.test(err) ? 'в Firebase не включён анонимный вход (Authentication → Sign-in method → Anonymous)'
    : /permission-denied/.test(err) ? 'нет доступа — проверьте правила Firestore (вкладка Rules → Publish)'
    : /not-found|NOT_FOUND/.test(err) ? 'база Firestore не найдена — создайте базу (default)'
    : 'ошибка: ' + (err || 'неизвестно');
  const lastTxt = sy.lastSync ? ' · обновлено ' + (dayKey(sy.lastSync) === todayStr() ? 'в ' + hhmm(sy.lastSync) : fmtShort.format(sy.lastSync) + ' ' + hhmm(sy.lastSync)) : '';
  return ({ off: 'выключена', connecting: 'подключаюсь…', on: 'работает ✓', offline: 'нет связи — изменения отправятся позже', error: why }[sy.status] || sy.status) + lastTxt;
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
  return h + ':' + pad(m) + ':' + pad(x); // всегда ч:мм:сс — «0:25:00», чтобы 25 минут не путали с 25 часами
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
  doc: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  drop: svg('<path d="M12 3.5c3 3.6 6 7.2 6 10.5a6 6 0 0 1-12 0c0-3.3 3-6.9 6-10.5z"/>'),
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
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* */ } };
let checking = false, lastCheck = 0;
async function checkUpdate(manual) {
  if (checking) return;
  checking = true; lastCheck = Date.now();
  const had = update && update.version;
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const remote = await r.json();
    update = newer(remote.version, APP_VERSION) ? remote : null;
    if (manual) toast(update ? 'Есть новая версия ' + remote.version : 'У вас последняя версия');
    else if (update && update.version !== had) toast('Доступна новая версия ' + update.version);
  } catch (e) {
    if (manual) toast('Не удалось проверить — нет интернета?');
  }
  checking = false;
  if (!dlg.open) render(); else if (manual) settingsForm();
}
async function applyUpdate() {
  toast('Обновляю…');
  if (update) lsSet('malysh.updating', update.version);
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
    }
    if (window.caches) { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); }
    // Заранее скачиваем свежие файлы в обход кэша браузера
    await Promise.all(['./', './index.html', './app.js', './style.css', './sync.js'].map(u => fetch(u, { cache: 'reload' }).catch(() => {})));
  } catch (e) { /* ничего страшного — просто перезагрузим */ }
  location.reload();
}
// Полоса над содержимым на всех вкладках — видна, даже если прокрутить вниз
function updateStrip() {
  if (!update) return '';
  return `<button class="update-strip" data-act="whatsnew"><span class="u-ico">${I.refresh}</span><span class="u-txt"><b>Обновите приложение</b><small>Доступна новая версия ${esc(update.version)} · записи сохранятся</small></span><span class="u-btn">Обновить</span></button>`;
}
function notesList(notes) {
  return Array.isArray(notes) && notes.length ? `<div class="field"><span>Что нового</span><ul class="whatsnew">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>` : '';
}
function whatsNew() {
  if (!update) return;
  openSheet('Доступна версия ' + update.version,
    `<p class="muted">Сейчас установлена ${APP_VERSION}${update.date ? ' · обновление от ' + esc(fmtLong.format(parseDate(update.date))) : ''}</p>` +
    notesList(update.notes) +
    `<p class="muted">Все записи о малыше и идущий таймер сна останутся на месте.</p>`,
    () => { applyUpdate(); return false; }, { ok: 'Обновить сейчас' });
}
// После обновления один раз показываем, что нового (и если приложение обновилось само при запуске)
async function showUpdatedOnce() {
  const seen = lsGet('malysh.seenVersion'), target = lsGet('malysh.updating');
  if (target && newer(target, APP_VERSION)) {
    lsSet('malysh.updating', null);
    toast('Новая версия ещё загружается на сервер — попробуйте через пару минут');
    return;
  }
  lsSet('malysh.updating', null);
  lsSet('malysh.seenVersion', APP_VERSION);
  if (!seen || !newer(APP_VERSION, seen)) return; // первая установка или та же версия
  let notes = [];
  try { const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' }); const j = await r.json(); if (j.version === APP_VERSION) notes = j.notes || []; } catch (e) { /* без списка */ }
  if (dlg.open) return;
  openSheet('Приложение обновлено 🎉',
    `<p class="muted">Версия ${esc(seen)} → <b style="color:var(--ok)">${APP_VERSION}</b>. Все записи на месте.</p>` + notesList(notes),
    () => {}, { ok: 'Отлично' });
}

/* ---------------- Рендер ---------------- */
let tab = location.hash.slice(1) || 'today';
let metric = 'weight';
const TABS = [['today', 'Сегодня', I.home], ['sleep', 'Сон', I.moon], ['feed', 'Смесь', I.bottle], ['solid', 'Прикорм', I.bowl], ['stool', 'Стул', I.drop], ['growth', 'Рост', I.chart], ['vacc', 'Прививки', I.shield]];

function applyTheme() {
  const t = S.profile.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
function header() {
  const p = S.profile;
  return `<header class="top"><div class="who"><div class="avatar">${esc((p.name || 'М').trim()[0] || 'М').toUpperCase()}</div><div><h1>${esc(p.name || 'Малыш')}</h1><p>${p.birth ? ageText(p.birth) : 'Дневник мамы'}</p></div></div>
  <span class="top-btns"><button class="icon-btn" data-act="report" aria-label="Отчёт для педиатра">${I.doc}</button><button class="icon-btn" data-act="settings" aria-label="Настройки">${I.sliders}${update ? '<i class="badge"></i>' : ''}${window.Sync && window.Sync.family ? `<i class="sync" data-s="${window.Sync.status}" title="Синхронизация"></i>` : ''}</button></span></header>`;
}
function tabbar() {
  return `<div class="tabbar"><nav>${TABS.map(([k, l, ic]) => `<a href="#${k}" class="${tab === k ? 'on' : ''}" ${tab === k ? 'aria-current="page"' : ''}><span class="pip">${ic}</span>${l}</a>`).join('')}</nav></div>`;
}
let resetScroll = false;
function render() {
  nightCache = null; gapCache = null;
  applyTheme();
  if (!VIEWS[tab]) tab = 'today';
  const old = $('#scroller'), y = old ? old.scrollTop : 0;
  $('#app').innerHTML = header() + updateStrip() + `<div id="scroller" class="scroller"><main class="view">${VIEWS[tab]()}</main></div>` + tabbar();
  const sc = $('#scroller'); if (sc && y && !resetScroll) sc.scrollTop = y;
  resetScroll = false;
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
// Ночь или день — по режиму семьи (когда обычно укладывают и когда малыш встаёт)
const minOfDay = ts => { const d = new Date(ts); return d.getHours() * 60 + d.getMinutes(); };
const fmtMin = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + ':' + pad(m % 60); };
const parseHM = (str, def) => { const [h, m] = String(str || '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : def; };
const kindByHour = e => e.kind || ((h => (h >= 19 || h < 6) ? 'night' : 'day')(new Date(e.start).getHours()));
let nightCache = null, gapCache = null;
function nightSchedule() {
  if (nightCache) return nightCache;
  const cfg = S.profile.sleepCfg || {};
  // По записям за 14 дней: начало каждой ночи (первая часть) и подъём (конец последней части)
  const since = Date.now() - 15 * DAY, nights = new Map();
  S.events.forEach(e => {
    if (e.type !== 'sleep' || e.end < since || kindByHour(e) !== 'night') return;
    const k = nightKey(e.start); if (!nights.has(k)) nights.set(k, []); nights.get(k).push(e);
  });
  // Ночь = самая длинная часть + соседние части с перерывом до 45 мин (ночные пробуждения).
  // Короткий вечерний сон за час-два до укладывания в начало ночи не попадает.
  const full = [...nights.values()].map(parts => {
    parts.sort((x, y) => x.start - y.start);
    let i = parts.reduce((bi, e, j) => (e.end - e.start > parts[bi].end - parts[bi].start ? j : bi), 0), a = i, z = i;
    while (a > 0 && parts[a].start - parts[a - 1].end <= 45 * MIN) a--;
    while (z < parts.length - 1 && parts[z + 1].start - parts[z].end <= 45 * MIN) z++;
    return { start: parts[a].start, end: parts[z].end };
  }).filter(n => n.end - n.start >= 4 * HOUR); // только полноценные ночи
  // Время укладывания считаем от полудня, чтобы 23:30 и 00:30 оказались рядом
  const beds = full.map(n => (minOfDay(n.start) + 720) % 1440), wakes = full.map(n => minOfDay(n.end));
  const learned = full.length >= 2;
  const lBed = learned ? (median(beds) + 720) % 1440 : null, lWake = learned ? median(wakes) : null;
  let bed, wake, source;
  if (cfg.nightMode === 'manual') { bed = parseHM(cfg.bedtime, 20 * 60); wake = parseHM(cfg.wake, 7 * 60); source = 'manual'; }
  else if (learned) { bed = lBed; wake = lWake; source = 'learned'; }
  else { bed = 20 * 60; wake = 7 * 60; source = 'default'; }
  nightCache = { bed, wake, source, n: full.length, lBed, lWake };
  return nightCache;
}
function autoKind(ts) {
  const ns = nightSchedule(), m = minOfDay(ts);
  const from = (ns.bed - 60 + 1440) % 1440, to = (ns.wake - 45 + 1440) % 1440; // за час до укладывания … за 45 мин до подъёма
  return (from > to ? (m >= from || m < to) : (m >= from && m < to)) ? 'night' : 'day';
}
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
// Бодрствование перед каждым сном: от конца предыдущего сна до начала этого
function wakeGaps() {
  if (gapCache) return gapCache;
  const map = {}, sl = S.events.filter(e => e.type === 'sleep').sort((a, b) => a.start - b.start);
  const t = S.timers.sleep;
  if (t) sl.push({ id: 'live', start: t.start, end: Date.now(), kind: t.kind || autoKind(t.start) });
  const ranges = S.profile.birth ? { first: wakeRange('first'), middle: wakeRange('middle'), last: wakeRange('last') } : {};
  let prev = null;
  sl.forEach(e => {
    if (prev) {
      const min = (e.start - prev.end) / MIN;
      if (min >= 5 && min <= 8 * 60) {
        const pn = sleepKind(prev) === 'night', en = sleepKind(e) === 'night';
        const type = pn && en ? 'nightwake' : pn ? 'first' : en ? 'last' : 'middle';
        const r = ranges[type];
        const cls = !r ? '' : min < r[0] - 10 ? 'short' : min > r[1] + 10 ? 'long' : 'ok';
        map[e.id] = { min, type, cls };
      }
    }
    if (!prev || e.end > prev.end) prev = e;
  });
  gapCache = map;
  return map;
}
const wkTitle = { short: 'меньше обычного', long: 'дольше обычного — мог перегулять', ok: 'в норме' };
// Нормы сна по возрасту (часы): [до N мес, ночь от, до, день от, до, за сутки от, до]
// Ориентиры: AASM (4–12 мес — 12–16 ч в сутки), таблицы педиатров по месяцам.
const SLEEP_NORM = [
  [2, 8, 10, 6, 8, 14, 17], [3, 9, 10, 4, 5, 13, 15], [4, 10, 11, 3, 4.5, 13, 16], [7, 10, 11.5, 2.5, 4, 13, 15],
  [12, 10, 12, 2, 3, 12, 15], [18, 10, 12, 1.5, 3, 12, 14], [999, 10, 12, 1.5, 2.5, 11, 14],
];
function sleepNorm() {
  const m = ageMonths(); if (m == null || m < 0) return null;
  const r = SLEEP_NORM.find(x => m < x[0]);
  return { night: [r[1], r[2]], day: [r[3], r[4]], total: [r[5], r[6]] };
}
const fh = v => String(v).replace('.', ',');
const normTxt = r => `${fh(r[0])}–${fh(r[1])} ч`;
// Оценка: пока идёт — 'live'; в норме — 'ok'; чуть меньше (до 45 мин) — 'near'; заметно меньше — 'short'
function normCls(ms, r, done) {
  if (!r) return ''; if (!done) return 'live';
  return ms >= r[0] * HOUR - MIN ? 'ok' : ms >= r[0] * HOUR - 45 * MIN ? 'near' : 'short';
}
function nightDone(parts) {
  if (!parts.length || parts.some(e => e.live)) return false;
  const lastEnd = Math.max(...parts.map(e => e.end));
  return autoKind(Date.now()) === 'day' || Date.now() - lastEnd > 3 * HOUR;
}
function dayDone(D) { return D < todayStr() || Date.now() >= bedtimeOn(parseDate(D).getTime()); }
function wakePill(e) {
  // Ночь — это не «бодрствование перед сном»: на ночных плашках солнышко только у ночных пробуждений
  if (sleepKind(e) === 'night' && (wakeGaps()[e.id] || {}).type !== 'nightwake') return '';
  const g = wakeGaps()[e.id]; if (!g) return '';
  return `<i class="wk ${g.cls}">☀ ${hm(g.min)}</i>`;
}
function sleepTile(e, label) {
  const inner = `${wakePill(e)}<small>${label}</small><b>${e.live ? `<span data-since="${e.start}"></span>` : durS(e.end - e.start)}</b><span>${hhmm(e.start)} – ${e.live ? 'спит' : hhmm(e.end)}</span>`;
  return e.live ? `<button class="tile ${sleepKind(e)} live" data-act="edit-live">${inner}</button>` : `<button class="tile ${sleepKind(e)}" data-ev="${e.id}">${inner}</button>`;
}
const fmtDM = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
// Блок плашек сна за дату D. nightD — дата ночи, которую показываем (по умолчанию ночь на D)
function sleepBlocks(D, nightD = D, nightTitle) {
  const n = sleepsFor(nightD).night, d = sleepsFor(D).day;
  const nt = nightTitle || 'Ночь на ' + fmtDM.format(parseDate(nightD));
  const wakes = n.length > 1 ? ` · просыпалась ${n.length - 1} ${pl(n.length - 1, ['раз', 'раза', 'раз'])}` : '';
  const nm = sleepNorm(), nMs = sleepDur(n), dMs = sleepDur(d);
  const nCls = nm ? normCls(nMs, nm.night, nightDone(n)) : '', dCls = nm ? normCls(dMs, nm.day, dayDone(D)) : '';
  const badge = (ms, cls) => `<b class="nb ${cls}">${durS(ms)}${cls === 'ok' ? ' ✓' : ''}</b>`;
  const wk = n.length > 1 ? ` · ${n.length - 1} ${pl(n.length - 1, ['пробуждение', 'пробуждения', 'пробуждений'])}` : '';
  const before = n.length ? wakeGaps()[n[0].id] : null;
  return `<div class="sp-head night"><h4>${I.moon}${nt}</h4><span>${n.length ? badge(nMs, nCls) : ''}${nm ? `<em>норма ${normTxt(nm.night)}${wk}</em>` : ''}</span></div>
    <div class="tiles">${n.map((e, i) => sleepTile(e, n.length > 1 ? 'Часть ' + (i + 1) : 'Ночной сон')).join('')}<button class="tile add night" data-act="add-sleep" data-kind="night" data-d="${nightD}">${I.plus}<span>Ночь</span></button></div>
    ${before && before.type === 'last' ? `<p class="before-night">☀ Перед ночью бодрствовала ${hm(before.min)}</p>` : ''}
    <div class="sp-head day"><h4>${I.sun}Дневной сон</h4><span>${d.length ? badge(dMs, dCls) : ''}${nm ? `<em>норма ${normTxt(nm.day)}${d.length ? ' · ' + d.length + ' ' + pl(d.length, ['сон', 'сна', 'снов']) : ''}</em>` : ''}</span></div>
    <div class="tiles">${d.map((e, i) => sleepTile(e, 'Сон ' + (i + 1))).join('')}<button class="tile add day" data-act="add-sleep" data-kind="day" data-d="${D}">${I.plus}<span>Дневной</span></button></div>
    ${[...n, ...d].some(e => wakeGaps()[e.id]) ? `<p class="wk-legend"><i class="wk ok">☀ 1:45</i> бодрствовала перед сном · <i class="wk long">☀</i> дольше обычного · <i class="wk short">☀</i> меньше</p>` : ''}`;
}
function sleepButton() {
  const t = S.timers.sleep;
  if (t) {
    const k = t.kind || autoKind(t.start);
    return `<div class="sleep-now ${k}"><button class="sn-info" data-act="edit-live"><small>${k === 'night' ? 'Ночной сон' : 'Дневной сон'} · с ${hhmm(t.start)} ✎</small><b data-since="${t.start}"></b></button>
      <span class="sn-btns"><button class="btn ghost small" data-act="edit-live">Изменить</button><button class="btn ghost small" data-act="sleep-cancel">Отмена</button></span><button class="btn sleep" data-act="sleep-toggle">${I.sun} Проснулся</button></div>`;
  }
  const k = autoKind(Date.now());
  const last = latest(S.events.filter(e => e.type === 'sleep'), 'end');
  return `<div class="sleep-now idle"><div><small>${last ? 'Бодрствует · проснулся в ' + hhmm(last.end) : 'Малыш бодрствует'}</small><b>${last ? dur(Date.now() - last.end) : '—'}</b></div>
    <button class="btn sleep" data-act="sleep-toggle">${I.moon} Уснул</button></div>${forecastBlock(forecast())}`;
}
/* ---- Прогноз сна ---- */
// По возрасту: [до N месяцев, бодрствование от, до (мин), обычно дневных снов, типичный дневной сон (мин)]
// Ориентиры из открытых таблиц «окон бодрствования» (Huckleberry, Napper и др.): в 5–6 мес — 1,5–2,5 ч.
const WAKE_TABLE = [
  [1, 45, 60, 5, 45], [2, 60, 90, 4, 50], [3, 75, 105, 4, 50], [4, 90, 120, 4, 50],
  [5, 90, 135, 4, 50], [6, 90, 150, 3, 60], [7, 120, 180, 3, 60], [9, 150, 210, 2, 75],
  [12, 180, 240, 2, 75], [18, 240, 300, 1, 120], [24, 300, 360, 1, 120], [999, 330, 390, 1, 90],
];
const SLEEP_CFG = { mode: 'auto', lo: 90, hi: 135, remind: 15, nightMode: 'auto', bedtime: '21:00', wake: '07:00' };
const sleepCfg = () => ({ ...SLEEP_CFG, ...(S.profile.sleepCfg || {}) });
function ageMonths() { return S.profile.birth ? (startOfDay(Date.now()) - parseDate(S.profile.birth).getTime()) / DAY / 30.44 : null; }
function ageRow() { const m = ageMonths(); return m == null ? null : WAKE_TABLE.find(r => m < r[0]); }
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
const r5 = m => Math.round(m / 5) * 5;
function hm(min) { min = Math.round(min); const h = Math.floor(min / 60), m = min % 60; return h ? h + ':' + pad(m) : m + ' мин'; }

// Как малыш реально бодрствует и спит днём за последние 7 дней
function personalStats() {
  const since = Date.now() - 7 * DAY;
  const sl = S.events.filter(e => e.type === 'sleep' && e.end > since).sort((a, b) => a.start - b.start);
  const gaps = [];
  for (let i = 1; i < sl.length; i++) { const g = (sl[i].start - sl[i - 1].end) / MIN; if (g >= 20 && g <= 360) gaps.push(g); }
  const naps = sl.filter(e => sleepKind(e) === 'day').map(e => (e.end - e.start) / MIN).filter(m => m >= 15 && m <= 240);
  return { wake: gaps.length >= 5 ? median(gaps) : 0, wakeN: gaps.length, nap: naps.length >= 3 ? median(naps) : 0 };
}
// Окно бодрствования [от, до] в минутах. type: first — после ночи, middle — между дневными снами, last — перед ночью
function wakeRange(type) {
  const cfg = sleepCfg(), row = ageRow();
  let lo, hi;
  if (cfg.mode === 'custom') return [r5(+cfg.lo), r5(+cfg.hi)]; // своё окно — ровно как задано
  else {
    if (!row) return null;
    lo = row[1]; hi = row[2];
    const ps = personalStats();
    if (ps.wake) { // подстраиваемся под малыша: сдвигаем середину окна наполовину к его привычному времени
      const c = (lo + hi) / 2, w = hi - lo;
      const c2 = Math.min(hi + 20, Math.max(lo - 20, (c + ps.wake) / 2));
      lo = c2 - w / 2; hi = c2 + w / 2;
    }
  }
  const sp = hi - lo;
  if (type === 'first') return [r5(lo), r5(lo + sp * 0.6)];
  if (type === 'last') return [r5(lo + sp * 0.4), r5(hi)];
  return [r5(lo + sp * 0.15), r5(hi - sp * 0.1)];
}
// Ближайшее «время укладывания на ночь» для дня, в который малыш проснулся
function bedtimeOn(ts) {
  const ns = nightSchedule(), d = new Date(ts); d.setHours(0, 0, 0, 0);
  let t = d.getTime() + ns.bed * MIN;
  if (ns.bed < 12 * 60) t += DAY; // укладывают после полуночи
  return t;
}
function wakeOn(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime() + nightSchedule().wake * MIN; }

function forecast(now = Date.now()) {
  if (!S.profile.birth || S.timers.sleep) return null;
  const last = latest(S.events.filter(e => e.type === 'sleep'), 'end');
  if (!last || last.end > now || now - last.end > 8 * HOUR) return null;
  // Проснулся среди ночи (задолго до обычного подъёма) — это ночное пробуждение, а не начало дня
  if (sleepKind(last) === 'night' && autoKind(now) === 'night') {
    const ns = nightSchedule(), wk = minOfDay(last.end) < ns.wake ? wakeOn(last.end) : wakeOn(last.end + DAY);
    if (wk - last.end > 60 * MIN) return { nightWake: true, awake: last.end, wakeAt: wk, stage: 'night' };
  }
  const cfg = sleepCfg(), row = ageRow(), ps = personalStats();
  const awake = last.end, bed = bedtimeOn(awake);
  const mid = r => (r[0] + r[1]) / 2;
  const lr = wakeRange('last'), mr = wakeRange('middle'); if (!lr) return null;
  // Дневной сон уже не помещается: даже короткий сон отодвинет ночь слишком поздно
  const noRoomForNap = t => t + mid(mr) * MIN + 20 * MIN + lr[0] * MIN > bed + 30 * MIN;
  let type = sleepKind(last) === 'night' ? 'first' : 'middle';
  if (type === 'middle' && (awake + mid(lr) * MIN >= bed - 40 * MIN || noRoomForNap(awake))) type = 'last';
  const r = type === 'last' ? lr : wakeRange(type);
  const from = awake + r[0] * MIN, to = awake + r[1] * MIN, prepare = from - cfg.remind * MIN;
  const stage = now < prepare ? 'ok' : now < from ? 'soon' : now <= to ? 'now' : 'late';
  // План на остаток дня
  const napLen = (ps.nap || (row ? row[4] : 50)) * MIN;
  // Ночь — около желаемого времени, но в пределах окна бодрствования после последнего сна
  const nightAfter = t => Math.min(Math.max(bed, t + lr[0] * MIN), t + lr[1] * MIN);
  const plan = [];
  // Если этот дневной сон — последний перед ночью, он короткий, чтобы ночь не сдвинулась
  const curLen = type === 'last' ? 0 : Math.min(napLen, Math.max(20 * MIN, bed - (from + to) / 2 - mid(lr) * MIN));
  const shortNap = type !== 'last' && curLen < napLen - 10 * MIN;
  if (type !== 'last') {
    let t = (from + to) / 2 + curLen;
    for (let i = 0; i < 6; i++) {
      if (t + mid(lr) * MIN >= bed - 40 * MIN || noRoomForNap(t)) { plan.push({ kind: 'night', at: nightAfter(t) }); break; }
      const s = t + mid(mr) * MIN;
      const len = Math.min(napLen, Math.max(20 * MIN, bed - s - mid(lr) * MIN)); // последний сон перед ночью — короткий
      plan.push({ kind: 'day', at: s, short: len < napLen - 10 * MIN }); t = s + len;
    }
  }
  return { awake, type, next: type === 'last' ? 'night' : 'nap', shortNap, napMin: Math.round(curLen / MIN), r, from, to, prepare, stage, plan, personal: cfg.mode === 'auto' && ps.wake ? ps.wake : 0, custom: cfg.mode === 'custom' };
}
const untilTxt = ms => (ms <= 0 ? 'сейчас' : 'через ' + dur(ms));
function forecastBlock(f) {
  if (f && f.nightWake) {
    return `<div class="forecast night"><div class="fc-top"><small>Ночь</small><b>Подъём обычно ≈ ${hhmm(f.wakeAt)}</b><span>Малыш проснулся ночью — ${dur(Date.now() - f.awake)} назад. Это ночное пробуждение: свет не включайте, укладывайте снова — сон запишется как часть ночи.</span></div></div>`;
  }
  if (!f) {
    if (!S.profile.birth) return `<p class="hint fc-hint">Укажите дату рождения в настройках — появится прогноз, когда укладывать.</p>`;
    if (!S.events.some(e => e.type === 'sleep')) return `<p class="hint fc-hint">Запишите хотя бы один сон — и приложение подскажет, когда укладывать в следующий раз.</p>`;
    return '';
  }
  const now = Date.now(), nm = f.next === 'night' ? 'ночной сон' : 'дневной сон';
  const head = { ok: 'Следующий ' + (f.shortNap ? 'короткий ' : '') + nm + (f.shortNap ? ' (~' + f.napMin + ' мин)' : ''), soon: 'Пора готовиться ко сну', now: 'Пора укладывать', late: 'Перегуливает' }[f.stage];
  const sub = {
    ok: `Начните ритуал в ${hhmm(f.prepare)} (${untilTxt(f.prepare - now)})`,
    soon: 'Приглушите свет, уберите активные игры, начните ритуал',
    now: `Окно открыто ещё ${dur(f.to - now)} — укладывайте при первых признаках усталости`,
    late: `Окно закрылось ${dur(now - f.to)} назад — уложите как можно скорее`,
  }[f.stage];
  const span = f.to + (f.to - f.awake) * 0.15 - f.awake, pos = t => Math.max(0, Math.min(100, (t - f.awake) / span * 100));
  const r5t = t => Math.round(t / (5 * MIN)) * 5 * MIN;
  const planTxt = f.plan.length ? 'Дальше: ' + f.plan.map(p => (p.kind === 'night' ? 'ночь ≈ ' : p.short ? 'короткий сон ≈ ' : 'сон ≈ ') + hhmm(r5t(p.at))).join(' · ') : '';
  const basis = f.custom ? 'ваше окно' : 'по возрасту' + (f.personal ? ' и привычкам малыша' : '');
  const al = alertPrefs(), target = f.prepare > now ? f.prepare : f.from, mins = Math.round((target - now) / MIN);
  return `<div class="forecast ${f.stage}">
    <div class="fc-top"><small>${head}</small><b>${hhmm(f.from)} – ${hhmm(f.to)}</b><span>${sub}</span></div>
    <div class="fc-bar"><i style="width:${pos(now)}%"></i><em style="left:${pos(f.from)}%;width:${pos(f.to) - pos(f.from)}%"></em></div>
    <div class="fc-meta"><span>Бодрствование ${hm(f.r[0])}–${hm(f.r[1])} · ${basis}</span>${planTxt ? `<span>${planTxt}</span>` : ''}</div>
    ${al.shortcut && mins >= 1 ? `<button class="btn small fc-timer" data-x="ios-timer" data-min="${mins}">⏰ Таймер iPhone на ${hm(mins)}</button>` : ''}
  </div>`;
}

/* ---- Сигналы: звук и уведомление, пока приложение открыто ---- */
const ALERT_KEY = 'malysh.alerts';
function alertPrefs() { try { return { sound: true, notify: false, shortcut: false, ...(JSON.parse(localStorage.getItem(ALERT_KEY) || '{}')) }; } catch (e) { return { sound: true, notify: false, shortcut: false }; } }
function setAlertPrefs(p) { try { localStorage.setItem(ALERT_KEY, JSON.stringify({ ...alertPrefs(), ...p })); } catch (e) { /* */ } }
let audioCtx = null;
function unlockAudio() {
  try {
    if (!audioCtx) { const C = window.AudioContext || window.webkitAudioContext; if (C) audioCtx = new C(); }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* */ }
}
document.addEventListener('pointerdown', unlockAudio, { passive: true });
function chime() {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime + 0.05;
  [[659.3, 0], [784, 0.35], [987.8, 0.7], [784, 1.4], [987.8, 1.75]].forEach(([f, dt]) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0, t0 + dt); g.gain.linearRampToValueAtTime(0.35, t0 + dt + 0.03); g.gain.exponentialRampToValueAtTime(0.001, t0 + dt + 0.9);
    o.connect(g).connect(audioCtx.destination); o.start(t0 + dt); o.stop(t0 + dt + 1);
  });
}
function fireAlert(title, body) {
  const p = alertPrefs();
  toast(title);
  if (p.sound) chime();
  if (navigator.vibrate) { try { navigator.vibrate([200, 100, 200]); } catch (e) { /* */ } }
  if (p.notify && 'Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker) {
    navigator.serviceWorker.ready.then(r => r.showNotification(title, { body, tag: 'malysh-sleep', renotify: true, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' })).catch(() => {});
  }
}
function checkAlerts() {
  const f = forecast(); if (!f || f.nightWake) return;
  const now = Date.now(), name = S.profile.name || 'малыша';
  let fired = {}; try { fired = JSON.parse(localStorage.getItem('malysh.fired') || '{}'); } catch (e) { /* */ }
  const fresh = t => now >= t && now - t < 15 * MIN; // не трезвоним о давно прошедшем
  let changed = false;
  if (fresh(f.prepare) && !fired[f.awake + 's']) {
    fired[f.awake + 's'] = 1; changed = true;
    fireAlert('Пора готовиться ко сну', `Уложите ${name} в ${hhmm(f.from)}–${hhmm(f.to)} — ${f.next === 'night' ? 'ночной' : 'дневной'} сон`);
  }
  if (fresh(f.to) && !fired[f.awake + 'l']) {
    fired[f.awake + 'l'] = 1; changed = true;
    fireAlert('Окно бодрствования закончилось', `Уложите ${name} как можно скорее, чтобы не перегулял`);
  }
  if (changed) {
    const keep = Object.keys(fired).slice(-20); const o = {}; keep.forEach(k => { o[k] = 1; });
    try { localStorage.setItem('malysh.fired', JSON.stringify(o)); } catch (e) { /* */ }
  }
}
async function askNotify() {
  if (!('Notification' in window)) { alert('На этом устройстве уведомления недоступны. На iPhone они работают в приложении, установленном на экран «Домой» (iOS 16.4 и новее).'); return false; }
  let p = Notification.permission;
  if (p === 'default') p = await Notification.requestPermission();
  if (p === 'granted') { setAlertPrefs({ notify: true }); toast('Уведомления включены'); return true; }
  alert('Уведомления запрещены. Разрешить их можно в Настройках iPhone → Уведомления → Малыш.');
  return false;
}
function sleepSettingsBlock() {
  const c = sleepCfg(), a = alertPrefs(), row = ageRow(), ns = nightSchedule();
  const opts = (sel) => { let o = ''; for (let m = 30; m <= 360; m += 15) o += `<option value="${m}" ${+sel === m ? 'selected' : ''}>${hm(m)}</option>`; return o; };
  const nState = !('Notification' in window) ? 'недоступны на этом устройстве' : Notification.permission === 'granted' ? (a.notify ? 'включены ✓' : 'разрешены, но выключены') : Notification.permission === 'denied' ? 'запрещены в настройках iPhone' : 'не включены';
  return `<div class="settings-block"><h4>Прогноз сна</h4>
    <p>${row ? `По возрасту бодрствование ${hm(row[1])}–${hm(row[2])}, обычно ${row[3]} ${pl(row[3], ['дневной сон', 'дневных сна', 'дневных снов'])}. ` : ''}Прогноз подстраивается под реальные записи сна малыша.</p>
    ${group('Окно бодрствования', seg('sc_mode', [['auto', 'По возрасту'], ['custom', 'Своё']], c.mode))}
    <div class="two">${field('От', `<select name="sc_lo">${opts(c.lo)}</select>`)}${field('До', `<select name="sc_hi">${opts(c.hi)}</select>`)}</div>
    ${field('Напомнить за', `<select name="sc_rem">${[5, 10, 15, 20, 30].map(m => `<option value="${m}" ${+c.remind === m ? 'selected' : ''}>${m} мин</option>`).join('')}</select>`)}
    <p class="muted" style="font-size:13px">«От» и «До» действуют, если выбрано «Своё».</p>
    <h4 style="margin-top:6px">Режим ночи</h4>
    <p>${ns.lBed != null ? `По записям (${ns.n} ${pl(ns.n, ['ночь', 'ночи', 'ночей'])}): укладываете ≈ <b>${fmtMin(ns.lBed)}</b>, встаёт ≈ <b>${fmtMin(ns.lWake)}</b>.` : 'Пока мало записей ночного сна — после 2–3 ночей приложение само узнает ваш режим.'} Ночным считается сон, начатый за час до укладывания и до утреннего подъёма.</p>
    ${group('Время ночного сна', seg('sc_nm', [['auto', 'Узнавать по записям'], ['manual', 'Задать вручную']], c.nightMode === 'manual' ? 'manual' : 'auto'))}
    <div class="two">${field('Укладываем около', `<input type="time" name="sc_bed" value="${esc(c.nightMode === 'manual' ? c.bedtime : fmtMin(ns.lBed != null ? ns.lBed : parseHM(c.bedtime, 1260)))}">`)}${field('Встаёт около', `<input type="time" name="sc_wake" value="${esc(c.nightMode === 'manual' ? c.wake : fmtMin(ns.lWake != null ? ns.lWake : parseHM(c.wake, 420)))}">`)}</div>
    <p class="muted" style="font-size:13px">Время действует, если выбрано «Задать вручную». Настройки прогноза общие для всех телефонов семьи.</p>
    <h4 style="margin-top:6px">Сигналы на этом телефоне</h4>
    <label class="checkline"><input type="checkbox" name="al_sound" ${a.sound ? 'checked' : ''}> Звук, когда пора укладывать</label>
    <p>Уведомления: <b>${nState}</b></p>
    ${'Notification' in window && Notification.permission !== 'denied' && !(Notification.permission === 'granted' && a.notify) ? `<button type="button" class="btn" data-x="notify-on">Включить уведомления</button>` : ''}
    <p class="muted" style="font-size:13px">Звук и уведомления срабатывают, пока приложение открыто (можно оставить его на экране). Чтобы сигнал пришёл при закрытом приложении, используйте таймер iPhone ниже.</p>
    <label class="checkline"><input type="checkbox" name="al_shortcut" ${a.shortcut ? 'checked' : ''}> Кнопка «Таймер iPhone» (через Быстрые команды)</label>
    <details class="tips"><summary>Как настроить таймер iPhone — 1 раз, 2 минуты</summary><ol class="steps">
      <li>Откройте приложение <b>«Быстрые команды»</b> (Shortcuts) → <b>+</b> (новая команда).</li>
      <li>Нажмите на название вверху → <b>«Переименовать»</b> → введите точно: <b>Малыш таймер</b>.</li>
      <li><b>«Добавить действие»</b> → найдите <b>«Запустить таймер»</b> (Часы).</li>
      <li>В действии нажмите на число минут → выберите переменную <b>«Ввод быстрой команды»</b>. Единицы — <b>минуты</b>.</li>
      <li>Нажмите <b>«Готово»</b>. Включите галочку выше — в прогнозе появится кнопка «⏰ Таймер iPhone». Она откроет Быстрые команды и заведёт таймер до начала ритуала.</li>
    </ol><p class="muted" style="font-size:13px">Таймер iPhone звонит, даже если приложение закрыто и телефон в беззвучном режиме.</p></details>
  </div>`;
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
    case 'stool': return { cls: 'stool' + (stoolWarn(e) ? ' warn' : ''), icon: stoolSwatch(e.color), title: 'Стул · ' + (lbl(STOOL_COLORS, e.color) || 'без цвета').toLowerCase(), sub: (stoolDesc(e) || '&nbsp;') + note };
    case 'sleep': return { cls: 'sleep', icon: sleepKind(e) === 'night' ? I.moon : I.sun, title: (sleepKind(e) === 'night' ? 'Ночной сон · ' : 'Дневной сон · ') + dur(e.end - e.start), sub: hhmm(e.start) + ' – ' + hhmm(e.end) + (dayKey(e.start) !== dayKey(e.end) ? ' (след. день)' : '') + ((g => g ? ' · ☀ ' + hm(g.min) + ' до сна' + (g.cls === 'long' ? ' (долго)' : '') : '')(wakeGaps()[e.id])) + note };
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
  const st = items.filter(isStool).length;
  return [f ? f + ' ' + pl(f, ['кормление', 'кормления', 'кормлений']) : '', ml ? ml + ' мл' : '', so ? 'прикорм ' + so : '', st ? 'стул ' + st + ' ' + pl(st, ['раз', 'раза', 'раз']) : '', sl ? 'сон ' + dur(sl) : ''].filter(Boolean).join(' · ');
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

/* ---- Стул ---- */
// warn: цвета, которые стоит показать педиатру
const STOOL_COLORS = [
  ['yellow', 'Жёлтый', '#E3BC3A'], ['mustard', 'Горчичный', '#B8932A'], ['orange', 'Оранжевый', '#DE8435'],
  ['brown', 'Коричневый', '#875A30'], ['green', 'Зелёный', '#6E8C38'], ['darkgreen', 'Тёмно-зелёный', '#3F5A2A'],
  ['black', 'Чёрный', '#2A2420', true], ['red', 'С кровью / красный', '#C0392B', true], ['white', 'Белый / серый', '#D8D3CB', true],
];
const STOOL_CONS = [['watery', 'Водянистый'], ['liquid', 'Жидкий'], ['mushy', 'Кашицей'], ['soft', 'Мягкий'], ['formed', 'Оформленный'], ['hard', 'Твёрдый, комочки']];
const STOOL_AMOUNT = [['small', 'Мало'], ['medium', 'Средне'], ['large', 'Много']];
const STOOL_EXTRA = [['mucus', 'Слизь'], ['foam', 'Пена'], ['undigested', 'Непереваренные кусочки'], ['blood', 'Прожилки крови'], ['strain', 'Тужился, плакал']];
const lbl = (list, k) => { const x = list.find(i => i[0] === k); return x ? x[1] : ''; };
const stoolColor = k => STOOL_COLORS.find(c => c[0] === k);
const stoolWarn = e => { const c = stoolColor(e.color); return !!((c && c[3]) || (e.extra || []).includes('blood')); };
const isStool = e => e.type === 'stool';
function stoolSwatch(k) { const c = stoolColor(k); return `<i class="sw" style="background:${c ? c[2] : 'var(--line)'}"></i>`; }
function stoolDesc(e) {
  return [lbl(STOOL_CONS, e.cons).toLowerCase(), lbl(STOOL_AMOUNT, e.amount).toLowerCase(), ...(e.extra || []).map(x => lbl(STOOL_EXTRA, x).toLowerCase())].filter(Boolean).join(' · ');
}

function stoolForm(e) {
  const isNew = !e;
  const last = latest(S.events.filter(isStool));
  const v = e || { start: Date.now(), color: last ? last.color : 'yellow', cons: last ? last.cons : 'mushy', amount: 'medium', extra: [] };
  const ex = v.extra || [];
  openSheet('Стул',
    field('Время', `<input type="datetime-local" name="start" value="${dtl(v.start)}" required>`) +
    group('Цвет', `<div class="seg colors">${STOOL_COLORS.map(([k, l, c]) => `<label><input type="radio" name="color" value="${k}" ${k === v.color ? 'checked' : ''}><span><i class="sw" style="background:${c}"></i>${l}</span></label>`).join('')}</div>`) +
    group('Консистенция', seg('cons', STOOL_CONS, v.cons)) +
    group('Количество', seg('amount', STOOL_AMOUNT, v.amount)) +
    group('Особенности', `<div class="seg multi">${STOOL_EXTRA.map(([k, l]) => `<label><input type="checkbox" name="x_${k}" ${ex.includes(k) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>`) +
    noteField(v.note),
    fd => {
      const start = parseDtl(fd.start); if (!start) return false;
      const extra = STOOL_EXTRA.map(x => x[0]).filter(k => fd['x_' + k]);
      const rec = { type: 'stool', start, end: start, color: fd.color || '', cons: fd.cons || '', amount: fd.amount || '', extra, note: fd.note.trim() };
      upsertEv(e, rec);
      toast(stoolWarn(rec) ? 'Записано. Такой стул лучше показать педиатру' : (isNew ? 'Записано' : 'Изменения сохранены'));
    }, { del: !isNew && (() => delEv(e.id)) });
}

function stoolView() {
  const now = Date.now(), t0 = startOfDay(now);
  const all = S.events.filter(isStool);
  const today = all.filter(e => e.start >= t0);
  const last = latest(all);
  const days = lastDays(7).map(t => ({ t, total: all.filter(e => startOfDay(e.start) === t).length }));
  const prev = days.slice(0, 6).filter(d => d.total);
  const avg = prev.length ? (sum(prev, d => d.total) / 6) : 0;
  const recentWarn = all.filter(e => e.start > now - 3 * DAY && stoolWarn(e)).sort((a, b) => b.start - a.start);
  let out = `<section class="card"><div class="stats" style="grid-template-columns:1fr 1fr">
      <div class="stat stool"><small>Сегодня</small><b>${today.length}</b><span>${pl(today.length, ['раз', 'раза', 'раз'])}</span></div>
      <div class="stat"><small>Последний</small><b>${last ? hhmm(last.start) : '—'}</b><span>${last ? (dayKey(last.start) === todayStr() ? ago(last.start) : fmtShort.format(last.start) + ' · ' + ago(last.start)) : '&nbsp;'}</span></div></div>
    <button class="btn primary big-add stool-btn" data-act="add-stool">${I.plus} Записать стул</button></section>`;
  if (recentWarn.length) out += `<section class="card warn-card"><b>Стоит показать педиатру</b><p>${recentWarn.length === 1 ? 'Был стул' : 'За последние 3 дня было ' + recentWarn.length + ' раза'} с цветом или примесью, о которых лучше сказать врачу: ${[...new Set(recentWarn.map(e => (stoolColor(e.color) && stoolColor(e.color)[3]) ? stoolColor(e.color)[1].toLowerCase() : 'прожилки крови'))].join(', ')}. Если малыш вялый, отказывается от еды или у него температура — обратитесь к врачу сразу. Удобно сфотографировать подгузник.</p></section>`;
  out += `<section class="card"><h3>Стул за неделю</h3>${avg ? `<p class="hint">В среднем ${avg.toFixed(1).replace('.', ',').replace(',0', '')} раза в день</p>` : ''}${bars(days, v => v, 'stoolbars')}</section>`;
  // Сводка по цветам за 7 дней
  const week = all.filter(e => e.start >= startOfDay(addDays(now, -6)));
  if (week.length) {
    const byColor = STOOL_COLORS.map(([k, l]) => [k, l, week.filter(e => e.color === k).length]).filter(x => x[2]);
    out += `<section class="card"><h3>Цвет за неделю</h3><div class="chips">${byColor.map(([k, l, n]) => `<span class="chip plain">${stoolSwatch(k)}${l} · ${n}</span>`).join('')}</div></section>`;
  }
  out += history(all, 'Пока нет записей о стуле');
  return out;
}

/* ---- Норма питания (смесь + прикорм) ---- */
// Объёмный метод: суточный объём питания — доля от массы тела, не больше 1000 мл.
// Возраст (до N мес): доля веса, кормлений в сутки, мл за одно кормление (от–до)
const FEED_TABLE = [
  [1.5, 5, 7, 90, 150], [4, 6, 6, 120, 180], [6, 7, 5, 180, 210], [9, 8, 5, 210, 240], [12.5, 9, 4.5, 210, 240],
];
const FEED_MAX = 1000;
function lastWeight() {
  const g = [...S.growth].filter(x => +x.weight > 0).sort((a, b) => a.date.localeCompare(b.date));
  return g.length ? g[g.length - 1] : null;
}
function feedNorm() {
  const m = ageMonths(); if (m == null || m < 0 || m >= 12.5) return null;
  const row = FEED_TABLE.find(r => m < r[0]);
  const [, frac, feeds, perLo, perHi] = row;
  const w = lastWeight();
  const r10 = v => Math.round(v / 10) * 10;
  let total, basis;
  if (w) { total = Math.min(FEED_MAX, +w.weight * 1000 / frac); basis = `1/${frac} веса ${String(+w.weight).replace('.', ',')} кг`; }
  else { total = Math.min(FEED_MAX, feeds * (perLo + perHi) / 2); basis = 'по возрасту — добавьте вес для точности'; }
  const wAge = w ? Math.round((startOfDay(Date.now()) - parseDate(w.date).getTime()) / DAY) : null;
  return { total: r10(total), capped: total >= FEED_MAX, frac, feeds, perLo, perHi, weight: w, wAge, basis };
}
// Сколько съедено сегодня: смесь (мл) + прикорм (г) — в объёмном методе они считаются вместе
function eatenToday() {
  const t0 = startOfDay(Date.now());
  const ev = S.events.filter(e => e.start >= t0);
  const ml = sum(ev.filter(e => e.type === 'bottle'), e => +e.ml);
  const g = sum(ev.filter(e => e.type === 'solid'), e => +e.grams || 0);
  return { ml, g, total: ml + g, bottles: ev.filter(e => e.type === 'bottle').length };
}
function normBar(eaten, total) {
  const pct = Math.min(100, Math.round(eaten / total * 100));
  return `<div class="norm-bar ${pct >= 100 ? 'full' : ''}"><i style="width:${pct}%"></i></div>`;
}

/* ---- Экраны ---- */
let sleepDay = todayStr();
const VIEWS = {
  today() {
    const now = Date.now(), t0 = startOfDay(now), D = todayStr(), h = new Date(now).getHours();
    const ev = S.events.filter(e => e.start >= t0);
    const bottles = ev.filter(isFeed);
    const ml = sum(ev.filter(e => e.type === 'bottle'), e => +e.ml);
    const lastFeed = latest(S.events.filter(isFeed));
    const stoolsToday = ev.filter(isStool), lastStool = latest(S.events.filter(isStool));
    let out = installHint();
    out += `<section class="hero"><small>${fmtDay.format(now)}</small><h2>${partOfDay(h)}${S.profile.name ? ', ' + esc(S.profile.name) : ''}!</h2></section>`;
    if (!S.profile.birth) out += `<section class="card hello"><h3>Добро пожаловать! 👋</h3><p>Укажите имя и дату рождения малыша — приложение посчитает возраст и составит календарь прививок.</p><button class="btn primary" data-act="settings">Заполнить профиль</button></section>`;
    // Вечером показываем наступающую ночь, днём — прошедшую
    const ns0 = nightSchedule(), lateNight = minOfDay(now) < ns0.wake - 30; // глубокая ночь до подъёма — это «эта ночь» сегодняшней даты
    const evening = (!lateNight && minOfDay(now) >= ns0.bed - 240) || (S.timers.sleep && nightKey(S.timers.sleep.start) !== D && (S.timers.sleep.kind || autoKind(S.timers.sleep.start)) === 'night');
    const nightD = evening ? dateStr(addDays(t0, 1)) : D;
    const { night: n } = sleepsFor(nightD), { day: dd } = sleepsFor(D);
    out += `<section class="card sleep-card"><div class="card-head"><h3>Сон</h3><a href="#sleep" class="link">Все дни ›</a></div>
      ${sleepButton()}
      ${(() => { const nm = sleepNorm(); const nc = nm ? normCls(sleepDur(n), nm.night, nightDone(n)) : '', dc = nm ? normCls(sleepDur(dd), nm.day, dayDone(D)) : '';
        return `<div class="sleep-sum"><div class="night ${nc}"><small>${(evening || lateNight) ? 'Эта ночь' : 'Прошлая ночь'}</small><b>${n.length ? durS(sleepDur(n)) : '—'}</b>${nm ? `<em>норма ${normTxt(nm.night)}</em>` : ''}</div><div class="day ${dc}"><small>Днём сегодня</small><b>${dd.length ? durS(sleepDur(dd)) : '—'}</b>${nm ? `<em>норма ${normTxt(nm.day)}</em>` : ''}</div></div>`; })()}
      ${sleepBlocks(D, nightD, (evening || lateNight) ? 'Эта ночь' : 'Прошлая ночь')}</section>`;
    out += `<section class="quick">
      <button class="q feed" data-act="add-bottle">${I.bottle}<span>Бутылочка</span></button>
      <button class="q solid" data-act="add-solid">${I.bowl}<span>Прикорм</span></button>
      <button class="q stool" data-act="add-stool">${I.drop}<span>Стул</span></button>
      <button class="q growth" data-act="add-growth">${I.chart}<span>Рост и вес</span></button>
    </section>`;
    out += `<section class="stats">
      ${(() => {
        const nm = feedNorm(), et = eatenToday();
        if (!nm) return `<div class="stat feed"><small>Бутылочек сегодня</small><b>${bottles.length}</b><span>${ml ? ml + ' мл всего' : 'пока не было'}</span></div>`;
        return `<button class="stat feed" data-tab="feed"><small>Бутылочек сегодня</small><b>${bottles.length}</b><span>${et.ml} мл${et.g ? ' + ' + et.g + ' г' : ''} из ≈${nm.total}</span>${normBar(et.total, nm.total)}</button>`;
      })()}
      <div class="stat"><small>Последнее кормление</small><b>${lastFeed ? hhmm(lastFeed.start) : '—'}</b><span>${lastFeed ? ago(lastFeed.start) : '&nbsp;'}</span></div>
      <button class="stat stool" data-tab="stool"><small>Стул сегодня</small><b>${stoolsToday.length} ${pl(stoolsToday.length, ['раз', 'раза', 'раз'])}</b><span>${lastStool ? 'последний ' + (dayKey(lastStool.start) === D ? 'в ' + hhmm(lastStool.start) : fmtShort.format(lastStool.start)) : 'пока не было'}</span></button>
      ${lastStool && stoolWarn(lastStool) && lastStool.start > now - 3 * DAY ? `<button class="stat warn-stat" data-tab="stool"><small>Стул</small><b>⚠︎</b><span>был необычный — посмотрите</span></button>` : ''}
    </section>`;
    if (S.profile.birth) {
      const next = schedule().filter(v => !v.done).sort((a, b) => a.due - b.due)[0];
      if (next) out += `<section class="list"><button class="row" data-tab="vacc"><span class="dot vacc">${I.shield}</span><span class="row-main"><b>${esc(next.n)}</b><small>Ближайшая прививка · ${fmtLong.format(next.due)}</small></span>${next.st[1] ? `<span class="pill ${next.st[0]}">${next.st[1]}</span>` : ''}</button></section>`;
    }
    const other = ev.filter(e => e.type !== 'sleep');
    if (other.length) out += `<section class="day"><h3>Кормления, прикорм и стул сегодня</h3><div class="list">${[...other].sort((a, b) => b.start - a.start).map(evRow).join('')}</div></section>`;
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
      ${(() => { const nm = sleepNorm(), nMs = sleepDur(night), dMs = sleepDur(day), done = dayDone(D) && nightDone(night);
        const nc = nm ? normCls(nMs, nm.night, nightDone(night)) : '', dc = nm ? normCls(dMs, nm.day, dayDone(D)) : '', tc = nm ? normCls(nMs + dMs, nm.total, done) : '';
        return `<div class="sleep-sum"><div class="night ${nc}"><small>Ночью</small><b>${night.length ? durS(nMs) : '—'}</b>${nm ? `<em>норма ${normTxt(nm.night)}</em>` : ''}</div><div class="day ${dc}"><small>Днём</small><b>${day.length ? durS(dMs) : '—'}</b>${nm ? `<em>норма ${normTxt(nm.day)}</em>` : ''}</div><div class="${tc}"><small>Всего</small><b>${durS(nMs + dMs)}</b>${nm ? `<em>норма ${normTxt(nm.total)}</em>` : ''}</div></div>`; })()}
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
    const nm = feedNorm();
    if (nm) {
      const et = eatenToday(), left = Math.max(0, nm.total - et.total);
      const nLeft = left ? [Math.max(1, Math.floor(left / nm.perHi)), Math.max(1, Math.ceil(left / nm.perLo))] : null;
      out += `<section class="card norm-card"><h3>Норма на день</h3>
        <div class="norm-top"><b>${et.total}</b><span>из ≈ ${nm.total} мл</span></div>
        ${normBar(et.total, nm.total)}
        <p class="norm-line">${et.ml} мл смеси${et.g ? ` + ${et.g} г прикорма` : ''} · ${left ? `осталось ≈ ${left} мл — ${nLeft[0] === nLeft[1] ? nLeft[0] : nLeft[0] + '–' + nLeft[1]} ${pl(nLeft[1], ['кормление', 'кормления', 'кормлений'])} по ${nm.perLo}–${nm.perHi} мл` : 'норма на сегодня набрана'}</p>
        <div class="norm-facts">
          <span><small>Суточный объём</small><b>≈ ${nm.total} мл</b><em>${nm.basis}${nm.capped ? ', не больше 1 л' : ''}</em></span>
          <span><small>Кормлений</small><b>${nm.feeds}</b><em>в сутки для возраста</em></span>
          <span><small>За раз</small><b>${nm.perLo}–${nm.perHi} мл</b><em>обычно в этом возрасте</em></span>
        </div>
        ${nm.weight && nm.wAge > 30 ? `<p class="norm-warn">Вес взят из замера ${fmtShort.format(parseDate(nm.weight.date))} (${nm.wAge} дн. назад) — <button class="linkbtn" data-act="add-growth">добавьте свежий вес</button>, чтобы норма была точнее.</p>` : ''}
        ${!nm.weight ? `<p class="norm-warn"><button class="linkbtn" data-act="add-growth">Добавьте вес малыша</button> — норма будет рассчитана точнее.</p>` : ''}
        <p class="hint" style="margin:8px 0 0">${S.events.some(e => e.type === 'solid') ? 'Прикорм входит в суточный объём: чем больше съедено прикорма, тем меньше нужно смеси. ' : ''}Это ориентир (объёмный метод расчёта питания). Кормите по аппетиту и не заставляйте допивать — точную норму согласуйте с педиатром.</p>
      </section>`;
    }
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

  stool: stoolView,

  growth() {
    const g = [...S.growth].sort((a, b) => a.date.localeCompare(b.date));
    const M = { weight: ['Вес', 'кг', 2], height: ['Рост', 'см', 1], head: ['Голова', 'см', 1] };
    const lastOf = k => { const l = g.filter(x => x[k]); return [l[l.length - 1], l[l.length - 2]]; };
    const num = (v, d) => (+v).toFixed(d).replace('.', ',');
    let h = `<section class="stats" style="grid-template-columns:repeat(3,1fr)">${Object.entries(M).map(([k, [l, u, d]]) => {
      const [a, b] = lastOf(k);
      const delta = a && b ? a[k] - b[k] : 0;
      const dTxt = k === 'weight' ? Math.round(delta * 1000) + ' г' : num(delta, 1) + ' см';
      const wp = a ? whoPercentile(k, a[k], a.date) : null;
      return `<div class="stat growth"><small>${l}</small><b>${a ? num(a[k], d) : '—'}</b><span>${a ? u : '&nbsp;'}${delta ? ` <span class="delta">${delta > 0 ? '+' : ''}${dTxt}</span>` : ''}</span>${wp ? `<em class="who-pill ${wp.cls}">${wp.cls === 'ok' ? '✓ ' : ''}${pctTxt(wp)}%</em>` : ''}</div>`;
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
/* ---- Стандарты роста ВОЗ ---- */
const WHO_KEY = { weight: 'weight', height: 'height', head: 'head' };
const Z3 = 1.8808, Z15 = 1.0364; // 3-й и 97-й, 15-й и 85-й перцентили
function whoLMS(k, sex, day) {
  const rows = window.WHO_GROWTH && window.WHO_GROWTH[WHO_KEY[k]] && window.WHO_GROWTH[WHO_KEY[k]][sex];
  if (!rows || day < 0 || day > rows[rows.length - 1][0]) return null;
  let i = 1; while (i < rows.length - 1 && rows[i][0] < day) i++;
  const a = rows[i - 1], b = rows[i], f = b[0] === a[0] ? 0 : Math.max(0, Math.min(1, (day - a[0]) / (b[0] - a[0])));
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
}
const lmsVal = ([L, M, Sd], z) => (L ? M * Math.pow(1 + L * Sd * z, 1 / L) : M * Math.exp(Sd * z));
const lmsZ = ([L, M, Sd], x) => (L ? (Math.pow(x / M, L) - 1) / (L * Sd) : Math.log(x / M) / Sd);
function normCdf(z) { // Абрамовиц–Стиган
  const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
const ageDays = date => Math.round((parseDate(date).getTime() - parseDate(S.profile.birth).getTime()) / DAY);
// Перцентиль замера по ВОЗ: { pct, cls: 'ok' | 'low' | 'high' } или null
function whoPercentile(k, value, date) {
  const sex = S.profile.sex; if (!S.profile.birth || !sex || !value) return null;
  const lms = whoLMS(k, sex, ageDays(date)); if (!lms) return null;
  const z = lmsZ(lms, +value), pct = normCdf(z) * 100;
  return { pct, z, cls: pct < 3 ? 'low' : pct > 97 ? 'high' : 'ok' };
}
const pctTxt = p => (p.pct < 1 ? '<1' : p.pct > 99 ? '>99' : Math.round(p.pct));

function growthChart(g, k, [label, unit, dec]) {
  const sex = S.profile.sex, birth = S.profile.birth, hasWho = !!(birth && sex && window.WHO_GROWTH);
  const fmt = v => v.toFixed(dec).replace('.', ',');
  const W = 320, H = 190, L = 38, R = 12, T = 12, B = 26;
  if (!hasWho) {
    const pts = g.filter(x => x[k]).map(x => ({ t: parseDate(x.date).getTime(), v: +x[k] }));
    const ask = `<p class="norm-warn" style="margin-top:10px">${!birth ? 'Укажите дату рождения' : 'Укажите пол малыша'} в <button class="linkbtn" data-act="settings">настройках</button> — на графике появится коридор нормы ВОЗ.</p>`;
    if (!pts.length) return `<p class="empty">Нет данных: ${label.toLowerCase()}</p>` + ask;
    let t0 = pts[0].t, t1 = pts[pts.length - 1].t; if (t1 === t0) { t0 -= DAY * 15; t1 += DAY * 15; }
    let v0 = Math.min(...pts.map(p => p.v)), v1 = Math.max(...pts.map(p => p.v));
    const padV = (v1 - v0) * 0.15 || v1 * 0.05 || 1; v0 -= padV; v1 += padV;
    const x = t => L + (t - t0) / (t1 - t0) * (W - L - R), y = v => T + (1 - (v - v0) / (v1 - v0)) * (H - T - B);
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="График: ${label}">
      ${[v0 + padV, v1 - padV].map(v => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join('')}
      <polyline class="line" points="${pts.map(p => x(p.t) + ',' + y(p.v)).join(' ')}"/>
      ${pts.map(p => `<circle class="pt" cx="${x(p.t)}" cy="${y(p.v)}" r="4"/>`).join('')}
    </svg><p class="hint" style="margin:6px 0 0">${label}, ${unit}</p>` + ask;
  }
  // Ось X — возраст в днях, с коридором нормы ВОЗ
  const pts = g.filter(x => x[k] && x.date >= birth).map(x => ({ a: ageDays(x.date), v: +x[k], date: x.date }));
  const nowA = ageDays(todayStr());
  const ages = pts.map(p => p.a).concat(nowA);
  let a0 = Math.max(0, Math.min(...ages) - 30), a1 = Math.min(1826, Math.max(...ages) + 45);
  if (a1 - a0 < 150) a0 = Math.max(0, a1 - 150);
  const N = 48, samp = [];
  for (let i = 0; i <= N; i++) { const a = a0 + (a1 - a0) * i / N, lms = whoLMS(k, sex, a); if (lms) samp.push({ a, lo3: lmsVal(lms, -Z3), lo15: lmsVal(lms, -Z15), m: lms[1], hi15: lmsVal(lms, Z15), hi97: lmsVal(lms, Z3) }); }
  if (!samp.length) return `<p class="empty">Нет данных ВОЗ для этого возраста</p>`;
  let v0 = Math.min(...samp.map(s => s.lo3), ...pts.map(p => p.v)), v1 = Math.max(...samp.map(s => s.hi97), ...pts.map(p => p.v));
  const pad = (v1 - v0) * 0.06; v0 -= pad; v1 += pad;
  const x = a => L + (a - a0) / (a1 - a0) * (W - L - R), y = v => T + (1 - (v - v0) / (v1 - v0)) * (H - T - B);
  const band = (lo, hi) => samp.map(s => `${x(s.a).toFixed(1)},${y(s[hi]).toFixed(1)}`).concat([...samp].reverse().map(s => `${x(s.a).toFixed(1)},${y(s[lo]).toFixed(1)}`)).join(' ');
  // Подписи оси X — месяцы
  const mStep = (a1 - a0) / 30.44 > 14 ? 6 : (a1 - a0) / 30.44 > 7 ? 2 : 1;
  const xt = []; for (let m = Math.ceil(a0 / 30.44); m * 30.44 <= a1; m++) if (m % mStep === 0) xt.push(m);
  const nice = (v1 - v0) > 20 ? 5 : (v1 - v0) > 8 ? 2 : (v1 - v0) > 3 ? 1 : 0.5;
  const yt = []; for (let v = Math.ceil(v0 / nice) * nice; v <= v1; v += nice) yt.push(v);
  const last = pts[pts.length - 1], lp = last ? whoPercentile(k, last.v, last.date) : null;
  const who = sex === 'f' ? 'девочек' : 'мальчиков';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="График: ${label} и норма ВОЗ">
    ${yt.map(v => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(nice < 1 ? 1 : 0).replace('.', ',')}</text>`).join('')}
    <polygon class="band97" points="${band('lo3', 'hi97')}"/>
    <polygon class="band85" points="${band('lo15', 'hi15')}"/>
    <polyline class="median" points="${samp.map(s => x(s.a).toFixed(1) + ',' + y(s.m).toFixed(1)).join(' ')}"/>
    ${xt.map(m => `<text x="${x(m * 30.44)}" y="${H - 6}" text-anchor="middle">${m < 12 ? m + ' мес' : (m % 12 ? (m / 12).toFixed(1).replace('.', ',') : m / 12) + (m < 24 ? ' год' : ' г.')}</text>`).join('')}
    ${pts.length > 1 ? `<polyline class="line" points="${pts.map(p => x(p.a) + ',' + y(p.v)).join(' ')}"/>` : ''}
    ${pts.map(p => `<circle class="pt" cx="${x(p.a)}" cy="${y(p.v)}" r="4"/>`).join('')}
  </svg>
  <div class="who-legend"><span><i class="lg97"></i>норма ВОЗ (3–97%)</span><span><i class="lg85"></i>чаще всего (15–85%)</span><span><i class="lgm"></i>медиана</span></div>
  ${lp ? `<p class="who-now ${lp.cls}"><b>${fmt(last.v)} ${unit} — ${pctTxt(lp)}-й перцентиль</b><br>${lp.cls === 'ok' ? `В пределах нормы ВОЗ для ${who} этого возраста.` : lp.cls === 'low' ? `Ниже коридора нормы ВОЗ — стоит обсудить с педиатром.` : `Выше коридора нормы ВОЗ — стоит обсудить с педиатром.`} Из 100 ${who} этого возраста примерно у ${Math.max(1, Math.min(99, Math.round(lp.pct)))} ${label.toLowerCase() === 'голова' ? 'окружность головы' : label.toLowerCase()} меньше.</p>` : `<p class="hint" style="margin:8px 0 0">Добавьте замер — точка появится на графике.</p>`}
  <p class="hint" style="margin:6px 0 0">Важнее не точное место в коридоре, а то, что малыш растёт «по своей линии». Резкие переходы через несколько линий стоит показать педиатру. Стандарты роста ВОЗ, 2006.</p>`;
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
// Идущий сон: поправить «Уснул», тип сна или сразу указать «Проснулся»
function liveSleepForm() {
  const t = S.timers.sleep; if (!t) return;
  const now = Date.now();
  openSheet('Идущий сон',
    group('Тип сна', seg('kind', [['day', 'Дневной'], ['night', 'Ночной']], t.kind || autoKind(t.start))) +
    field('Уснул', `<input type="datetime-local" name="start" value="${dtl(t.start)}" max="${dtl(now)}" required>`) +
    `<div class="chips">${[5, 10, 15, 20, 30, 45].map(n => `<button type="button" class="chip" data-ago="${n}">${n} мин назад</button>`).join('')}</div>` +
    field('Проснулся', `<input type="datetime-local" name="end" value="" max="${dtl(now)}">`, 'Оставьте пустым, если малыш ещё спит. Если уже проснулся — укажите время, и сон сохранится.'),
    fd => {
      const cur = S.timers.sleep;
      if (!cur) { toast('Сон уже завершён на другом телефоне'); return; }
      const now2 = Date.now(), start = parseDtl(fd.start), end = fd.end ? parseDtl(fd.end) : null;
      if (!start) return false;
      if (start > now2 + MIN) { toast('Время «Уснул» не может быть в будущем'); return false; }
      if (now2 - start > 16 * HOUR) { toast('Сон дольше 16 часов — проверьте дату'); return false; }
      if (end != null) {
        if (end <= start) { toast('«Проснулся» должно быть позже «Уснул»'); return false; }
        if (end > now2 + MIN) { toast('Время «Проснулся» не может быть в будущем'); return false; }
        delete S.timers.sleep;
        S.events.push({ id: uid(), type: 'sleep', start, end, kind: fd.kind });
        toast('Сон записан · ' + dur(end - start));
      } else {
        S.timers.sleep = { ...cur, start, kind: fd.kind };
        toast('Время сна исправлено');
      }
    }, { ok: 'Сохранить' });
}
function sleepForm(e, preset = {}) {
  const isNew = !e;
  let v = e;
  if (!v) {
    const D = preset.d || todayStr(), kind = preset.kind || autoKind(Date.now()), now = Date.now();
    if (kind === 'night') {
      const ns = nightSchedule();
      const s = parseDate(D); s.setDate(s.getDate() - 1); s.setHours(Math.floor(ns.bed / 60), ns.bed % 60, 0, 0);
      const en = parseDate(D); en.setHours(Math.floor(ns.wake / 60), ns.wake % 60, 0, 0);
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
    group('Пол', seg('sex', [['f', 'Девочка'], ['m', 'Мальчик']], p.sex || '')) +
    group('Тема', seg('theme', [['auto', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']], p.theme || 'auto')) +
    sleepSettingsBlock() +
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
    fd => {
      applySettings(fd);
      setAlertPrefs({ sound: !!fd.al_sound, shortcut: !!fd.al_shortcut });
      toast('Сохранено');
    });
  settingsInit = formValues();
}

// Настройки сохраняют только то, что вы поменяли в форме.
// Иначе форма, открытая до прихода данных с другого телефона (например, сразу после «Присоединиться»),
// записала бы в общее облако пустое имя и дату рождения.
let settingsInit = null;
function formValues() { const f = dlg.querySelector('form'); return f ? Object.fromEntries(new FormData(f)) : {}; }
function applySettings(fd) {
  const init = settingsInit || {};
  const changed = k => fd[k] !== undefined && String(fd[k]) !== String(init[k] ?? '');
  const P = {};
  if (changed('name')) P.name = String(fd.name).trim();
  if (changed('birth')) P.birth = fd.birth;
  if (changed('theme')) P.theme = fd.theme;
  if (changed('sex')) P.sex = fd.sex;
  const sc = { ...sleepCfg() };
  let scDirty = false;
  const set = (key, val) => { sc[key] = val; scDirty = true; };
  if (changed('sc_mode')) set('mode', fd.sc_mode);
  // Включили «Своё» — берём окно из формы целиком; иначе только изменённые поля
  if (changed('sc_lo') || (changed('sc_mode') && fd.sc_mode === 'custom')) set('lo', +fd.sc_lo);
  if (changed('sc_hi') || (changed('sc_mode') && fd.sc_mode === 'custom')) set('hi', +fd.sc_hi);
  if (changed('sc_rem')) set('remind', +fd.sc_rem);
  if (changed('sc_nm')) set('nightMode', fd.sc_nm);
  if (changed('sc_bed') || (changed('sc_nm') && fd.sc_nm === 'manual')) set('bedtime', fd.sc_bed);
  if (changed('sc_wake') || (changed('sc_nm') && fd.sc_nm === 'manual')) set('wake', fd.sc_wake);
  if (scDirty) { if (+sc.lo > +sc.hi) [sc.lo, sc.hi] = [sc.hi, sc.lo]; P.sleepCfg = sc; }
  if (Object.keys(P).length) Object.assign(S.profile, P);
  settingsInit = { ...init, ...fd };
  return Object.keys(P).length > 0;
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
    <button type="button" class="btn" data-x="sync-reconnect">${I.refresh} Переподключить</button>
    <button type="button" class="btn" data-x="sync-share">Отправить код</button>
    <button type="button" class="btn ghost danger" data-x="sync-off">Отключить на этом телефоне</button></div>`;
}

// Сохраняем имя/дату/тему, введённые в настройках, перед перерисовкой шторки
// Пришли данные с другого телефона, пока открыты Настройки: обновляем поля, которые вы не трогали
function refreshSettingsFields() {
  const f = dlg.querySelector('form'); if (!f || !f.elements.birth || !settingsInit) return;
  ['name', 'birth'].forEach(k => {
    const el = f.elements[k], v = S.profile[k] || '';
    if (el && el.value === String(settingsInit[k] ?? '') && el.value !== v) { el.value = v; settingsInit[k] = v; }
  });
}
function keepSettingsFields() {
  const f = dlg.querySelector('form'); if (!f || !f.elements.birth) return;
  if (applySettings(formValues())) save();
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
  'edit-live': () => liveSleepForm(),
  'sleep-cancel': () => { if (confirm('Отменить сон без сохранения?')) { delete S.timers.sleep; save(); render(); } },
  'add-sleep': t => sleepForm(null, { d: t.dataset.d, kind: t.dataset.kind }),
  'add-bottle': () => bottleForm(), 'add-solid': () => solidForm(), 'add-growth': () => growthForm(),
  'add-serving': t => { const p = allProducts().find(x => x.key === t.dataset.key); solidForm(null, { food: p ? p.name : '' }); },
  'add-product': () => addProductForm(),
  'add-stool': () => stoolForm(),
  'add-custom': () => customForm(), 'mark-past': markPast,
  settings: settingsForm, whatsnew: whatsNew,
  report: () => window.reportForm && window.reportForm(),
};
const FORMS = { bottle: bottleForm, solid: solidForm, sleep: sleepForm, stool: stoolForm };

document.addEventListener('click', e => {
  const t = e.target.closest('[data-act],[data-ev],[data-gr],[data-vk],[data-ck],[data-sp],[data-spc],[data-day],[data-metric],[data-tab],[data-close],[data-del],[data-ml],[data-g],[data-ago],[data-fill],[data-x]');
  if (!t) return;
  const d = t.dataset;
  if (d.act && ACTIONS[d.act]) return ACTIONS[d.act](t);
  if (d.spc) return toggleProduct(d.spc);
  if (d.sp) return productForm(d.sp);
  if (d.day) { const n = dateStr(addDays(parseDate(sleepDay).getTime(), +d.day)); sleepDay = n > todayStr() ? todayStr() : n; return render(); }
  if (d.fill) { const f = dlg.querySelector(`[name=${d.fill}]`); if (f) f.value = todayStr(); if (d.fill === 'done') { const st = dlg.querySelector('[name=start]'); if (st && !st.value) st.value = todayStr(); } return; }
  if (d.g) { const f = dlg.querySelector('[name=grams]'); if (f) f.value = d.g; return; }
  if (d.ago) { const f = dlg.querySelector('[name=start]'); if (f) f.value = dtl(Date.now() - (+d.ago) * MIN); return; }
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
  if (d.x === 'sync-reconnect') { if (window.Sync) { window.Sync.reconnect(); toast('Переподключаюсь…'); } return; }
  if (d.x === 'sync-off') {
    if (confirm('Отключить синхронизацию на этом телефоне? Записи останутся, но перестанут обновляться.')) { window.Sync.leave(); settingsForm(); }
    return;
  }
  if (d.x === 'notify-on') { keepSettingsFields(); askNotify().then(() => settingsForm()); return; }
  if (d.x === 'ios-timer') {
    const m = Math.max(1, +t.dataset.min || 1);
    location.href = 'shortcuts://run-shortcut?name=' + encodeURIComponent('Малыш таймер') + '&input=text&text=' + m;
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
window.addEventListener('hashchange', () => { tab = location.hash.slice(1) || 'today'; if (tab === 'sleep') sleepDay = todayStr(); resetScroll = true; render(); });
window.addEventListener('storage', e => { if (e.key === KEY) { S = load(); if (!dlg.open) render(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { S = load(); if (!dlg.open) render(); checkUpdate(false); } });
// Пока приложение открыто — проверяем обновления каждые 10 минут
setInterval(() => { if (!document.hidden && Date.now() - lastCheck > 9 * 60 * 1000) checkUpdate(false); }, 60 * 1000);
setInterval(tick, 1000);
setInterval(checkAlerts, 20000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkAlerts(); });
setInterval(() => { if (!dlg.open) render(); }, 30000);
render();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (location.protocol !== 'file:') { checkUpdate(false); showUpdatedOnce(); }
