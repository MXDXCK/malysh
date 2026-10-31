/*
 * Синхронизация между телефонами мамы и папы через Firebase Firestore.
 * Работает, только если в firebase-config.js вписаны настройки проекта.
 * Телефоны связываются «кодом семьи»: все записи лежат в families/<код>/items/<id>.
 */
import { FIREBASE_CONFIG } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const LS = 'malysh.sync';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих 0/O, 1/I

let cfg = null;
try { cfg = JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) { cfg = null; }
const saveCfg = () => { try { cfg ? localStorage.setItem(LS, JSON.stringify(cfg)) : localStorage.removeItem(LS); } catch (e) { /* */ } };

let F = null, db = null, unsub = null, known = {}, ready = false, startedFor = null;

const Sync = {
  configured: !!(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId),
  family: cfg && cfg.family || null,
  status: 'off',
  error: '',
  push,
  create, join, leave, share,
};
window.Sync = Sync;

function notify() { if (window.App) window.App.syncChanged(); }
function setStatus(s, err) { Sync.status = s; Sync.error = err || ''; notify(); }

function genCode() {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  const s = [...b].map(x => ALPHABET[x % ALPHABET.length]).join('');
  return s.match(/.{4}/g).join('-');
}
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{4})(?=.)/g, '$1-');

async function start() {
  if (!Sync.configured || !Sync.family || startedFor === Sync.family) return;
  startedFor = Sync.family;
  setStatus(navigator.onLine === false ? 'offline' : 'connecting');
  try {
    const [appMod, authMod, fsMod] = await Promise.all([
      import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js'),
    ]);
    F = fsMod;
    const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(FIREBASE_CONFIG);
    await authMod.signInAnonymously(authMod.getAuth(app));
    if (!db) {
      try { db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) }); }
      catch (e) { db = F.getFirestore(app); }
    }
    listen();
  } catch (e) {
    startedFor = null;
    setStatus(navigator.onLine === false ? 'offline' : 'error', e && (e.code || e.message));
  }
}

function listen() {
  known = {}; ready = false;
  if (unsub) unsub();
  const col = F.collection(db, 'families', Sync.family, 'items');
  unsub = F.onSnapshot(col, { includeMetadataChanges: true }, snap => {
    snap.docChanges().forEach(ch => {
      if (ch.type === 'removed') delete known[ch.doc.id];
      else known[ch.doc.id] = ch.doc.data().v;
    });
    if (!ready) {
      // При первом подключении ждём настоящих данных с сервера, чтобы не затереть чужие записи
      if (snap.metadata.fromCache && !(cfg && cfg.merged)) { setStatus('connecting'); return; }
      ready = true;
      firstMerge();
    } else if (snap.docChanges().length) {
      window.App.applyRemote(known);
    }
    setStatus(snap.metadata.fromCache ? 'offline' : 'on');
  }, err => { setStatus('error', err.code || err.message); });
}

// Первый снимок за сеанс.
// - первое подключение телефона: добавляем в облако локальные записи, которых там нет;
// - были правки, пока облако было недоступно (dirty): отправляем их;
// - иначе просто берём облачную версию (в ней учтены удаления со второго телефона).
function firstMerge() {
  const local = window.App.flatten();
  const remoteEmpty = Object.keys(known).length === 0;
  const dirty = !!(cfg && cfg.dirty);
  if (!(cfg && cfg.merged) || dirty || remoteEmpty) {
    for (const [id, v] of Object.entries(local)) {
      if (!(id in known) || (dirty && known[id] !== v)) { known[id] = v; write(id, v); }
    }
  }
  cfg = { ...(cfg || {}), family: Sync.family, merged: true, dirty: false }; saveCfg();
  window.App.applyRemote(known);
}

function write(id, v) {
  F.setDoc(F.doc(db, 'families', Sync.family, 'items', id), { v, t: F.serverTimestamp() })
    .catch(e => setStatus('error', e.code || e.message));
}
function remove(id) {
  F.deleteDoc(F.doc(db, 'families', Sync.family, 'items', id))
    .catch(e => setStatus('error', e.code || e.message));
}

// Вызывается приложением после каждого сохранения: отправляем только изменившееся
function push() {
  if (!Sync.family || !window.App) return;
  if (!ready || !db) { if (cfg && !cfg.dirty) { cfg.dirty = true; saveCfg(); } return; }
  const flat = window.App.flatten();
  for (const [id, v] of Object.entries(flat)) if (known[id] !== v) { known[id] = v; write(id, v); }
  for (const id of Object.keys(known)) if (!(id in flat)) { delete known[id]; remove(id); }
}

async function create() {
  if (!Sync.configured) return;
  Sync.family = genCode();
  cfg = { family: Sync.family, merged: false }; saveCfg();
  startedFor = null; ready = false;
  await start();
}
async function join(code) {
  const c = normCode(code);
  if (c.replace(/-/g, '').length !== 16) { alert('Код должен состоять из 16 букв и цифр, например ABCD-EFGH-JKLM-NPQR'); return false; }
  if (!confirm('Подключиться к семье? Записи этого телефона добавятся к общим, а дальше всё будет общим.')) return false;
  Sync.family = c;
  cfg = { family: c, merged: false }; saveCfg();
  startedFor = null; ready = false;
  await start();
  return true;
}
function leave() {
  if (unsub) unsub(); unsub = null;
  Sync.family = null; cfg = null; saveCfg();
  startedFor = null; ready = false; known = {};
  setStatus('off');
}
async function share() {
  const text = `Код нашей семьи в приложении «Малыш»: ${Sync.family}\nОткройте приложение → Настройки → «Код семьи с другого телефона».`;
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(Sync.family); alert('Код скопирован'); } catch (e) { prompt('Скопируйте код:', Sync.family); }
}

window.addEventListener('online', () => { if (Sync.family && !ready) { startedFor = null; start(); } });
if (Sync.family) start();
notify();
