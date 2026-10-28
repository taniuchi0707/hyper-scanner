// ページと書類名を IndexedDB に保存する。使えない環境ではメモリだけで動く
const Store = (() => {
  'use strict';

  let db = null;
  const mem = { pages: new Map(), meta: new Map() };

  function open() {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open('hyper-scanner', 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
        };
        req.onsuccess = () => { db = req.result; resolve(true); };
        req.onerror = () => resolve(false);
        req.onblocked = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  function run(storeName, mode, fn) {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, mode);
        const req = fn(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => resolve(undefined);
        tx.onabort = () => resolve(undefined);
      } catch (e) {
        resolve(undefined);
      }
    });
  }

  // 実行時だけ使う項目（thumbUrl など）は保存しない
  const record = ({ thumbUrl, busy, ...rest }) => rest;

  async function getPages() {
    if (!db) return [...mem.pages.values()];
    return (await run('pages', 'readonly', (s) => s.getAll())) || [];
  }

  async function putPages(pages) {
    const recs = pages.map(record);
    if (!db) { recs.forEach((r) => mem.pages.set(r.id, r)); return; }
    await run('pages', 'readwrite', (s) => { recs.forEach((r) => s.put(r)); return null; });
  }

  const putPage = (page) => putPages([page]);

  async function deletePages(ids) {
    if (!db) { ids.forEach((id) => mem.pages.delete(id)); return; }
    await run('pages', 'readwrite', (s) => { ids.forEach((id) => s.delete(id)); return null; });
  }

  async function getMeta(key) {
    if (!db) return mem.meta.get(key);
    return run('meta', 'readonly', (s) => s.get(key));
  }

  async function setMeta(key, value) {
    if (!db) { mem.meta.set(key, value); return; }
    await run('meta', 'readwrite', (s) => s.put(value, key));
  }

  return { open, getPages, putPage, putPages, deletePages, getMeta, setMeta };
})();
