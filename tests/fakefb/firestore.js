// Поддельный Firestore для тестов. Повторяет важную особенность настоящего:
// пока локальная запись с serverTimestamp() не подтверждена, документ выпадает из запроса where('t','>',…)
// и подписчик получает изменение 'removed' с hasPendingWrites: true.
const call = (op, a) => window.__fbCall(JSON.stringify({ op, ...a })).then(r => JSON.parse(r));
const ts = ms => ({ toMillis: () => ms, __ms: ms });
export const Timestamp = { fromMillis: ts };
export const serverTimestamp = () => ({ __st: 1 });
export const initializeFirestore = () => ({}); export const getFirestore = () => ({});
export const persistentLocalCache = () => ({}); export const persistentMultipleTabManager = () => ({}); export const memoryLocalCache = () => ({});
export const collection = (db, ...p) => ({ path: p.join('/') });
export const doc = (db, ...p) => ({ path: p.slice(0, -1).join('/'), id: p[p.length - 1] });
export const where = (f, op, v) => ({ min: v.__ms });
export const query = (c, w) => ({ path: c.path, min: w.min });
const L = {}; let n = 0;
const emit = (lid, changes, pending) => {
  const l = L[lid]; if (!l) return;
  const mk = c => ({ id: c.id, metadata: { hasPendingWrites: !!pending }, data: () => ({ v: c.v, del: c.del, t: c.t == null ? null : ts(c.t) }) });
  const all = changes.map(mk);
  changes.forEach(c => { if (c.type === 'removed') l.ids.delete(c.id); else l.ids.add(c.id); });
  l.cb({ metadata: { fromCache: false, hasPendingWrites: !!pending }, docs: all.filter((d, i) => changes[i].type !== 'removed'),
       docChanges: () => changes.map((c, i) => ({ type: c.type || 'modified', doc: all[i] })) });
};
window.__fbPush = (lid, changes) => emit(lid, changes, false);
export const onSnapshot = (q, opts, next) => { const lid = 'l' + (++n); L[lid] = { cb: next, path: q.path, min: q.min || 0, ids: new Set() }; call('listen', { lid, path: q.path, min: q.min || 0 }); return () => { delete L[lid]; call('unlisten', { lid }); }; };
const enc = d => ({ v: d.v === undefined ? null : d.v, del: !!d.del });
function localPending(ops) {
  for (const [lid, l] of Object.entries(L)) {
    if (!l.min) continue; // полная подписка без фильтра — документ не выпадает
    const ch = ops.filter(o => o.path === l.path && l.ids.has(o.id)).map(o => ({ id: o.id, v: o.v, del: o.del, t: null, type: 'removed' }));
    if (ch.length) emit(lid, ch, true);
  }
}
const commit = ops => { localPending(ops); return call('write', { ops }); };
export const setDoc = (ref, d) => commit([{ path: ref.path, id: ref.id, ...enc(d) }]);
export const deleteDoc = ref => call('write', { ops: [{ path: ref.path, id: ref.id, remove: true }] });
export const writeBatch = () => { const ops = []; return { set(ref, d) { ops.push({ path: ref.path, id: ref.id, ...enc(d) }); }, commit: () => commit(ops) }; };
