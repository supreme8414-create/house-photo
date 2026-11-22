// lib/engines.js — 動態載入 AI 引擎（engine/local.js、engine/gemini.js）
// 引擎檔案可能還沒放好或載入失敗；用動態 import() 包 try/catch，
// 讓介面照常開啟，只在真正要用時顯示友善的錯誤。
//
// 錯誤格式約定：引擎丟出的錯誤 .message 是中文、.code 是代碼（例如 OUT_OF_MEMORY）、
// .detail 是原始英文細節。這裡的 errorMessage() 永遠只回傳中文給使用者看。

let localP = null;
let geminiP = null;
let localMod = null;

/** 載入本機引擎模組 */
export function getLocalEngine() {
  if (!localP) {
    localP = import('../engine/local.js').then((m) => { localMod = m; return m; }).catch((e) => {
      localP = null; // 下次可以再試
      console.error('engine/local.js 載入失敗', e);
      throw wrapError(e, '找不到本機 AI 引擎，或載入失敗。請確認網路後重新開啟修圖器。', 'ENGINE_LOAD');
    });
  }
  return localP;
}

/** 載入 Gemini 引擎模組 */
export function getGeminiEngine() {
  if (!geminiP) {
    geminiP = import('../engine/gemini.js').catch((e) => {
      geminiP = null;
      console.error('engine/gemini.js 載入失敗', e);
      throw wrapError(e, '找不到強力模式引擎，或載入失敗。請確認網路後重新開啟修圖器。', 'ENGINE_LOAD');
    });
  }
  return geminiP;
}

// ---------------- 本機模型預先載入（背景下載、可多處訂閱進度） ----------------
const model = { status: 'idle', promise: null, last: null, ratio: null, error: null };
const listeners = new Set();

