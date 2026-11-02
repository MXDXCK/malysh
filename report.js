'use strict';
/*
 * Отчёт для педиатра: выбор периода и разделов → документ, который можно
 * распечатать / сохранить в PDF (окно печати) или отправить файлом.
 * Использует данные и функции из app.js.
 */

const REP_KEY = 'malysh.report';
const REP_SECTIONS = [
  ['sleep', 'Сон'], ['feed', 'Питание (смесь)'], ['solid', 'Прикорм'], ['stool', 'Стул'],
  ['growth', 'Рост и вес'], ['vacc', 'Прививки и визиты'], ['notes', 'Заметки'],
];
const REP_PRESETS = [['7', '7 дней'], ['14', '2 недели'], ['30', 'Месяц'], ['90', '3 месяца'], ['all', 'С рождения']];

function repPrefs() {
  try { return { sections: REP_SECTIONS.map(s => s[0]), preset: '14', ...(JSON.parse(localStorage.getItem(REP_KEY) || '{}')) }; }
  catch (e) { return { sections: REP_SECTIONS.map(s => s[0]), preset: '14' }; }
}
function repRange(preset) {
  const to = todayStr();
  if (preset === 'all') return [S.profile.birth || dateStr(addDays(Date.now(), -30)), to];
  return [dateStr(addDays(Date.now(), -(+preset - 1))), to];
}

