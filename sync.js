/*
 * Синхронизация между телефонами семьи через Firebase Firestore.
 * Телефоны связываются «кодом семьи»: записи лежат в families/<код>/items/<id>.
 *
 * Экономия бесплатного лимита (с версии 1.5.0):
 * - каждая запись в облаке хранит время изменения t (время сервера);
 * - телефон помнит, до какого момента он уже всё получил (cursor), и спрашивает
 *   у облака только изменения после него — а не все записи при каждом открытии;
 * - удаление — это пометка del: true («надгробие»), чтобы другие телефоны узнали
 *   об удалении из тех же «только изменений»;
 * - чтобы понять, что изменилось у нас, телефон хранит короткий отпечаток
 *   (хэш) каждой отправленной записи, а не копию всех данных.
 */
import { FIREBASE_CONFIG } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const LS = 'malysh.sync';             // { family, merged, dirty }
const LS_STATE = 'malysh.sync.state'; // { family, cursor, known: { id: hash } }
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих 0/O, 1/I
const SAFETY_MS = 10 * 60 * 1000;     // перечитываем последние 10 минут — на случай задержек записи
const RELISTEN_MS = 20 * 60 * 1000;   // долгая подписка обновляется со свежим cursor
const BATCH = 400;

const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* */ } };

let cfg = lsGet(LS);
let st = lsGet(LS_STATE);
if (!st || !cfg || st.family !== cfg.family) st = null;
const saveCfg = () => lsSet(LS, cfg);
let stTimer = null;
const saveState = () => { clearTimeout(stTimer); stTimer = setTimeout(() => lsSet(LS_STATE, st), 300); };

let F = null, db = null, unsub = null, ready = false, startedFor = null, listenedAt = 0, starting = false;
const inflight = {}; // id → отпечаток, который сейчас отправляется (ещё без подтверждения облака)
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(what + ': нет ответа'), { code: 'timeout' })), ms))]);

const Sync = {
  configured: !!(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId),
  family: cfg && cfg.family || null,
  status: 'off',
  error: '',
  lastSync: (lsGet(LS_STATE) || {}).lastSync || 0,
  push,
  create, join, leave, share, reconnect,
};
window.Sync = Sync;

function notify() { if (window.App) window.App.syncChanged(); }
function setStatus(s, err) { Sync.status = s; Sync.error = err || ''; notify(); }

// FNV-1a — короткий отпечаток строки
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ':' + str.length.toString(36);
}

function genCode() {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  const s = [...b].map(x => ALPHABET[x % ALPHABET.length]).join('');
  return s.match(/.{4}/g).join('-');
}
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{4})(?=.)/g, '$1-');

let auth = null;
async function start() {
  if (!Sync.configured || !Sync.family || startedFor === Sync.family || starting) return;
  startedFor = Sync.family; starting = true;
  setStatus(navigator.onLine === false ? 'offline' : 'connecting');
  try {
    const [appMod, authMod, fsMod] = await withTimeout(Promise.all([
      import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js'),
    ]), 30000, 'загрузка Firebase');
    F = fsMod;
    const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(FIREBASE_CONFIG);
    // Вход и кэш — без IndexedDB: в Safari на iPhone она «засыпает» после сворачивания приложения,
    // и синхронизация зависает на «подключаюсь…». Свою копию записей приложение хранит само.
    if (!auth) {
      try { auth = authMod.initializeAuth(app, { persistence: [authMod.browserLocalPersistence, authMod.inMemoryPersistence] }); }
      catch (e) { auth = authMod.getAuth(app); }
    }
    if (!auth.currentUser) await withTimeout(authMod.signInAnonymously(auth), 20000, 'вход');
    if (!db) {
      try { db = F.initializeFirestore(app, { localCache: F.memoryLocalCache() }); }
      catch (e) { db = F.getFirestore(app); }
    }
    listen();
  } catch (e) {
    startedFor = null;
    setStatus(navigator.onLine === false ? 'offline' : 'error', e && (e.code || e.message));
  }
  starting = false;
}

// Переподключиться: заново подписаться на изменения (а если не загрузились — начать сначала)
function reconnect() {
  if (!Sync.family) return;
  if (db && F) { setStatus('connecting'); listen(); }
  else { startedFor = null; start(); }
}