/** 訂閱模型下載進度（每次進度與狀態改變都會呼叫），回傳取消訂閱函式 */
export function onModelProgress(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(p) {
  for (const fn of listeners) { try { fn(p); } catch { /* 忽略 */ } }
}

/** 'idle' | 'loading' | 'ready' | 'error' */
export function localModelStatus() { return model.status; }

/** 模型狀態：{status, ratio(0–1 或 null), error} */
export function modelState() {
  return { status: model.status, ratio: model.ratio, error: model.error };
}

/** 確保本機模型已載入（重複呼叫只會下載一次） */
export function ensureLocalModel() {
  if (model.promise) return model.promise;
  model.status = 'loading';
  model.error = null;
  model.ratio = null;
  model.promise = (async () => {
    const mod = await getLocalEngine();
    await mod.loadLocalModel((p) => {
      model.last = p;
      model.ratio = describeProgress(p).ratio;
      emit(p);
    });
    model.status = 'ready';
    model.ratio = 1;
    emit({ stage: 'ready' });
    return mod;
  })().catch((e) => {
    model.status = 'error';
    model.promise = null;
    const f = toFriendly(e);
    model.error = f;
    emit({ stage: 'error' });
    throw f;
  });
  emit({ stage: 'init' });
  return model.promise;
}

/** 取得本機引擎資訊（未載入時回傳 null） */
export async function localEngineInfo() {
  try {
    const mod = await getLocalEngine();
    return mod.getLocalEngineInfo ? mod.getLocalEngineInfo() : null;
  } catch { return null; }
}

/** 同步取得本機引擎資訊（模組還沒載入就回傳 null；用在錯誤報告） */
export function localEngineInfoSync() {
  try { return localMod && localMod.getLocalEngineInfo ? localMod.getLocalEngineInfo() : null; }
  catch { return null; }
}

// ---------------- 進度與錯誤文字 ----------------
const STAGE_TEXT = {
  download: '下載 AI 模型中',
  downloading: '下載 AI 模型中',
  fetch: '下載 AI 模型中',
  cache: '讀取已下載的模型',
  cached: '讀取已下載的模型',
  init: '啟動 AI 引擎',
  initializing: '啟動 AI 引擎',
  session: '啟動 AI 引擎',
  compile: '啟動 AI 引擎',
  ready: 'AI 模型已就緒',
  prepare: '準備照片',
  preprocess: '準備照片',
  crop: '準備照片',
  inference: 'AI 正在移除雜物',
  infer: 'AI 正在移除雜物',
  run: 'AI 正在移除雜物',
  postprocess: '合成結果',
  blend: '合成結果',
  compose: '合成結果',
  upload: '上傳到 Gemini',
  uploading: '上傳到 Gemini',
  request: '等待 Gemini 回應',
  waiting: '等待 Gemini 回應',
  generate: 'Gemini 處理中',
  generating: 'Gemini 處理中',
  done: '完成',
};
const hasCJK = (s) => /[一-鿿]/.test(String(s || ''));
const clamp01 = (r) => Math.min(1, Math.max(0, r));

/**
 * 把引擎傳來的各種進度格式轉成 {text, ratio}
 * 支援：數字（0–1 或 0–100）、字串、{loaded,total,stage}、{progress}、{message}
 */
export function describeProgress(p, fallback = '處理中…') {
  if (p == null) return { text: fallback, ratio: null };
  if (typeof p === 'number') return { text: fallback, ratio: clamp01(p > 1 ? p / 100 : p) };
  if (typeof p === 'string') return { text: hasCJK(p) ? p : (STAGE_TEXT[p] || fallback), ratio: null };
  let ratio = null;
  if (typeof p.progress === 'number') ratio = p.progress > 1 ? p.progress / 100 : p.progress;
  else if (typeof p.ratio === 'number') ratio = p.ratio;
  else if (typeof p.loaded === 'number' && p.total > 0) ratio = p.loaded / p.total;
  if (ratio != null && Number.isFinite(ratio)) ratio = clamp01(ratio); else ratio = null;
  let text = fallback;
  if (typeof p.message === 'string' && hasCJK(p.message)) text = p.message;
  else if (typeof p.text === 'string' && hasCJK(p.text)) text = p.text;
  else if (typeof p.stage === 'string') text = hasCJK(p.stage) ? p.stage : (STAGE_TEXT[p.stage.toLowerCase()] || fallback);
  return { text, ratio };
}

const CODE_TEXT = {
  OUT_OF_MEMORY: '手機記憶體不足，AI 沒辦法完成這次處理。',
  CANVAS_CONTEXT: '手機記憶體不足，無法處理這張照片。',
  CANVAS_MEMORY: '手機記憶體不足，圖片轉檔失敗。',
  NETWORK: '網路連線有問題，請確認網路後再試。',
  MODEL_DOWNLOAD: 'AI 模型下載失敗，請確認網路後再試。',
  ENGINE_LOAD: '找不到 AI 引擎，或載入失敗。請確認網路後重新開啟修圖器。',
  NO_LISTING: '還沒開啟案件，請先回到首頁選一個案件。',
  BAD_ID: '找不到這筆資料，請回到首頁重新開啟案件。',
  STORAGE_FULL: '手機儲存空間不足，請刪除一些舊案件或照片後再試。',
  DECODE: '無法讀取這張照片（格式可能不支援，請改用 JPG）。',
};

const MEMORY_RE = /out of memory|memory|allocation|allocate|OOM|RangeError|null is not an object|getContext|Aborted\(/i;

/** 是不是記憶體不足相關的錯誤 */
export function isMemoryError(e) {
  if (!e) return false;
  if (e.code === 'OUT_OF_MEMORY' || e.code === 'CANVAS_CONTEXT' || e.code === 'CANVAS_MEMORY') return true;
  if (e.name === 'RangeError') return true;
  const raw = `${e.detail || ''} ${hasCJK(e.message) ? '' : (e.message || '')}`;
  if (MEMORY_RE.test(raw)) return true;
  return /記憶體/.test(String(e.message || ''));
}

/** 錯誤 → 使用者看得懂的中文（絕不回傳英文原文） */
export function errorMessage(e) {
  if (e == null) return '發生未預期的錯誤，請再試一次。';
  const msg = typeof e === 'string' ? e : String((e && e.message) || e);
  if (hasCJK(msg)) return msg;
  const code = e && e.code;
  if (code && CODE_TEXT[code]) return CODE_TEXT[code];
  const name = (e && e.name) || '';
  if (name === 'QuotaExceededError' || /quota/i.test(msg)) return CODE_TEXT.STORAGE_FULL;
  if (/failed to fetch|network|load failed|net::|timeout|timed out/i.test(msg)) return CODE_TEXT.NETWORK;
  if (isMemoryError(e) || MEMORY_RE.test(msg)) return '可能是手機記憶體不足，處理沒有完成。';
  if (/IDB|IndexedDB|ObjectStore|transaction|DataError|InvalidStateError/i.test(msg + ' ' + name)) {
    return '讀取手機裡的資料時發生問題，請回到首頁重新開啟案件再試一次。';
  }
  if (name === 'NotAllowedError') return '手機不允許這個動作，請再按一次試試。';
  return '發生未預期的錯誤，請再試一次。';
}

/** 原始（英文）細節，給技術資訊用 */
export function errorDetail(e) {
  if (e == null) return '';
  if (typeof e !== 'object') return String(e);
  const parts = [];
  if (e.detail) parts.push(String(e.detail));
  if (e.message && !hasCJK(e.message)) parts.push(`${e.name || 'Error'}: ${e.message}`);
  if (e.cause && e.cause !== e) {
    const c = e.cause;
    parts.push('cause: ' + (c && c.message ? `${c.name || 'Error'}: ${c.message}` : String(c)));
  }
  return [...new Set(parts)].join('\n');
}

/** 把任何錯誤轉成「中文訊息＋保留 code/detail」的錯誤 */
export function toFriendly(e) {
  if (e && typeof e === 'object' && hasCJK(e.message)) return e;
  return wrapError(e, errorMessage(e));
}

function wrapError(e, message, code) {
  const f = new Error(message);
  f.code = (e && e.code) || code || (e && e.name) || 'UNKNOWN';
  f.detail = errorDetail(e) || String(e);
  if (e && e.stack) f.originalStack = e.stack;
  f.cause = e;
  return f;
}
