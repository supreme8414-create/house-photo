// lib/db.js — 案件與照片的本機儲存（IndexedDB）
//
// 資料結構：
//   listings  { id, name, createdAt, updatedAt }
//   photos    { id, listingId, createdAt, edited:boolean, editedAt, width, height, thumb, origThumb }
//             （只放小縮圖，列表時不會把大圖讀進記憶體）
//   blobs     key = `${photoId}:o`（原圖，永遠不覆蓋） / `${photoId}:e`（修圖結果）
//
// 失敗處理：
//   - IndexedDB 打不開（無痕模式、被封鎖）→ 改用記憶體模式，App 照常運作，但關掉就會消失。
//   - 舊版 Safari 不能存 Blob → 自動改存 ArrayBuffer。
//   - 空間不足 → 丟出中文錯誤訊息。

const DB_NAME = 'house-declutter';
const DB_VERSION = 1;

let backend = null;
let useBuffers = false;
/** 'idb' | 'memory' */
export let storageMode = 'memory';

/** 產生不重複 ID（非安全環境沒有 crypto.randomUUID，例如用區網 IP 測試時） */
export function newId() {
  try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch { /* 忽略 */ }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---------------- 後端：IndexedDB ----------------
function openIDB() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (v) => { if (!settled) { settled = true; resolve(v); } };
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    // 部分瀏覽器的私密模式會讓 open 永遠沒有回應
    setTimeout(() => fail(new Error('IndexedDB 開啟逾時')), 8000);
    let req;
    try {
      if (!('indexedDB' in window) || !window.indexedDB) throw new Error('不支援 IndexedDB');
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) { fail(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('listings')) db.createObjectStore('listings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('photos')) {
        const s = db.createObjectStore('photos', { keyPath: 'id' });
        s.createIndex('listingId', 'listingId');
      }
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      ok(db);
    };
    req.onerror = () => fail(req.error || new Error('IndexedDB 開啟失敗'));
    req.onblocked = () => fail(new Error('IndexedDB 被其他分頁占用'));
  });
}

const isValidKey = (k) => (typeof k === 'string' && k.length > 0) || (typeof k === 'number' && Number.isFinite(k));

class IDBBackend {
  constructor(db) { this.db = db; }
  _req(store, fn) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(store, 'readonly');
      const r = fn(t.objectStore(store));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  get(store, key) {
    if (!isValidKey(key)) return Promise.resolve(undefined);
    return this._req(store, (s) => s.get(key));
  }
  getAll(store) { return this._req(store, (s) => s.getAll()); }
  byIndex(store, index, value) {
    // getAll(undefined) 會回傳「全部」，不可以
    if (!isValidKey(value)) return Promise.resolve([]);
    return this._req(store, (s) => s.index(index).getAll(value));
  }
  /** 多筆寫入放在同一個交易：要嘛全成功、要嘛全失敗 */
  batch(ops) {
    ops = ops.filter((o) => o.type === 'put' || isValidKey(o.key));
    if (!ops.length) return Promise.resolve();
    for (const o of ops) {
      if (o.type === 'put' && o.key === undefined && !(o.value && isValidKey(o.value.id))) {
        return Promise.reject(new Error(`put without key in store ${o.store}`));
      }
    }
    const stores = [...new Set(ops.map((o) => o.store))];
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(stores, 'readwrite');
      for (const o of ops) {
        const s = t.objectStore(o.store);
        if (o.type === 'put') { if (o.key !== undefined) s.put(o.value, o.key); else s.put(o.value); }
        else s.delete(o.key);
      }
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('交易中止'));
    });
  }
}

// ---------------- 後端：記憶體（備援） ----------------
class MemoryBackend {
  constructor() { this.s = { listings: new Map(), photos: new Map(), blobs: new Map() }; }
  async get(store, key) { return this.s[store].get(key); }
  async getAll(store) { return [...this.s[store].values()]; }
  async byIndex(store, index, value) { return [...this.s[store].values()].filter((v) => v[index] === value); }
  async batch(ops) {
    for (const o of ops) {
      const m = this.s[o.store];
      if (o.type === 'put') m.set(o.key !== undefined ? o.key : o.value.id, o.value);
      else m.delete(o.key);
    }
  }
}

/**
 * 初始化儲存。永遠成功（失敗時退回記憶體模式）。
 * @returns {Promise<{mode:'idb'|'memory', error?:any}>}
 */