const tsMs = t => (t && typeof t.toMillis === 'function' ? t.toMillis() : 0);

function listen() {
  if (unsub) { unsub(); unsub = null; }
  ready = false; listenedAt = Date.now();
  if (!st) st = { family: Sync.family, cursor: 0, known: {} };
  const full = !st.cursor;
  const col = F.collection(db, 'families', Sync.family, 'items');
  const q = full ? col : F.query(col, F.where('t', '>', F.Timestamp.fromMillis(Math.max(1, st.cursor - SAFETY_MS))));
  unsub = F.onSnapshot(q, { includeMetadataChanges: true }, snap => {
    if (!ready) {
      // Первый ответ ждём именно с сервера, а не из кэша телефона
      if (snap.metadata.fromCache) { setStatus(navigator.onLine === false ? 'offline' : 'connecting'); return; }
      ready = true;
      if (full) firstFull(snap.docs); else applyDocs(snap.docs);
    } else {
      // «removed» — НЕ всегда удаление! Пока наша правка не подтверждена облаком, у неё нет времени сервера,
      // и Firestore временно исключает документ из запроса «изменения после…». Это не удаление — пропускаем.
      // Настоящее удаление (с версии 1.5.0) — пометка del: true. «removed» как удаление учитываем только
      // в полной подписке и только для подтверждённых документов (так удаляли версии до 1.5.0).
      const changes = snap.docChanges().filter(ch => ch.type !== 'removed' || (full && !(ch.doc.metadata && ch.doc.metadata.hasPendingWrites)));
      applyDocs(changes.map(ch => (ch.type === 'removed' ? { removed: ch.doc } : ch.doc)));
    }
    if (!snap.metadata.fromCache) { Sync.lastSync = Date.now(); if (st) { st.lastSync = Sync.lastSync; saveState(); } }
    setStatus(snap.metadata.fromCache ? 'offline' : 'on');
  }, err => { ready = false; setStatus('error', err.code || err.message); });
}

// Документ облака → { id, v (строка или null, если удалено), t }
function readDoc(d) {
  if (d.removed) return { id: d.removed.id, v: null, t: 0 };
  if (d.metadata && d.metadata.hasPendingWrites) return null; // это наша собственная, ещё не подтверждённая запись
  const x = d.data() || {};
  return { id: d.id, v: (x.del || x.v == null) ? null : x.v, t: tsMs(x.t) };
}

// Полная загрузка: первое подключение телефона (или переход со старой версии)
function firstFull(docs) {
  const remote = {};
  let cursor = 0;
  docs.forEach(d => { const r = readDoc(d); if (!r) return; remote[r.id] = r.v; cursor = Math.max(cursor, r.t); });
  const local = window.App.flatten();
  // Старые версии стирали записи из облака насовсем. Если телефон уже был в семье и не правил ничего
  // без связи — верим облаку целиком. Иначе (новый телефон, правки без связи) — объединяем.
  const trustRemote = !!(cfg && cfg.merged && !cfg.dirty);
  const merged = trustRemote ? {} : { ...local };
  const known = {};
  for (const [id, v] of Object.entries(remote)) {
    if (v == null) { delete merged[id]; continue; }
    merged[id] = v; known[id] = hash(v);
  }
  st = { family: Sync.family, cursor, known };
  cfg = { ...(cfg || {}), family: Sync.family, merged: true, dirty: false }; saveCfg();
  window.App.applyRemote(merged);
  push(); // отправляем то, чего нет в облаке (записи нового телефона)
  saveState();
}

// Порция изменений из облака
function applyDocs(docs) {
  const changes = {};
  let any = false;
  docs.forEach(d => {
    const r = readDoc(d); if (!r) return;
    if (r.t > st.cursor) st.cursor = r.t;
    if (inflight[r.id] !== undefined) return; // наша правка этой записи ещё в пути — не даём «эху» старой версии её перетереть
    const h = r.v == null ? null : hash(r.v);
    if (h === (st.known[r.id] || null)) return; // уже знаем (часто — эхо нашей же записи)
    if (r.v == null) delete st.known[r.id]; else st.known[r.id] = h;
    changes[r.id] = r.v; any = true;
  });
  if (any) window.App.applyChanges(changes);
  saveState();
  push(); // правки, сделанные без связи
}

