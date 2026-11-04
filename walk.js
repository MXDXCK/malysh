'use strict';
/*
 * Прогулка: погода по геолокации (Open-Meteo, без ключа) → что надеть малышу.
 * Правила — по рекомендациям педиатров: ориентир на ощущаемую температуру (с ветром),
 * в коляске малыш не двигается — нужен на слой больше, чем взрослому; слои: хлопок → флис/шерсть → комбинезон/конверт.
 * Настройки и место хранятся только на этом телефоне.
 */

const WK_KEY = 'malysh.walk';
const WK_CACHE = 'malysh.walk.weather';
function wkPrefs() { try { return { mode: 'stroller', pref: 0, ...(JSON.parse(localStorage.getItem(WK_KEY) || '{}')) }; } catch (e) { return { mode: 'stroller', pref: 0 }; } }
function wkSave(p) { try { localStorage.setItem(WK_KEY, JSON.stringify({ ...wkPrefs(), ...p })); } catch (e) { /* */ } }
function wkCached() { try { return JSON.parse(localStorage.getItem(WK_CACHE) || 'null'); } catch (e) { return null; } }

/* ---- Погода ---- */
const WMO = c => (c === 0 ? ['Ясно', '☀️'] : c <= 2 ? ['Малооблачно', '🌤'] : c === 3 ? ['Пасмурно', '☁️'] : c <= 48 ? ['Туман', '🌫'] :
  c <= 57 ? ['Морось', '🌦'] : c <= 67 ? ['Дождь', '🌧'] : c <= 77 ? ['Снег', '🌨'] : c <= 82 ? ['Ливень', '🌧'] : c <= 86 ? ['Снегопад', '🌨'] : ['Гроза', '⛈']);
const isRain = c => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;
const isSnow = c => (c >= 71 && c <= 77) || c === 85 || c === 86;
let wkLoading = false, wkError = '', wkLastTry = 0, wkRun = 0;