/* ---- Форма выбора ---- */
function reportForm() {
  const pr = repPrefs(), [f0, t0] = repRange(pr.preset);
  openSheet('Отчёт для педиатра',
    group('Период', `<div class="chips">${REP_PRESETS.map(([k, l]) => `<button type="button" class="chip ${pr.preset === k ? 'on' : ''}" data-rp="${k}">${l}</button>`).join('')}</div>`) +
    `<div class="two">${field('С', `<input type="date" name="from" value="${f0}" max="${todayStr()}" required>`)}${field('По', `<input type="date" name="to" value="${t0}" max="${todayStr()}" required>`)}</div>` +
    group('Что включить', `<div class="seg multi">${REP_SECTIONS.map(([k, l]) => `<label><input type="checkbox" name="s_${k}" ${pr.sections.includes(k) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>`) +
    `<p class="muted" style="font-size:13px">Документ откроется на весь экран. Оттуда его можно сохранить в PDF, распечатать или отправить врачу файлом.</p>`,
    fd => {
      let from = fd.from, to = fd.to;
      if (!from || !to) return false;
      if (from > to) [from, to] = [to, from];
      const sections = REP_SECTIONS.map(s => s[0]).filter(k => fd['s_' + k]);
      if (!sections.length) { toast('Выберите хотя бы один раздел'); return false; }
      const preset = (dlg.querySelector('.chip.on[data-rp]') || {}).dataset?.rp || 'custom';
      try { localStorage.setItem(REP_KEY, JSON.stringify({ sections, preset })); } catch (e) { /* */ }
      setTimeout(() => openReport({ from, to, sections }), 60);
    }, { ok: 'Сформировать' });
}
document.addEventListener('click', e => {
  const c = e.target.closest('[data-rp]'); if (!c || !dlg.open) return;
  const [a, b] = repRange(c.dataset.rp);
  dlg.querySelector('[name=from]').value = a; dlg.querySelector('[name=to]').value = b;
  dlg.querySelectorAll('[data-rp]').forEach(x => x.classList.toggle('on', x === c));
});
document.addEventListener('input', e => {
  if (dlg.open && (e.target.name === 'from' || e.target.name === 'to')) dlg.querySelectorAll('[data-rp]').forEach(x => x.classList.remove('on'));
});

/* ---- Расчёты ---- */
const repDays = (from, to) => { const out = []; for (let t = parseDate(from).getTime(); dateStr(t) <= to; t = addDays(t, 1)) out.push(dateStr(t)); return out; };
const avg = a => (a.length ? sum(a, x => x) / a.length : 0);
const hmin = ms => durS(ms);
function dayStats(D) {
  const sl = sleepsFor(D), t0 = parseDate(D).getTime(), t1 = addDays(t0, 1);
  const ev = S.events.filter(e => e.start >= t0 && e.start < t1);
  const bottles = ev.filter(e => e.type === 'bottle'), solids = ev.filter(e => e.type === 'solid'), stools = ev.filter(e => e.type === 'stool');
  return {
    D, night: sleepDur(sl.night), nightParts: sl.night.length, day: sleepDur(sl.day), naps: sl.day.length,
    feeds: bottles.length, ml: sum(bottles, e => +e.ml), solidG: sum(solids, e => +e.grams || 0), solids: solids.length,
    stools: stools.length, stoolWarn: stools.filter(stoolWarn).length,
    hasSleep: sl.night.length + sl.day.length > 0, hasFeed: bottles.length + solids.length > 0,
  };
}
function weekRows(days) {
  const firstData = days.findIndex(d => d.hasSleep || d.hasFeed || d.stools);
  if (firstData > 0) days = days.slice(firstData);
  const groups = new Map();
  days.forEach(d => { const dt = parseDate(d.D), wd = (dt.getDay() + 6) % 7, k = dateStr(addDays(dt.getTime(), -wd)); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); });
  return [...groups.values()].map(g => ({ label: `${fmtShort.format(parseDate(g[0].D))} – ${fmtShort.format(parseDate(g[g.length - 1].D))}`, days: g }));
}

/* ---- Документ ---- */
function buildReport({ from, to, sections }) {
  const p = S.profile, has = k => sections.includes(k);
  const days = repDays(from, to).map(dayStats);
  const today = todayStr(), full = days.filter(d => d.D !== today); // сегодняшний день ещё не закончен
  const weekly = days.length > 35;
  const nm = sleepNorm(), fnm = feedNorm();
  const sex = p.sex === 'f' ? 'девочка' : p.sex === 'm' ? 'мальчик' : '';
  const pf = (n, f) => n + ' ' + pl(n, f);
  const periodTxt = `${fmtLong.format(parseDate(from))} — ${fmtLong.format(parseDate(to))} (${pf(days.length, ['день', 'дня', 'дней'])})`;
  const inP = e => e.start >= parseDate(from).getTime() && e.start < addDays(parseDate(to).getTime(), 1);
  const out = [];

  out.push(`<header class="rh"><div><h1>${esc(p.name || 'Малыш')}</h1>
    <p>${[sex, p.birth ? 'дата рождения ' + fmtLong.format(parseDate(p.birth)) : '', p.birth ? 'возраст на ' + fmtShort.format(parseDate(to)) + ': ' + ageAt(to) : ''].filter(Boolean).join(' · ')}</p></div>
    <div class="rp"><b>Отчёт за период</b><br>${periodTxt}</div></header>`);

  // Сводка
  const sAvg = full.filter(d => d.hasSleep), fAvg = full.filter(d => d.hasFeed);
  const kpi = [];
  if (has('sleep') && sAvg.length) {
    kpi.push(['Сон в сутки', hmin(avg(sAvg.map(d => d.night + d.day))), nm ? 'норма ' + normTxt(nm.total) : '']);
    kpi.push(['Ночью', hmin(avg(sAvg.map(d => d.night))), nm ? 'норма ' + normTxt(nm.night) : '']);
    kpi.push(['Днём', hmin(avg(sAvg.map(d => d.day))) + ' · ' + avg(sAvg.map(d => d.naps)).toFixed(1).replace('.', ',') + ' сна', nm ? 'норма ' + normTxt(nm.day) : '']);
  }
  if (has('feed') && fAvg.length) kpi.push(['Смесь в сутки', Math.round(avg(fAvg.map(d => d.ml))) + ' мл · ' + avg(fAvg.map(d => d.feeds)).toFixed(1).replace('.', ',') + ' кормл.', fnm ? 'ориентир ≈ ' + fnm.total + ' мл' : '']);
  if (has('stool') && full.length) kpi.push(['Стул в сутки', avg(full.map(d => d.stools)).toFixed(1).replace('.', ','), '']);
  if (has('growth')) {
    const g = [...S.growth].filter(x => +x.weight > 0).sort((a, b) => a.date.localeCompare(b.date));
    const lastW = g.filter(x => x.date <= to).pop(), prevW = g.filter(x => x.date < from).pop() || g.filter(x => x.date >= from)[0];
    if (lastW) {
      const gain = prevW && prevW !== lastW ? Math.round((lastW.weight - prevW.weight) * 1000) : null;
      const daysBetween = prevW && prevW !== lastW ? Math.round((parseDate(lastW.date) - parseDate(prevW.date)) / DAY) : 0;
      const wp = whoPercentile('weight', lastW.weight, lastW.date);
      kpi.push(['Вес', String(+lastW.weight).replace('.', ',') + ' кг', (wp ? pctTxt(wp) + '-й перцентиль ВОЗ' : '') + (gain != null ? ` · ${gain >= 0 ? '+' : ''}${gain} г за ${daysBetween} дн.` : '')]);
    }
  }
  if (kpi.length) out.push(`<section><h2>Кратко</h2><div class="kpi">${kpi.map(([a, b, c]) => `<div><small>${a}</small><b>${b}</b>${c ? `<em>${c}</em>` : ''}</div>`).join('')}</div>
    ${days.some(d => d.D === today) ? '<p class="note">Средние значения — по полным дням, без сегодняшнего.</p>' : ''}</section>`);

  // Сон
  if (has('sleep')) {
    const rows = weekly
      ? weekRows(days).map(w => { const f = w.days.filter(d => d.hasSleep); if (!f.length) return [w.label, '—', '—', '—']; return [w.label, hmin(avg(f.map(d => d.night))), hmin(avg(f.map(d => d.day))) + ` <i>· ${avg(f.map(d => d.naps)).toFixed(1).replace('.', ',')}</i>`, hmin(avg(f.map(d => d.night + d.day)))]; })
      : days.map(d => [fmtShort.format(parseDate(d.D)) + (d.D === today ? ' (сег.)' : ''), d.night ? hmin(d.night) + (d.nightParts > 1 ? ` <i>· ${d.nightParts - 1}</i>` : '') : '—', d.day ? hmin(d.day) + ` <i>· ${d.naps}</i>` : '—', d.hasSleep ? hmin(d.night + d.day) : '—']);
    out.push(`<section><h2>Сон</h2>${nm ? `<p class="note">Норма для возраста: ночью ${normTxt(nm.night)}, днём ${normTxt(nm.day)}, всего ${normTxt(nm.total)}.</p>` : ''}
      <div class="tw"><table><thead><tr><th>${weekly ? 'Неделя (в среднем за день)' : 'Дата'}</th><th>Ночь <i>· пробужд.</i></th><th>День <i>· снов</i></th><th>Всего</th></tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`);
  }

  // Питание
  if (has('feed')) {
    const rows = weekly
      ? weekRows(days).map(w => { const f = w.days.filter(d => d.hasFeed); if (!f.length) return [w.label, '—', '—', '—']; const sg = Math.round(avg(f.map(d => d.solidG))); return [w.label, avg(f.map(d => d.feeds)).toFixed(1).replace('.', ','), Math.round(avg(f.map(d => d.ml))) + ' мл', sg ? sg + ' г' : '—']; })
      : days.map(d => [fmtShort.format(parseDate(d.D)) + (d.D === today ? ' (сег.)' : ''), d.feeds || '—', d.ml ? d.ml + ' мл' : '—', d.solidG ? d.solidG + ' г' : (d.solids ? d.solids + ' раз' : '—')]);
    out.push(`<section><h2>Питание</h2>${fnm ? `<p class="note">Ориентир по объёмному методу: ≈ ${fnm.total} мл в сутки (${fnm.basis}), ${fnm.feeds} кормлений по ${fnm.perLo}–${fnm.perHi} мл. Прикорм входит в суточный объём.</p>` : ''}
      <div class="tw"><table><thead><tr><th>${weekly ? 'Неделя (в среднем за день)' : 'Дата'}</th><th>Кормлений</th><th>Смесь</th><th>Прикорм</th></tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`);
  }

  // Прикорм
  if (has('solid')) {
    const prods = allProducts().map(pr => ({ pr, s: productState(pr) })).filter(x => x.s.start || x.s.done);
    const servR = S.events.filter(e => e.type === 'solid' && inP(e) && e.reaction);
    out.push(`<section><h2>Прикорм</h2>${prods.length ? `<div class="tw"><table><thead><tr><th>Продукт</th><th>Начали</th><th>Введён</th><th>Порций</th><th>Реакция</th></tr></thead><tbody>
      ${prods.sort((a, b) => (a.s.start || '').localeCompare(b.s.start || '')).map(({ pr, s }) => `<tr${s.start >= from && s.start <= to ? ' class="hl"' : ''}><td>${esc(pr.name)}</td><td>${s.start ? fmtShort.format(parseDate(s.start)) : '—'}</td><td>${s.done ? fmtShort.format(parseDate(s.done)) : 'вводим'}</td><td>${s.servings.length}</td><td>${s.reaction ? 'была' : '—'}</td></tr>`).join('')}
      </tbody></table></div></div><p class="note">Выделены продукты, которые начали вводить в этот период.</p>` : '<p class="note">Прикорм пока не вводили.</p>'}
      ${servR.length ? `<h3>Реакции на прикорм</h3><ul>${servR.map(e => `<li>${fmtShort.format(e.start)}, ${hhmm(e.start)} — ${esc(e.food)}: ${esc(REACTIONS[e.reaction].toLowerCase())}${e.note ? ' (' + esc(e.note) + ')' : ''}</li>`).join('')}</ul>` : ''}</section>`);
  }

  // Стул
  if (has('stool')) {
    const st = S.events.filter(e => e.type === 'stool' && inP(e)).sort((a, b) => a.start - b.start);
    const byColor = STOOL_COLORS.map(([k, l]) => [l, st.filter(e => e.color === k).length]).filter(x => x[1]);
    const byCons = STOOL_CONS.map(([k, l]) => [l, st.filter(e => e.cons === k).length]).filter(x => x[1]);
    const warn = st.filter(stoolWarn);
    const rows = weekly
      ? weekRows(days).map(w => { const any = S.events.some(e => e.type === 'stool' && dateStr(e.start) >= w.days[0].D && dateStr(e.start) <= w.days[w.days.length - 1].D); return [w.label, any ? avg(w.days.map(d => d.stools)).toFixed(1).replace('.', ',') : '—']; })
      : days.map(d => [fmtShort.format(parseDate(d.D)) + (d.D === today ? ' (сег.)' : ''), d.stools ? d.stools + (d.stoolWarn ? ' ⚠' : '') : '—']);
    out.push(`<section><h2>Стул</h2>${st.length ? `<p>Всего ${pf(st.length, ['раз', 'раза', 'раз'])}. Цвет: ${byColor.map(([l, n]) => `${l.toLowerCase()} — ${n}`).join(', ')}. Консистенция: ${byCons.map(([l, n]) => `${l.toLowerCase()} — ${n}`).join(', ') || 'не указана'}.</p>` : '<p class="note">Записей о стуле за период нет.</p>'}
      ${warn.length ? `<h3>⚠ Необычный стул</h3><ul>${warn.map(e => `<li>${fmtShort.format(e.start)}, ${hhmm(e.start)} — ${esc(lbl(STOOL_COLORS, e.color) || '')}${stoolDesc(e) ? ', ' + esc(stoolDesc(e)) : ''}${e.note ? ' (' + esc(e.note) + ')' : ''}</li>`).join('')}</ul>` : ''}
      ${st.length ? `<div class="tw"><table class="narrow"><thead><tr><th>${weekly ? 'Неделя (в среднем за день)' : 'Дата'}</th><th>Раз</th></tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}</section>`);
  }

  // Рост
  if (has('growth')) {
    const g = [...S.growth].sort((a, b) => a.date.localeCompare(b.date));
    const inG = g.filter(x => x.date >= from && x.date <= to), before = g.filter(x => x.date < from).pop();
    const list = (before ? [before] : []).concat(inG);
    const cell = (x, k, u, d) => { if (!x[k]) return '—'; const wp = whoPercentile(k, x[k], x.date); return `${(+x[k]).toFixed(d).replace('.', ',')} ${u}${wp ? ` <i>(${pctTxt(wp)}%${wp.cls !== 'ok' ? ' ⚠' : ''})</i>` : ''}`; };
    out.push(`<section><h2>Рост и вес</h2>${list.length ? `<div class="tw"><table><thead><tr><th>Дата</th><th>Возраст</th><th>Вес</th><th>Рост</th><th>Голова</th></tr></thead><tbody>
      ${list.map(x => `<tr${x === before ? ' class="muted"' : ''}><td>${fmtShort.format(parseDate(x.date))}${x === before ? ' (до периода)' : ''}</td><td>${p.birth ? ageAt(x.date) : ''}</td><td>${cell(x, 'weight', 'кг', 2)}</td><td>${cell(x, 'height', 'см', 1)}</td><td>${cell(x, 'head', 'см', 1)}</td></tr>`).join('')}
      </tbody></table></div></div><p class="note">В скобках — перцентиль по стандартам роста ВОЗ (2006)${p.sex ? '' : '; укажите пол малыша в настройках, чтобы он рассчитывался'}. Норма — от 3-го до 97-го.</p>
      ${p.sex && g.some(x => x.weight) ? `<div class="rchart"><h3>Вес и норма ВОЗ</h3>${growthChart(g, 'weight', ['Вес', 'кг', 2]).split('<div class="who-legend">')[0]}<p class="note">Светлая зона — норма ВОЗ (3–97%), тёмная — 15–85%, пунктир — медиана.</p></div>` : ''}`
      : '<p class="note">Замеров нет.</p>'}</section>`);
  }

  // Прививки
  if (has('vacc') && p.birth) {
    const sch = schedule();
    const doneIn = sch.filter(v => v.done && v.done.date >= from && v.done.date <= to);
    const overdue = sch.filter(v => !v.done && v.due < startOfDay(Date.now()));
    const soon = sch.filter(v => !v.done && v.due >= startOfDay(Date.now()) && v.due <= addDays(Date.now(), 60));
    const cust = S.vacc.custom.filter(c => c.date && c.date >= from && c.date <= to);
    const li = (arr, f) => arr.length ? `<ul>${arr.map(f).join('')}</ul>` : '<p class="note">—</p>';
    out.push(`<section><h2>Прививки и визиты</h2>
      <h3>Сделано за период</h3>${li(doneIn, v => `<li>${fmtShort.format(parseDate(v.done.date))} — ${esc(v.n)}${v.done.note ? ' (' + esc(v.done.note) + ')' : ''}</li>`)}
      ${cust.length ? `<h3>Визиты и другие прививки</h3>${li(cust, c => `<li>${fmtShort.format(parseDate(c.date))} — ${esc(c.name)}${c.done ? '' : ' (запланировано)'}${c.note ? ' — ' + esc(c.note) : ''}</li>`)}` : ''}
      ${overdue.length ? `<h3>Не отмечены, хотя срок по календарю прошёл</h3>${li(overdue, v => `<li>${esc(v.n)} — по календарю ${fmtShort.format(v.due)}</li>`)}` : ''}
      <h3>Ближайшие (2 месяца)</h3>${li(soon, v => `<li>${fmtShort.format(v.due)} — ${esc(v.n)}</li>`)}
      <p class="note">Сроки — по национальному календарю профилактических прививок РФ.</p></section>`);
  }

  // Заметки
  if (has('notes')) {
    const notes = [];
    S.events.filter(e => e.note && inP(e)).forEach(e => notes.push([e.start, meta(e).title.replace(/<[^>]+>/g, ''), e.note]));
    S.growth.filter(x => x.note && x.date >= from && x.date <= to).forEach(x => notes.push([parseDate(x.date).getTime(), 'Замер', x.note, true]));
    notes.sort((a, b) => a[0] - b[0]);
    out.push(`<section><h2>Заметки</h2>${notes.length ? `<ul>${notes.map(([t, w, n, noTime]) => `<li>${fmtShort.format(t)}${noTime ? '' : ', ' + hhmm(t)} — <b>${esc(w)}</b>: ${esc(n)}</li>`).join('')}</ul>` : '<p class="note">Заметок за период нет.</p>'}</section>`);
  }

  out.push(`<footer>Сформировано ${fmtLong.format(new Date())} в ${hhmm(Date.now())} в приложении «Малыш» по записям родителей. Нормы сна, питания и роста — ориентиры (ВОЗ, AASM, рекомендации педиатров) и не заменяют осмотр врача.</footer>`);
  return out.join('\n');
}

/* ---- Просмотр, печать, отправка ---- */
const REPORT_CSS = `
.rep{font:13px/1.45 "Nunito",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1d1a18;background:#fff;max-width:820px;margin:0 auto;padding:20px 18px 40px}
.rep h1{font-size:22px;margin:0}.rep h2{font-size:16px;margin:22px 0 8px;padding-bottom:4px;border-bottom:2px solid #eadfd5}.rep h3{font-size:13.5px;margin:12px 0 4px}
.rep p{margin:4px 0}.rep .note{color:#6f645c;font-size:12px}.rep i{color:#6f645c;font-style:normal}
.rep .rh{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;border-bottom:3px solid #d9775b;padding-bottom:10px}
.rep .rh p{color:#4d443e}.rep .rp{text-align:right;font-size:12.5px}
.rep .kpi{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.rep .kpi div{border:1px solid #eadfd5;border-radius:10px;padding:8px 10px;display:grid}
.rep .kpi small{color:#6f645c;font-weight:700;font-size:11.5px}.rep .kpi b{font-size:16px}.rep .kpi em{font-style:normal;font-size:11.5px;color:#6f645c}
.rep table{width:100%;border-collapse:collapse;margin:6px 0;font-size:12.5px}
.rep th,.rep td{border:1px solid #e6dcd3;padding:4px 7px;text-align:left;vertical-align:top;white-space:nowrap}
.rep .tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
@media (max-width:520px){.rep table{font-size:12px}.rep th,.rep td{padding:3px 5px}}
.rep th{background:#f7f0ea;font-weight:700}.rep tr.hl td{background:#eef6e9}.rep tr.muted td{color:#8a7b70}
.rep table.narrow{width:auto;min-width:220px}
.rep ul{margin:4px 0;padding-left:20px}.rep li{margin:2px 0}
.rep .rchart svg{max-width:460px;width:100%}
.rep .rchart text{fill:#6f645c;font-size:11px}.rep .rchart .grid{stroke:#eadfd5}
.rep .rchart .band97{fill:rgba(63,132,82,.13)}.rep .rchart .band85{fill:rgba(63,132,82,.22)}
.rep .rchart .median{fill:none;stroke:#3f8452;stroke-width:1.5;stroke-dasharray:4 4}
.rep .rchart .line{fill:none;stroke:#b07e1e;stroke-width:2.5}.rep .rchart .pt{fill:#fff;stroke:#b07e1e;stroke-width:2.5}
.rep .rchart .hint,.rep .rchart .who-now{display:none}
.rep footer{margin-top:26px;padding-top:8px;border-top:1px solid #eadfd5;color:#8a7b70;font-size:11.5px}
.rep section{break-inside:auto}.rep h2,.rep h3{break-after:avoid}.rep tr{break-inside:avoid}
`;
let lastReport = null;
function openReport(opts) {
  if (!document.getElementById('rep-style')) { const st = document.createElement('style'); st.id = 'rep-style'; st.textContent = REPORT_CSS; document.head.appendChild(st); }
  closeReport();
  const html = buildReport(opts);
  lastReport = { opts, html };
  const el = document.createElement('div');
  el.id = 'report';
  el.innerHTML = `<div class="rep-bar"><button class="btn small ghost" data-rx="close">✕ Закрыть</button><span></span>
    <button class="btn small" data-rx="share">Отправить</button><button class="btn small primary" data-rx="print">PDF / печать</button></div>
    <article class="rep">${html}</article>`;
  document.body.appendChild(el);
  document.body.classList.add('rep-open');
}
function closeReport() { const el = document.getElementById('report'); if (el) el.remove(); document.body.classList.remove('rep-open'); }
function reportFileName() {
  const o = lastReport.opts, n = (S.profile.name || 'Малыш').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '');
  return `Отчёт_${n}_${o.from}_${o.to}.html`;
}
async function shareReport() {
  if (!lastReport) return;
  const doc = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc('Отчёт для педиатра — ' + (S.profile.name || 'Малыш'))}</title><style>body{margin:0;background:#fff}${REPORT_CSS}</style></head><body><article class="rep">${lastReport.html}</article></body></html>`;
  const name = reportFileName();
  try {
    const file = new File([doc], name, { type: 'text/html' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Отчёт для педиатра' }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([doc], { type: 'text/html' })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast('Файл отчёта сохранён');
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-rx]'); if (!b) return;
  if (b.dataset.rx === 'close') closeReport();
  if (b.dataset.rx === 'print') window.print();
  if (b.dataset.rx === 'share') shareReport();
});
window.reportForm = reportForm;
