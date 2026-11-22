// lib/engines.js — 動態載入 AI 引擎（engine/local.js、engine/gemini.js）
// 引擎檔案可能還沒放好或載入失敗；用動態 import() 包 try/catch，
// 讓介面照常開啟，只在真正要用時顯示友善的錯誤。

let localP = null;
let geminiP = null;

/** 載入本機引擎模組 */
export function getLocalEngine() {
  if (!localP) {
    localP = import('../engine/local.js').catch((e) => {
      localP = null; // 下次可以再試
      console.error('engine/local.js 載入失敗', e);
      throw new Error('找不到本機 AI 引擎（engine/local.js），或載入失敗。請確認檔案完整後重新整理頁面。');
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
      throw new Error('找不到強力模式引擎（engine/gemini.js），或載入失敗。請確認檔案完整後重新整理頁面。');
    });
  }
  return geminiP;
}

// ---------------- 本機模型預先載入（背景下載、可多處訂閱進度） ----------------
const model = { status: 'idle', promise: null, last: null, error: null };
const listeners = new Set();

/** 訂閱模型下載進度，回傳取消訂閱函式 */
export function onModelProgress(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 'idle' | 'loading' | 'ready' | 'error' */
export function localModelStatus() { return model.status; }

/** 確保本機模型已載入（重複呼叫只會下載一次） */
export function ensureLocalModel() {
  if (model.status === 'ready' && model.promise) return model.promise;
  if (model.promise) return model.promise;
  model.status = 'loading';
  model.error = null;
  model.promise = (async () => {
    const mod = await getLocalEngine();
    await mod.loadLocalModel((p) => {
      model.last = p;
      for (const fn of listeners) { try { fn(p); } catch { /* 忽略 */ } }
    });
    model.status = 'ready';
    return mod;
  })().catch((e) => {
    model.status = 'error';
    model.error = e;
    model.promise = null;
    throw new Error(errorMessage(e));
  });
  return model.promise;
}

/** 取得本機引擎資訊（未載入時回傳 null） */
export async function localEngineInfo() {
  try {
    const mod = await getLocalEngine();
    return mod.getLocalEngineInfo ? mod.getLocalEngineInfo() : null;
  } catch { return null; }
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
const hasCJK = (s) => /[一-鿿]/.test(s);
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

/** 錯誤 → 使用者看得懂的中文 */
export function errorMessage(e) {
  const msg = (e && (e.message || String(e))) || '未知錯誤';
  if (hasCJK(msg)) return msg;
  if (/failed to fetch|network|load failed|net::/i.test(msg)) return '網路連線有問題，請確認網路後再試。';
  if (/memory|allocation|out of memory|OOM|RangeError/i.test(msg)) return '手機記憶體不足。請關閉其他 App，或一次塗小一點範圍後再試。';
  if (/quota/i.test(msg)) return '手機儲存空間不足，請刪除一些舊照片後再試。';
  return '發生錯誤：' + msg;
}