const writeQueue = [];
let flushing = false, retryTimer = null;
async function flush() {
  if (flushing || !writeQueue.length) return;
  flushing = true;
  while (writeQueue.length) {
    const ops = writeQueue.splice(0, BATCH);
    try {
      const b = F.writeBatch(db);
      ops.forEach(([id, v]) => {
        const ref = F.doc(db, 'families', Sync.family, 'items', id);
        b.set(ref, v == null ? { v: null, del: true, t: F.serverTimestamp() } : { v, del: false, t: F.serverTimestamp() });
      });
      await withTimeout(b.commit(), 30000, 'отправка');
      // Облако подтвердило — теперь запись считается синхронизированной
      ops.forEach(([id, v, h]) => {
        if (inflight[id] === h) delete inflight[id];
        if (v == null) { if (st.known[id] === undefined || h === 'del') delete st.known[id]; } else st.known[id] = h;
      });
      saveState();
    } catch (e) {
      // Не получилось (нет связи) — вернём в очередь при следующей попытке
      ops.forEach(([id, , h]) => { if (inflight[id] === h) delete inflight[id]; });
      writeQueue.length = 0;
      setStatus(navigator.onLine === false || (e && e.code === 'timeout') ? 'offline' : 'error', e && (e.code || e.message));
      clearTimeout(retryTimer); retryTimer = setTimeout(push, 20000);
      break;
    }
  }
  flushing = false;
}

// Вызывается приложением после каждого сохранения: отправляем только изменившееся
function push() {
  if (!Sync.family || !window.App) return;
  if (!ready || !db || !st) { if (cfg && !cfg.dirty) { cfg.dirty = true; saveCfg(); } return; }
  const flat = window.App.flatten();
  let n = 0;
  for (const [id, v] of Object.entries(flat)) {
    const h = hash(v);
    if (st.known[id] !== h && inflight[id] !== h) { inflight[id] = h; writeQueue.push([id, v, h]); n++; }
  }
  for (const id of Object.keys(st.known)) {
    if (!(id in flat) && inflight[id] !== 'del') { inflight[id] = 'del'; writeQueue.push([id, null, 'del']); n++; }
  }
  if (n) flush();
}

async function create() {
  if (!Sync.configured) return;
  Sync.family = genCode();
  cfg = { family: Sync.family, merged: false }; saveCfg();
  st = null; lsSet(LS_STATE, null);
  startedFor = null; ready = false;
  await start();
}
async function join(code) {
  const c = normCode(code);
  if (c.replace(/-/g, '').length !== 16) { alert('Код должен состоять из 16 букв и цифр, например ABCD-EFGH-JKLM-NPQR'); return false; }
  if (!confirm('Подключиться к семье? Записи этого телефона добавятся к общим, а дальше всё будет общим.')) return false;
  Sync.family = c;
  cfg = { family: c, merged: false }; saveCfg();
  st = null; lsSet(LS_STATE, null);
  startedFor = null; ready = false;
  await start();
  return true;
}
function leave() {
  if (unsub) unsub(); unsub = null;
  Sync.family = null; cfg = null; saveCfg();
  st = null; lsSet(LS_STATE, null);
  startedFor = null; ready = false;
  setStatus('off');
}
async function share() {
  const text = `Код нашей семьи в приложении «Малыш»: ${Sync.family}\nОткройте приложение → Настройки → «Код семьи с другого телефона».`;
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(Sync.family); alert('Код скопирован'); } catch (e) { prompt('Скопируйте код:', Sync.family); }
}

window.addEventListener('online', () => { if (Sync.family && !db) { startedFor = null; start(); } });
// Вернулись в приложение спустя долгое время — подписываемся заново с актуальной точки
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !Sync.family) return;
  if (!db) { startedFor = null; start(); return; }
  if (!ready || Date.now() - listenedAt > RELISTEN_MS) listen();
});
// Сторож: если подключение не установилось за 25 секунд — пробуем заново
setInterval(() => {
  if (!Sync.family || document.hidden || starting) return;
  if (!db) { if (Sync.status !== 'connecting') { startedFor = null; start(); } return; }
  if (!ready && Date.now() - listenedAt > 25000) listen();
}, 10000);
if (Sync.family) start();
notify();