export async function initDB() {
  try {
    const db = await openIDB();
    backend = new IDBBackend(db);
    // 測試能不能直接存 Blob（舊 iOS 不行）
    try {
      await backend.batch([{ store: 'blobs', type: 'put', key: '__probe', value: new Blob(['x'], { type: 'text/plain' }) }]);
      await backend.batch([{ store: 'blobs', type: 'delete', key: '__probe' }]);
    } catch (e) {
      console.warn('IndexedDB 無法存 Blob，改用 ArrayBuffer', e);
      useBuffers = true;
    }
    storageMode = 'idb';
    return { mode: 'idb' };
  } catch (error) {
    console.warn('IndexedDB 無法使用，改用記憶體模式', error);
    backend = new MemoryBackend();
    storageMode = 'memory';
    return { mode: 'memory', error };
  }
}

/** 請瀏覽器盡量不要自動清掉資料（不保證成功） */
export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* 忽略 */ }
  return false;
}

// ---------------- Blob 包裝 ----------------
async function wrap(blob) {
  if (!blob) return null;
  if (!useBuffers || storageMode === 'memory') return blob;
  return { __buf: await blob.arrayBuffer(), type: blob.type || 'image/jpeg' };
}
function unwrap(v) {
  if (!v) return null;
  if (v instanceof Blob) return v;
  if (v.__buf) return new Blob([v.__buf], { type: v.type });
  return null;
}

/** 帶有中文訊息、代碼與原始英文細節的錯誤 */
function appError(message, code, cause) {
  const e = new Error(message);
  e.code = code;
  if (cause) {
    e.detail = `${cause.name || 'Error'}: ${cause.message || cause}`;
    e.cause = cause;
  }
  return e;
}

/** 把底層錯誤轉成看得懂的中文（原始英文放在 .detail） */
function friendly(e) {
  const name = e && e.name;
  if (name === 'QuotaExceededError' || /quota/i.test(String(e && e.message))) {
    return appError('手機儲存空間不足，請刪除一些舊案件或照片後再試。', 'STORAGE_FULL', e);
  }
  if (e instanceof Error && /[一-鿿]/.test(e.message)) return e;
  return appError('讀取或儲存手機裡的資料時發生問題。請回到首頁重新開啟案件；如果一直發生，請重新開啟修圖器。', 'DB_ERROR', e);
}

/** iOS 在背景太久會把資料庫連線關掉（「Connection to Indexed Database server lost」） */
function isConnectionLost(e) {
  const m = String((e && e.message) || '');
  return (e && e.name === 'InvalidStateError') || /connection.*(lost|closed|closing)|database.*(closed|closing)/i.test(m);
}

async function safe(fn) {
  if (!backend) await initDB();
  try { return await fn(); }
  catch (e) {
    if (storageMode === 'idb' && isConnectionLost(e)) {
      // 重新連線後再試一次
      try {
        backend = new IDBBackend(await openIDB());
        return await fn();
      } catch (e2) { console.error(e2); throw friendly(e2); }
    }
    console.error(e);
    throw friendly(e);
  }
}

/** ID 是否有效（IndexedDB 的 key 不能是 undefined / null / 空字串） */
export function isValidId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}
function requireId(id, what = '資料') {
  if (!isValidId(id)) {
    throw appError(`找不到這個${what}，請回到首頁重新開啟案件。`, 'BAD_ID', new Error(`invalid ${what} id: ${String(id)}`));
  }
}

const byCreated = (a, b) => a.createdAt - b.createdAt;
let seq = 0;
const now = () => Date.now();
/** 確保同一毫秒內加入的照片順序不會亂 */
const orderStamp = () => Date.now() * 1000 + (seq++ % 1000);

// ---------------- 案件 ----------------