// Ограничение по времени: iPhone иногда не отвечает на запрос геолокации вовсе,
// а встроенный timeout геолокации начинает отсчёт только после разрешения.
const wkTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(msg), { timeout: true })), ms))]);
async function wkGet(url, ms = 12000) {
  const ctl = window.AbortController ? new AbortController() : null;
  const t = setTimeout(() => ctl && ctl.abort(), ms);
  try {
    const r = await wkTimeout(fetch(url, ctl ? { signal: ctl.signal } : {}), ms + 500, 'net-timeout');
    if (!r.ok) throw new Error('net ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function wkFetch(lat, lon) {
  const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(3) + '&longitude=' + lon.toFixed(3) +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m,is_day,uv_index' +
    '&hourly=temperature_2m,apparent_temperature,precipitation_probability,weather_code,wind_speed_10m' +
    '&forecast_hours=6&wind_speed_unit=ms&timezone=auto';
  const j = await wkGet(u), c = j.current;
  const hours = (j.hourly && j.hourly.time || []).map((t, i) => ({ t, temp: j.hourly.temperature_2m[i], feels: j.hourly.apparent_temperature[i], pop: j.hourly.precipitation_probability[i], code: j.hourly.weather_code[i], wind: j.hourly.wind_speed_10m[i] }));
  return { at: Date.now(), temp: c.temperature_2m, feels: c.apparent_temperature, hum: c.relative_humidity_2m, prec: c.precipitation, code: c.weather_code, cloud: c.cloud_cover, wind: c.wind_speed_10m, gust: c.wind_gusts_10m, day: c.is_day, uv: c.uv_index, hours };
}
async function wkPlace(lat, lon) {
  try {
    const j = await wkGet(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=ru`, 8000);
    return j.city || j.locality || j.principalSubdivision || '';
  } catch (e) { return ''; }
}
function wkLocate() {
  return wkTimeout(new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('nogeo'));
    navigator.geolocation.getCurrentPosition(p => res([p.coords.latitude, p.coords.longitude]),
      e => rej(Object.assign(new Error(e.code === 1 ? 'denied' : 'unavailable'), { geo: e.code })), { enableHighAccuracy: false, timeout: 15000, maximumAge: 60 * MIN });
  }), 20000, 'geo-timeout');
}
const WK_MSG = {
  denied: 'Нет доступа к геолокации. Включите: Настройки iPhone → Конфиденциальность и безопасность → Службы геолокации → Сайты Safari → «При использовании». Или просто выберите город.',
  'geo-timeout': 'iPhone не сообщил местоположение за 20 секунд. Выберите город — это быстрее и работает всегда.',
  unavailable: 'Не удалось определить место. Выберите город вручную.',
  nogeo: 'На этом устройстве геолокация недоступна. Выберите город.',
  net: 'Не удалось загрузить погоду — нет интернета? Попробуйте ещё раз.',
};
// relocate: запросить место заново (по кнопке); иначе — по сохранённым координатам
async function wkRefresh(relocate) {
  if (wkLoading) return;
  const run = ++wkRun; wkLoading = true; wkError = ''; wkRerender();
  const stale = () => run !== wkRun; // нажали «Отмена» или запустили заново
  try {
    let p = wkPrefs();
    if (relocate || p.lat == null) {
      try {
        const [lat, lon] = await wkLocate();
        if (stale()) return;
        const moved = p.lat == null || Math.abs(lat - p.lat) > 0.05 || Math.abs(lon - p.lon) > 0.05;
        wkSave({ lat, lon, manual: false, ...(moved ? { place: '' } : {}) }); p = wkPrefs();
        if (moved || !p.place) wkPlace(lat, lon).then(place => { if (place && !stale()) { wkSave({ place }); wkRerender(); } }); // не ждём — название подпишется позже
      } catch (e) {
        if (stale()) return;
        if (p.lat == null) throw e;
        wkError = (e.message === 'denied' ? 'Нет доступа к геолокации' : 'iPhone не сообщил местоположение') + ' — показываю погоду для прошлого места' + (p.place ? ' (' + p.place + ')' : '') + '.';
      }
    }
    const w = await wkFetch(p.lat, p.lon);
    if (stale()) return;
    localStorage.setItem(WK_CACHE, JSON.stringify(w));
  } catch (e) {
    if (stale()) return;
    wkError = WK_MSG[e.message] || (/net|fetch|Failed|Load|abort/i.test(e.message) ? WK_MSG.net : WK_MSG.unavailable);
  }
  if (stale()) return;
  wkLoading = false; wkRerender();
}
function wkCancel() { wkRun++; wkLoading = false; wkError = ''; wkRerender(); }
function wkRerender() {
  if (dlg.open && dlg.querySelector('.walk-sheet')) walkSheet(true);
  else if (!dlg.open && (location.hash || '#today') === '#today') render();
}
async function wkCity(name) {
  const j = await wkGet('https://geocoding-api.open-meteo.com/v1/search?count=5&language=ru&name=' + encodeURIComponent(name), 10000);
  return (j.results || []).map(x => ({ name: x.name, region: [x.admin1, x.country].filter(Boolean).join(', '), lat: x.latitude, lon: x.longitude }));
}

/* ---- Что надеть ---- */
// Комплекты по «эффективной» температуре (ощущаемая + поправки), для малыша в коляске
const OUTFITS = [
  { min: 25, title: 'Лёгкая одежда', items: [['👕', 'Боди с коротким рукавом или лёгкий хлопковый песочник'], ['👒', 'Панама с полями'], ['🧺', 'Тонкая муслиновая пелёнка — подстелить, не накрывать']] },
  { min: 20, title: 'Один тонкий слой', items: [['👕', 'Тонкий хлопковый слип или боди с длинным рукавом'], ['👒', 'Панама или тонкая хлопковая шапочка'], ['🧺', 'Муслиновая пелёнка под рукой']] },
  { min: 15, title: 'Два тонких слоя', items: [['👕', 'Хлопковый слип'], ['🧶', 'Тонкая кофта или трикотажный комбинезон'], ['🧢', 'Тонкая шапочка'], ['🧦', 'Носочки'], ['🛏', 'Лёгкое одеяло или плед']] },
  { min: 10, title: 'Лёгкий демисезон', items: [['👕', 'Хлопковый слип'], ['🧶', 'Флисовый или трикотажный комбинезон'], ['🧥', 'Лёгкий демисезонный комбинезон'], ['🧢', 'Трикотажная шапка'], ['🛏', 'Плед']] },
  { min: 5, title: 'Утеплённый демисезон', items: [['👕', 'Хлопковый слип'], ['🧶', 'Флис или тонкая шерсть'], ['🧥', 'Утеплённый демисезонный комбинезон'], ['🧢', 'Тёплая шапка, закрывающая уши'], ['🧦', 'Тёплые носки или пинетки'], ['🛏', 'Плед или конверт']] },
  { min: -3, title: 'Тёплый комплект', items: [['👕', 'Хлопковый слип'], ['🧶', 'Флис или шерсть'], ['🧥', 'Тёплый комбинезон или демисезонный + конверт'], ['🧢', 'Тонкая шапочка + тёплая шапка'], ['🧤', 'Варежки и тёплые пинетки'], ['🛏', 'Плед']] },
  { min: -10, title: 'Зимний комплект', items: [['👕', 'Хлопковый слип'], ['🧶', 'Шерстяной или флисовый комбинезон'], ['🧥', 'Зимний комбинезон или зимний конверт'], ['🧢', 'Тонкая шапочка + зимняя шапка'], ['🧤', 'Тёплые варежки и пинетки'], ['🛏', 'Плед или меховой вкладыш']] },
  { min: -50, title: 'Зимний + конверт', items: [['👕', 'Хлопковый слип или термобельё'], ['🧶', 'Шерстяной комбинезон'], ['🧥', 'Зимний комбинезон + зимний конверт'], ['🧢', 'Тонкая шапочка + зимняя шапка, капюшон'], ['🧤', 'Тёплые варежки и пинетки'], ['🛏', 'Плед поверх']] },
  { min: -99, title: 'Лучше не гулять', danger: true, items: [['🏠', 'Детям до года в такой мороз гулять обычно не советуют — лучше перенести прогулку или погулять 10–15 минут у дома'], ['🧥', 'Если всё же выходите — максимум слоёв: термобельё, шерсть, зимний комбинезон, конверт, плед']] },
];
function wkAdvice(w) {
  const p = wkPrefs(), m = ageMonths();
  // Таблицы рассчитаны на малыша в коляске («на слой больше, чем взрослому» уже учтено).
  // В слинге греет тело взрослого; самым маленьким — потеплее
  let eff = w.feels;
  if (p.mode === 'carrier') eff += 3;
  if (m != null && m < 3) eff -= 2;
  eff += (+p.pref || 0) * 3; // «мёрзнет» → pref = -1 → холоднее, «потеет» → +1
  // Опасный мороз — по ощущаемой температуре на улице (педиатры называют от −10 до −15° для детей до года)
  const dangerAt = m != null && m < 3 ? -7 : -12;
  const o = w.feels <= dangerAt ? OUTFITS[OUTFITS.length - 1] : OUTFITS.find(x => !x.danger && eff >= x.min) || OUTFITS[OUTFITS.length - 2];
  const items = o.items.slice();
  if (p.mode === 'carrier' && !o.danger) {
    const i = items.findIndex(x => x[0] === '🛏');
    if (i >= 0) items[i] = ['🧥', eff < 5 ? 'Слингокуртка или утеплённая накидка на слинг вместо пледа' : 'Накидка на слинг при ветре'];
  }
  const tips = [];
  const rain = isRain(w.code) || w.prec > 0.1, snow = isSnow(w.code);
  const windy = w.wind >= 7 || w.gust >= 12;
  if (rain) tips.push(['☔', p.mode === 'stroller' ? 'Дождевик на коляску' : 'Непромокаемая накидка или зонт']);
  else if (snow && p.mode === 'stroller') tips.push(['🌨', 'Накидка от снега на коляску']);
  if (windy) tips.push(['💨', `Ветер ${Math.round(w.wind)} м/с${w.gust >= 12 ? `, порывы до ${Math.round(w.gust)}` : ''} — ${p.mode === 'stroller' ? 'поднимите капюшон коляски, ветрозащитная накидка' : 'закройте малыша от ветра'}, выбирайте места без сквозняков`]);
  const sunny = w.day && w.cloud < 40 && w.code <= 2;
  if (sunny && w.temp >= 15) tips.push(['😎', 'Солнце: панама, козырёк коляски, тень. Не накрывайте коляску пелёнкой — внутри станет жарко' + (m != null && m < 6 ? '. До 6 месяцев солнцезащитный крем не используют — только тень и одежда' : '')]);
  if (w.uv >= 6 && w.day) tips.push(['🔆', `Сильное солнце (УФ-индекс ${Math.round(w.uv)}) — с 11 до 16 часов лучше в тени`]);
  if (w.feels <= -3 || (windy && w.temp <= 2)) tips.push(['🧴', 'Жирный крем от мороза и ветра на щёки и нос за 30 минут до выхода']);
  if (w.feels >= 27) tips.push(['💧', 'Жара: гуляйте утром и вечером, возьмите воду или смесь, проверяйте шею каждые 10–15 минут']);
  if (w.temp > -5 && w.temp < 6 && w.hum >= 85 && !rain) tips.push(['🌫', 'Сыро — в такую погоду мёрзнут быстрее, чем кажется по градуснику']);
  // Как изменится погода за время прогулки
  const later = (w.hours || []).slice(1, 3);
  if (later.length) {
    const min = Math.min(...later.map(h => h.feels)), rainSoon = later.some(h => h.pop >= 60 || isRain(h.code));
    if (min <= w.feels - 3) tips.push(['📉', `Через 1–2 часа похолодает до ${Math.round(min)}° по ощущениям — возьмите плед потеплее`]);
    if (rainSoon && !rain) tips.push(['🌂', 'Скоро возможен дождь — возьмите дождевик']);
  }
  const dur = o.danger ? '10–15 минут' : w.feels >= 27 ? '30–60 минут, в тени' : eff >= 0 ? '1,5–2 часа' : eff >= -5 ? '1–1,5 часа' : '30–60 минут';
  return { eff, outfit: o, items, tips, dur };
}

/* ---- Карточка на главной ---- */
function walkCard() {
  const w = wkCached(), p = wkPrefs();
  if (!w) {
    return `<section class="card walk-card"><div class="card-head"><h3>Прогулка</h3></div>
      <p class="hint" style="margin:0 0 10px">Покажу погоду рядом с вами и подскажу, как одеть малыша: с учётом ветра, солнца, дождя и возраста.</p>
      ${wkError ? `<p class="norm-warn" style="margin:0 0 10px">${esc(wkError)}</p>` : ''}
      <div class="actions-row">${wkLoading ? `<button class="btn primary" disabled>Определяю место…</button><button class="btn" data-wk="cancel">Отмена</button>` : `<button class="btn primary" data-wk="locate">📍 Показать погоду рядом</button>`}<button class="btn" data-wk="more">Выбрать город</button></div>
      ${wkLoading ? '<p class="hint" style="margin:8px 0 0">Если iPhone спросит разрешение — нажмите «Разрешить». Не получится за 20 секунд — подскажу, что делать.</p>' : ''}</section>`;
  }
  if (Date.now() - w.at > 20 * MIN && !wkLoading && navigator.onLine !== false && Date.now() - wkLastTry > 2 * MIN) { wkLastTry = Date.now(); setTimeout(() => wkRefresh(false), 0); }
  const a = wkAdvice(w), [wt, wi] = WMO(w.code);
  return `<section class="card walk-card ${a.outfit.danger ? 'danger' : ''}"><div class="card-head"><h3>Прогулка</h3><button class="link" data-wk="more">Подробнее ›</button></div>
    ${wkError ? `<p class="norm-warn" style="margin:0 0 10px">${esc(wkError)}</p>` : ''}
    <button class="wk-weather" data-wk="more"><span class="wk-ico">${wi}</span><span><b>${Math.round(w.temp)}°</b> <em>ощущается ${Math.round(w.feels)}°</em><small>${wt} · ветер ${Math.round(w.wind)} м/с${p.place ? ' · ' + esc(p.place) : ''}</small></span></button>
    <div class="wk-out"><small>Что надеть · ${a.outfit.title.toLowerCase()}</small><p class="wk-eff">${p.mode === 'carrier' ? 'В слинге' : 'В коляске'} малыш ощущает ≈ ${Math.round(a.eff)}°${p.pref ? (p.pref < 0 ? ' (учли, что мёрзнет)' : ' (учли, что потеет)') : ''}</p>
      <ul>${a.items.map(([i, t]) => `<li><span>${i}</span>${esc(t)}</li>`).join('')}</ul></div>
    ${a.tips.length ? `<ul class="wk-tips">${a.tips.slice(0, 3).map(([i, t]) => `<li><span>${i}</span>${esc(t)}</li>`).join('')}</ul>` : ''}
    <p class="hint" style="margin:8px 0 0">Гулять: ${a.dur}. Проверяйте затылок и шею: тёплые и сухие — всё хорошо${wkLoading ? ' · обновляю погоду…' : ''}.</p></section>`;
}

/* ---- Подробнее: прогноз, советы, настройки ---- */
function walkSheet(refresh) {
  const w = wkCached(), p = wkPrefs(), a = w ? wkAdvice(w) : null;
  const body = `<div class="walk-sheet">
    ${w ? `<div class="wk-hours">${(w.hours || []).slice(0, 6).map(h => { const [, ic] = WMO(h.code); return `<div><small>${h.t.slice(11, 16)}</small><span>${ic}</span><b>${Math.round(h.temp)}°</b><em>${Math.round(h.feels)}°</em>${h.pop ? `<i>💧${h.pop}%</i>` : '<i>&nbsp;</i>'}</div>`; }).join('')}</div>
      <p class="muted" style="font-size:13px">Обновлено в ${hhmm(w.at)}${p.place ? ' · ' + esc(p.place) : ''}. Влажность ${w.hum}%, облачность ${w.cloud}%${w.uv != null ? ', УФ-индекс ' + Math.round(w.uv) : ''}.</p>
      ${a.tips.length ? `<ul class="wk-tips">${a.tips.map(([i, t]) => `<li><span>${i}</span>${esc(t)}</li>`).join('')}</ul>` : ''}` : `<p class="muted">Погода ещё не загружена.</p>`}
    ${wkError ? `<p class="norm-warn">${esc(wkError)}</p>` : ''}
    ${group('Как гуляем', seg('wk_mode', [['stroller', '🛒 В коляске'], ['carrier', '🤱 В слинге / на руках']], p.mode))}
    ${group('Малыш обычно', seg('wk_pref', [['-1', '🥶 Мёрзнет'], ['0', 'Как все'], ['1', '🥵 Потеет']], String(p.pref || 0)))}
    <div class="actions-row">${wkLoading ? `<button type="button" class="btn" disabled>Обновляю…</button><button type="button" class="btn ghost" data-wk="cancel">Отмена</button>` : `<button type="button" class="btn" data-wk="locate">📍 Моё место сейчас</button>`}</div>
    <label class="field"><span>Или найдите город</span><input name="wk_city" placeholder="Например, Самара" autocomplete="off"></label>
    <div class="actions-row"><button type="button" class="btn small" data-wk="city">Найти</button></div>
    <div class="wk-found"></div>
    <details class="tips"><summary>Как понять, что малышу комфортно</summary><ul>
      <li>Трогайте затылок и шею, а не руки и нос: тёплые и сухие — хорошо; влажные, горячие — перегрелся; прохладные — замёрз.</li>
      <li>Розовая кожа — норма. Красное лицо и пыхтение — жарко. Бледная или синеватая кожа — холодно, пора домой.</li>
      <li>Малышу в коляске нужен на один слой больше, чем вам: он лежит и не двигается.</li>
      <li>Несколько тонких слоёв лучше одного толстого: так проще снять лишнее.</li>
      <li>Ориентируйтесь на ощущаемую температуру: ветер 10 м/с превращает −5° в −15°.</li>
    </ul><p class="hint">Подсказки основаны на рекомендациях педиатров и общих правилах. Если малыш болеет или родился недоношенным — уточните у врача.</p></details>
  </div>`;
  openSheet('Прогулка', body, fd => {
    wkSave({ mode: fd.wk_mode || 'stroller', pref: +fd.wk_pref || 0 });
    toast('Сохранено');
  }, { ok: 'Сохранить' });
}

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-wk]'); if (!b) return;
  const act = b.dataset.wk;
  if (act === 'locate') { wkRefresh(true); return; }
  if (act === 'cancel') { wkCancel(); return; }
  if (act === 'more') { walkSheet(); return; }
  if (act === 'city') {
    const q = (dlg.querySelector('[name=wk_city]') || {}).value || ''; const box = dlg.querySelector('.wk-found');
    if (!q.trim()) return;
    box.innerHTML = '<p class="muted">Ищу…</p>';
    try {
      const list = await wkCity(q.trim());
      box.innerHTML = list.length ? list.map((c, i) => `<button type="button" class="row" data-wk="pick" data-i="${i}"><span class="row-main"><b>${esc(c.name)}</b><small>${esc(c.region)}</small></span></button>`).join('') : '<p class="muted">Ничего не нашлось</p>';
      box._list = list;
    } catch (er) { box.innerHTML = '<p class="muted">Не удалось найти — нет интернета?</p>'; }
    return;
  }
  if (act === 'pick') {
    const box = dlg.querySelector('.wk-found'), c = box && box._list && box._list[+b.dataset.i]; if (!c) return;
    wkSave({ lat: c.lat, lon: c.lon, place: c.name, manual: true });
    if (wkLoading) wkCancel();
    await wkRefresh(false); return;
  }
});
window.walkCard = walkCard;
// app.js уже нарисовал экран без карточки: перерисуем сейчас или сразу после закрытия открытого окна
if (dlg.open) renderPending = true; else render();