/** 案件列表（含照片數、已修張數、封面縮圖 Blob），依最近更新排序 */
export function listListings() {
  return safe(async () => {
    const [ls, ps] = await Promise.all([backend.getAll('listings'), backend.getAll('photos')]);
    const groups = new Map();
    for (const p of ps) {
      if (!groups.has(p.listingId)) groups.set(p.listingId, []);
      groups.get(p.listingId).push(p);
    }
    return ls.map((l) => {
      const mine = (groups.get(l.id) || []).sort(byCreated);
      return {
        ...l,
        count: mine.length,
        editedCount: mine.filter((p) => p.edited).length,
        coverThumb: mine.length ? unwrap(mine[0].thumb) : null,
      };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

export function getListing(id) {
  if (!isValidId(id)) return Promise.resolve(null);
  return safe(async () => (await backend.get('listings', id)) || null);
}

export function createListing(name) {
  return safe(async () => {
    const l = { id: newId(), name: String(name).trim() || '未命名案件', createdAt: now(), updatedAt: now() };
    await backend.batch([{ store: 'listings', type: 'put', value: l }]);
    return l;
  });
}

export function renameListing(id, name) {
  return safe(async () => {
    requireId(id, '案件');
    const l = await backend.get('listings', id);
    if (!l) throw new Error('找不到這個案件');
    l.name = String(name).trim() || l.name;
    l.updatedAt = now();
    await backend.batch([{ store: 'listings', type: 'put', value: l }]);
    return l;
  });
}

/** 刪除案件與底下所有照片（含原圖） */
export function deleteListing(id) {
  return safe(async () => {
    requireId(id, '案件');
    const photos = await backend.byIndex('photos', 'listingId', id);
    const ops = [{ store: 'listings', type: 'delete', key: id }];
    for (const p of photos) {
      ops.push({ store: 'photos', type: 'delete', key: p.id });
      ops.push({ store: 'blobs', type: 'delete', key: p.id + ':o' });
      ops.push({ store: 'blobs', type: 'delete', key: p.id + ':e' });
    }
    await backend.batch(ops);
  });
}

async function touchOps(listingId) {
  if (!isValidId(listingId)) return [];
  const l = await backend.get('listings', listingId);
  if (!l) return [];
  l.updatedAt = now();
  return [{ store: 'listings', type: 'put', value: l }];
}

// ---------------- 照片 ----------------

/** 照片列表（只有縮圖，依加入順序） */
export function listPhotos(listingId) {
  if (!isValidId(listingId)) return Promise.resolve([]);
  return safe(async () => (await backend.byIndex('photos', 'listingId', listingId)).sort(byCreated));
}

export function getPhoto(id) {
  if (!isValidId(id)) return Promise.resolve(null);
  return safe(async () => (await backend.get('photos', id)) || null);
}

/** 取得照片的縮圖 Blob */
export function thumbOf(photo) {
  return unwrap(photo && photo.thumb);
}

/**
 * 新增照片
 * @param {string} listingId
 * @param {{original:Blob, thumb:Blob, width:number, height:number}} data
 */
export function addPhoto(listingId, { original, thumb, width, height }) {
  return safe(async () => {
    if (!isValidId(listingId)) {
      throw appError('還沒開啟案件，請先回到首頁點一個案件（或新增案件），再加入照片。', 'NO_LISTING', new Error(`addPhoto: invalid listingId ${String(listingId)}`));
    }
    if (!(await backend.get('listings', listingId))) {
      throw appError('找不到這個案件（可能已被刪除），請回到首頁重新開啟。', 'NO_LISTING', new Error(`addPhoto: listing not found ${listingId}`));
    }
    if (!original) throw appError('照片資料是空的，請重新選一次照片。', 'NO_DATA');
    const [o, t] = [await wrap(original), await wrap(thumb)];
    const p = {
      id: newId(), listingId, createdAt: orderStamp(),
      edited: false, editedAt: null, width, height,
      thumb: t, origThumb: t,
    };
    const ops = [
      { store: 'photos', type: 'put', value: p },
      { store: 'blobs', type: 'put', key: p.id + ':o', value: o },
      ...(await touchOps(listingId)),
    ];
    await backend.batch(ops);
    return p;
  });
}

/** 讀原圖 Blob */
export function getOriginal(photoId) {
  if (!isValidId(photoId)) return Promise.resolve(null);
  return safe(async () => unwrap(await backend.get('blobs', photoId + ':o')));
}

/** 讀修圖結果 Blob（沒有就回傳 null） */
export function getEdited(photoId) {
  if (!isValidId(photoId)) return Promise.resolve(null);
  return safe(async () => unwrap(await backend.get('blobs', photoId + ':e')));
}

/**
 * 儲存修圖結果。editedBlob 為 null 代表「恢復原圖」（刪除修圖結果）。
 * 原圖永遠不會被動到。
 */
export function saveEdited(photoId, editedBlob, thumbBlob) {
  return safe(async () => {
    requireId(photoId, '照片');
    const p = await backend.get('photos', photoId);
    if (!p) throw new Error('找不到這張照片');
    const ops = [];
    if (editedBlob) {
      p.edited = true;
      p.editedAt = now();
      p.thumb = thumbBlob ? await wrap(thumbBlob) : p.thumb;
      ops.push({ store: 'blobs', type: 'put', key: photoId + ':e', value: await wrap(editedBlob) });
    } else {
      p.edited = false;
      p.editedAt = null;
      p.thumb = p.origThumb;
      ops.push({ store: 'blobs', type: 'delete', key: photoId + ':e' });
    }
    ops.unshift({ store: 'photos', type: 'put', value: p });
    ops.push(...(await touchOps(p.listingId)));
    await backend.batch(ops);
    return p;
  });
}

export function deletePhoto(photoId) {
  return safe(async () => {
    requireId(photoId, '照片');
    const p = await backend.get('photos', photoId);
    const ops = [
      { store: 'photos', type: 'delete', key: photoId },
      { store: 'blobs', type: 'delete', key: photoId + ':o' },
      { store: 'blobs', type: 'delete', key: photoId + ':e' },
    ];
    if (p) ops.push(...(await touchOps(p.listingId)));
    await backend.batch(ops);
  });
}
