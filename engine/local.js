// engine/local.js — 本機（手機瀏覽器端）AI 移除雜物引擎
// 介面見 CONTRACT.md：loadLocalModel / inpaintLocal / getLocalEngineInfo
//
// 預設模型：MI-GAN「pipeline」ONNX（Picsart AI Research, MIT License）
//   https://huggingface.co/andraniksargsyan/migan  → migan_pipeline_v2.onnx（28,079,181 bytes）
//   輸入  image: uint8 [1,3,H,W]（RGB, 0..255, NCHW, H/W 可變）
//         mask : uint8 [1,1,H,W]（255 = 保留、0 = 要補的洞）
//   輸出  result: uint8 [1,3,H,W]
// 備用模型（選用）：Carve/LaMa-ONNX lama_fp32.onnx（約 208MB，固定 512×512，float32）
//
// iOS Safari 注意事項（本檔的設計重點）：
//  - iOS 一律只用 WASM（ort.wasm.min.mjs，約 11MB 的 wasm，比 WebGPU 版 22MB 省記憶體）；
//    MI-GAN 的 uint8 + ScatterND + 動態尺寸在 iOS WebGPU 上不穩定。
//  - Safari 限制畫布總記憶體（數百 MB）與單張面積（約 16.7MP），超過時 getContext 會回傳 null。
//    本檔只配置「一張」全尺寸輸出畫布；遮罩分析與裁切取樣都用分段 getImageData 讀取，
//    不另外產生全尺寸或大尺寸的暫存畫布；模型工作尺寸 ≤ 512。
//  - 所有丟出的錯誤都是 Error：.message 為繁中友善訊息，.code 為錯誤類型，.detail 保留原始英文。

const ORT_VERSION = '1.22.0';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
// 已確認存在於 jsDelivr（1.22.0/dist）：
//   ort.wasm.min.mjs   → 使用 ort-wasm-simd-threaded.mjs + ort-wasm-simd-threaded.wasm（約 11.2MB）
//   ort.webgpu.min.mjs → 使用 ort-wasm-simd-threaded.jsep.mjs + ort-wasm-simd-threaded.jsep.wasm（約 21.9MB）
const ORT_WASM_URL = ORT_BASE + 'ort.wasm.min.mjs';
const ORT_WEBGPU_URL = ORT_BASE + 'ort.webgpu.min.mjs';
const CACHE_NAME = 'house-ai-models-v1';

const IS_IOS = (() => {
  try {
    const ua = navigator.userAgent || '';
    return /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  } catch { return false; }
})();

export const LOCAL_MODELS = {
  migan: {
    id: 'migan',
    name: 'MI-GAN',
    file: 'migan_pipeline_v2.onnx',
    hfUrl: 'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx',
    size: 28079181,
    workSize: 512,
    kind: 'migan-pipeline',
  },
  lama: {
    id: 'lama',
    name: 'LaMa',
    file: 'lama_fp32.onnx',
    hfUrl: 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx',
    size: 208044816,
    workSize: 512,
    kind: 'lama-fixed512',
  },
};

let currentModelId = 'migan';
let ortModule = null;
let ortBundle = null;        // 'wasm' | 'webgpu'（實際載入的 ORT 套件）
let ortImportAttempts = 0;
let session = null;
let sessionBackend = 'wasm'; // 目前 session 的後端
let backend = 'wasm';        // 對外回報
let ready = false;
let loadPromise = null;      // 進行中的載入（失敗後會清掉，下次可重試）
let generation = 0;          // releaseSession 時遞增，作廢進行中的舊載入
let preferWasm = IS_IOS;     // WebGPU 失敗過一次就固定用 WASM
let lastError = null;        // 最近一次錯誤的原始英文細節
let inferQueue = Promise.resolve(); // 推論排隊，避免同時跑兩次

/** 選用：切換模型（'migan' | 'lama'）。切換後需重新 loadLocalModel。 */
export function selectLocalModel(id) {
  if (!LOCAL_MODELS[id]) throw engineError('MODEL_INIT', '未知的模型：' + id, 'unknown model id ' + id);
  if (id === currentModelId) return;
  currentModelId = id;
  releaseSession();
}

export function getLocalEngineInfo() {
  const m = LOCAL_MODELS[currentModelId];
  return {
    name: m.name, backend, ready, model: m.file, ortVersion: ORT_VERSION,
    ortBundle, platform: IS_IOS ? 'ios' : 'other', lastError,
  };
}

// ───────────────────────── 錯誤 ─────────────────────────

const FRIENDLY = {
  MODEL_DOWNLOAD: 'AI 模型下載失敗，請確認網路連線後再試一次。',
  MODEL_INIT: 'AI 引擎啟動失敗。請關閉其他 App，或完全關閉後重新開啟本 App 再試。',
  OUT_OF_MEMORY: '手機記憶體不足，AI 無法完成。請關閉其他 App（必要時完全關閉後重新開啟本 App）再試，或把要移除的範圍塗小一點。',
  CANVAS: '照片太大，手機記憶體不足以處理。請關閉其他 App 或重新開啟本 App 後再試。',
  INFERENCE: 'AI 修圖失敗，請重試；若一直失敗，請改用強力模式。',
  MASK: '遮罩尺寸與照片不符，請重新塗抹。',
};

class LocalEngineError extends Error {
  constructor(code, message, detail, cause) {
    super(message || FRIENDLY[code] || FRIENDLY.INFERENCE);
    this.name = 'LocalEngineError';
    this.code = code;
    this.detail = detail || null;
    this.friendly = true;
    if (cause !== undefined) this.cause = cause;
  }
}

function engineError(code, message, detail, cause) {
  return new LocalEngineError(code, message, detail, cause);
}

/** 把任何丟出的東西轉成「名稱: 訊息 + 前幾行 stack」字串 */
function errDetail(e, depth = 0) {
  if (e == null) return 'unknown error (' + e + ')';
  if (e instanceof LocalEngineError && e.detail) return e.detail;
  let name, msg;
  if (typeof e === 'object') {
    name = e.name || (e.constructor && e.constructor.name) || 'Object';
    msg = e.message != null ? String(e.message) : safeString(e);
  } else {
    name = typeof e; msg = String(e);
  }
  let s = `${name}: ${msg}`;
  if (e && e.stack) {
    const lines = String(e.stack).split('\n').filter((l) => l.trim()).slice(0, 4);
    if (lines.length) s += '\n' + lines.join('\n');
  }
  if (e && e.cause && depth < 3) s += '\n← ' + errDetail(e.cause, depth + 1);
  return s;
}

function safeString(x) {
  try { return JSON.stringify(x); } catch { try { return String(x); } catch { return '?'; } }
}

const RE_OOM = /out of memory|array buffer allocation failed|allocation failed|could not allocate|cannot enlarge memory|failed to grow|bad_alloc|RangeError|Aborted\(|memory access out of bounds|out of bounds memory access|\bOOM\b/i;
const RE_CANVAS = /null is not an object|cannot read propert(y|ies) of null|getContext|InvalidStateError|invalid state|canvas/i;
const RE_DOWNLOAD = /load failed|failed to fetch|networkerror|network connection|network error|importing a module script failed|dynamically imported module|HTTP \d{3}|invalid model bytes|not a model file/i;
const RE_INIT = /no available backend|WebAssembly|\bwasm\b|backend|InferenceSession|failed to create session|session/i;

/** 只取「名稱: 訊息」（含 cause），不含 stack，避免函式名稱（如 makeCanvas）誤判分類 */
function classText(e, depth = 0) {
  if (e == null) return '';
  let s;
  if (typeof e === 'object') {
    s = `${e.name || ''}: ${e.message != null ? e.message : safeString(e)}`;
    if (e.cause && depth < 3) s += ' | ' + classText(e.cause, depth + 1);
  } else s = String(e);
  return s;
}

/** 依原始錯誤文字分類 → LocalEngineError（已是 LocalEngineError 則原樣回傳） */
function normalize(e, defaultCode) {
  if (e instanceof LocalEngineError) return e;
  const detail = errDetail(e);
  const s = classText(e);
  let code = defaultCode;
  if (RE_OOM.test(s)) code = 'OUT_OF_MEMORY';
  else if (defaultCode === 'INFERENCE' && RE_CANVAS.test(s)) code = 'CANVAS'; // 載入階段不會碰畫布
  else if (RE_DOWNLOAD.test(s)) code = 'MODEL_DOWNLOAD';
  else if (defaultCode !== 'INFERENCE' && RE_INIT.test(s)) code = 'MODEL_INIT';
  return engineError(code, FRIENDLY[code], detail, e);
}

function log(...a) { console.log('[local-ai]', ...a); }

function sleep0() { return new Promise((r) => setTimeout(r, 0)); }

function withTimeout(p, ms, label) {
  let t = null;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label + ' timed out after ' + ms + 'ms')), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

// ───────────────────────── ORT 與模型載入 ─────────────────────────

async function loadOrt() {
  if (ortModule) return ortModule;
  const urls = IS_IOS ? [ORT_WASM_URL] : [ORT_WEBGPU_URL, ORT_WASM_URL];
  let lastErr = null;
  for (const base of urls) {
    // 失敗過的模組網址可能被瀏覽器記住，重試時加查詢字串
    const url = ortImportAttempts > 0 ? `${base}?retry=${ortImportAttempts}` : base;
    ortImportAttempts++;
    try {
      const mod = await import(url);
      const ort = mod && mod.InferenceSession ? mod : (mod && mod.default) || mod;
      if (!ort || !ort.InferenceSession || !ort.env) throw new Error('onnxruntime-web module has no InferenceSession');
      ort.env.wasm.wasmPaths = ORT_BASE;
      // GitHub Pages 沒有 cross-origin isolation → 只能單執行緒；iOS 一律單執行緒以省記憶體
      const hc = navigator.hardwareConcurrency || 1;
      ort.env.wasm.numThreads = (self.crossOriginIsolated === true && !IS_IOS) ? Math.max(1, Math.min(4, hc)) : 1;
      ort.env.wasm.proxy = false;
      ortModule = ort;
      ortBundle = base === ORT_WASM_URL ? 'wasm' : 'webgpu';
      if (ortBundle === 'wasm') preferWasm = true;
      log('ORT loaded', url, 'threads', ort.env.wasm.numThreads, 'ios', IS_IOS);
      return ort;
    } catch (e) {
      lastErr = e;
      console.warn('[local-ai] ORT 載入失敗', url, e);
    }
  }
  const err = normalize(lastErr, 'MODEL_DOWNLOAD');
  if (err.code === 'MODEL_INIT') err.message = 'AI 引擎載入失敗，請確認網路連線後重試。';
  throw err;
}

function cacheAvailable() {
  try { return typeof caches !== 'undefined' && !!caches.open; } catch { return false; }
}

/** 讀取 Response（串流回報進度），回傳 Uint8Array */
async function readWithProgress(resp, onProgress, expected) {
  const total = Number(resp.headers.get('content-length')) || expected || 0;
  if (!resp.body || !resp.body.getReader) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    onProgress({ loaded: buf.byteLength, total: buf.byteLength, stage: 'download' });
    return buf;
  }
  const reader = resp.body.getReader();
  // 已知大小就預先配置，避免收完再拼接造成雙倍記憶體
  let buf = total ? new Uint8Array(total) : null;
  const chunks = [];
  let loaded = 0, lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (buf) {
      if (loaded + value.byteLength > buf.byteLength) { // 大小不符，改為動態
        chunks.push(buf.subarray(0, loaded)); buf = null;
        chunks.push(value);
      } else buf.set(value, loaded);
    } else chunks.push(value);
    loaded += value.byteLength;
    const now = performance.now();
    if (now - lastReport > 100) { lastReport = now; onProgress({ loaded, total, stage: 'download' }); }
  }
  onProgress({ loaded, total: total || loaded, stage: 'download' });
  if (buf) return loaded === buf.byteLength ? buf : buf.slice(0, loaded);
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

function looksLikeOnnx(bytes, model) {
  // 排除 GitHub Pages 的 404 HTML、Git LFS 指標檔（約 130 bytes）等
  if (!bytes || bytes.byteLength < 1_000_000) return false;
  if (model.size && Math.abs(bytes.byteLength - model.size) > 1024) {
    console.warn('[local-ai] 模型大小與預期不同', bytes.byteLength, model.size);
  }
  return bytes[0] === 0x08; // ModelProto 第一個欄位 ir_version (field 1, varint)
}

async function fetchModelBytes(model, onProgress) {
  const cacheKey = model.hfUrl; // 不論從哪下載，都用固定鍵快取
  let cache = null;
  if (cacheAvailable()) {
    try {
      cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(cacheKey);
      if (hit) {
        onProgress({ loaded: 0, total: model.size, stage: 'cache' });
        const bytes = new Uint8Array(await hit.arrayBuffer());
        if (looksLikeOnnx(bytes, model)) {
          onProgress({ loaded: bytes.byteLength, total: bytes.byteLength, stage: 'cache' });
          log('model from Cache Storage', bytes.byteLength);
          return bytes;
        }
        await cache.delete(cacheKey);
      }
    } catch (e) {
      if (RE_OOM.test(classText(e))) throw normalize(e, 'OUT_OF_MEMORY');
      console.warn('[local-ai] Cache Storage 無法使用', e); cache = null;
    }
  }

  const sources = [new URL('../models/' + model.file, import.meta.url).href, model.hfUrl];
  let bytes = null, lastErr = null;
  for (const url of sources) {
    try {
      const resp = await fetch(url, { cache: 'no-cache' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + url);
      const ct = resp.headers.get('content-type') || '';
      if (/text\/html/i.test(ct)) throw new Error('not a model file (' + ct + ') ' + url);
      const b = await readWithProgress(resp, onProgress, model.size);
      if (!looksLikeOnnx(b, model)) throw new Error('invalid model bytes (' + b.byteLength + ') ' + url);
      bytes = b;
      log('model downloaded from', url, b.byteLength);
      break;
    } catch (e) {
      lastErr = e;
      console.warn('[local-ai] 模型來源失敗', url, e);
      if (RE_OOM.test(classText(e))) throw normalize(e, 'OUT_OF_MEMORY');
    }
  }
  if (!bytes) {
    const err = normalize(lastErr, 'MODEL_DOWNLOAD');
    if (err.code !== 'OUT_OF_MEMORY') { err.code = 'MODEL_DOWNLOAD'; err.message = FRIENDLY.MODEL_DOWNLOAD; }
    throw err;
  }

  if (cache) {
    try {
      await cache.put(cacheKey, new Response(bytes, {
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) },
      }));
    } catch (e) { console.warn('[local-ai] 無法寫入快取（空間不足？）', e); }
  }
  return bytes;
}

async function hasWebGPU() {
  try {
    if (IS_IOS || !navigator.gpu) return false;
    const adapter = await withTimeout(navigator.gpu.requestAdapter(), 3000, 'requestAdapter');
    return !!adapter;
  } catch { return false; }
}

function sessionOptions(ep) {
  return {
    executionProviders: [ep],
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
    // 記憶體配置模式（mem pattern）會依「每種輸入尺寸」預先規劃並保留一整塊記憶體；
    // 我們每次裁切尺寸都不同（動態 H/W），開著反而會累積多份規劃、提高峰值 → 關閉。
    enableMemPattern: false,
    // CPU arena 會成塊保留記憶體且不歸還；iOS 記憶體上限低，關閉以壓低峰值（速度略慢，512 尺寸影響很小）。
    enableCpuMemArena: !IS_IOS,
  };
}

function releaseSession() {
  const s = session;
  generation++;
  session = null; ready = false; loadPromise = null;
  if (s && s.release) {
    try { Promise.resolve(s.release()).catch(() => {}); } catch { /* 忽略 */ }
  }
}

/** 實際載入：回傳 {session, backend}；錯誤一律為 LocalEngineError */
async function doLoad(progress) {
  const model = LOCAL_MODELS[currentModelId];
  const ort = await loadOrt();
  let bytes = await fetchModelBytes(model, progress);
  progress({ loaded: bytes.byteLength, total: bytes.byteLength, stage: 'init' });
  await sleep0(); // 讓進度文字先畫出來
  const t0 = performance.now();
  let s = null, be = 'wasm';
  try {
    if (!preferWasm && ortBundle === 'webgpu' && await hasWebGPU()) {
      try {
        s = await withTimeout(ort.InferenceSession.create(bytes, sessionOptions('webgpu')), 60000, 'webgpu session create');
        be = 'webgpu';
      } catch (e) {
        console.warn('[local-ai] WebGPU 初始化失敗，改用 WASM', e);
        preferWasm = true;
        s = null;
      }
    }
    if (!s) {
      try {
        s = await ort.InferenceSession.create(bytes, sessionOptions('wasm'));
        be = 'wasm';
      } catch (e) {
        throw normalize(e, 'MODEL_INIT');
      }
    }
  } finally {
    bytes = null; // 模型已複製進 wasm 記憶體，放掉 JS 端的 28MB
  }
  log(`session ready: ${model.file} on ${be} in ${Math.round(performance.now() - t0)}ms`,
    'inputs', s.inputNames, 'outputs', s.outputNames, 'threads', ort.env.wasm.numThreads);
  return { session: s, backend: be };
}

const progressListeners = new Set();
const READY_EVT = { loaded: 1, total: 1, stage: 'ready' };
function safeCall(fn, p) { try { fn(p); } catch (e) { console.warn(e); } }
function broadcast(p) { for (const fn of progressListeners) safeCall(fn, p); }

/** 取得（必要時載入）session。同時呼叫共用同一個 Promise；失敗後下次會重新嘗試。 */
function ensureSession(onProgress) {
  if (ready && session) {
    if (onProgress) safeCall(onProgress, READY_EVT);
    return Promise.resolve(session);
  }
  if (onProgress) progressListeners.add(onProgress);
  if (!loadPromise) {
    const gen = generation;
    const p = (async () => {
      const r = await doLoad(broadcast);
      if (gen !== generation) { // 載入期間被 releaseSession 作廢（例如切換模型）
        try { Promise.resolve(r.session.release()).catch(() => {}); } catch { /* 忽略 */ }
        return null;
      }
      session = r.session; sessionBackend = r.backend; backend = r.backend; ready = true;
      broadcast(READY_EVT);
      return session;
    })();
    loadPromise = p;
    p.then(
      () => { progressListeners.clear(); },
      () => { if (loadPromise === p) loadPromise = null; progressListeners.clear(); },
    );
  }
  return loadPromise.then(
    (s) => s || ensureSession(onProgress),
    (e) => { const err = normalize(e, 'MODEL_INIT'); lastError = err.detail; throw err; },
  );
}

/** 預先載入模型；可重複呼叫（共用同一個 Promise）。onProgress({loaded,total,stage}) */
export async function loadLocalModel(onProgress) {
  try {
    await ensureSession(onProgress);
    return getLocalEngineInfo();
  } catch (e) {
    const err = normalize(e, 'MODEL_INIT');
    lastError = err.detail;
    throw err;
  }
}

// ───────────────────────── 影像工具 ─────────────────────────

const STRIP_BYTES = 4 * 1024 * 1024; // 分段讀取像素，每段約 4MB

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function freeCanvas(c) {
  if (c) { try { c.width = 0; c.height = 0; } catch { /* 忽略 */ } }
}

/** 取得 2D context；Safari 超過畫布記憶體上限時會回傳 null → 丟出友善錯誤 */
function getCtx(c, readback, what) {
  let g = null;
  try { g = c.getContext('2d', readback ? { willReadFrequently: true } : undefined); } catch { g = null; }
  if (!g) {
    throw engineError('CANVAS', FRIENDLY.CANVAS,
      `getContext('2d') returned null for ${what} canvas ${c.width}x${c.height} (canvas memory limit?)`);
  }
  return g;
}

function stripRows(width) {
  return Math.max(1, Math.floor(STRIP_BYTES / (Math.max(1, width) * 4)));
}

/** 二值遮罩方形膨脹（可分離 max filter），m: Uint8Array 0/1 */
function dilate(m, w, h, r) {
  if (r <= 0) return m;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let last = -1e9;
    for (let x = 0; x < w; x++) { if (m[row + x]) last = x; if (x - last <= r) tmp[row + x] = 1; }
    last = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (m[row + x]) last = x; if (last - x <= r) tmp[row + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= r) out[y * w + x] = 1; }
    last = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= r) out[y * w + x] = 1; }
  }
  return out;
}

/** 盒狀模糊（3 次近似高斯），輸入 Float32Array 0..1（就地修改） */
function boxBlur(src, w, h, r, passes = 3) {
  if (r <= 0) return src;
  const a = src, b = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) { // 水平
      const row = y * w; let s = 0;
      for (let x = -r; x <= r; x++) s += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[row + x] = s / n;
        s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) { // 垂直
      let s = 0;
      for (let y = -r; y <= r; y++) s += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = s / n;
        s += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  return a;
}

/**
 * 從 ctx 的 (x,y,cw,ch) 區域取樣成 ww×wh 的 RGBA（alpha=255）。
 * 縮小時用分段 getImageData + 區域平均（不建立任何大畫布）；放大（僅 LaMa 小圖）才用小畫布。
 */
function sampleRegionRGBA(srcCtx, x, y, cw, ch, ww, wh) {
  const n = ww * wh;
  if (ww > cw || wh > ch) {
    const c = makeCanvas(ww, wh);
    try {
      const g = getCtx(c, true, 'sample');
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(srcCtx.canvas, x, y, cw, ch, 0, 0, ww, wh);
      const d = g.getImageData(0, 0, ww, wh).data;
      for (let i = 3; i < d.length; i += 4) d[i] = 255;
      return d;
    } finally { freeCanvas(c); }
  }
  const sum = new Uint32Array(n * 3);
  const cnt = new Uint32Array(n);
  const xmap = new Int32Array(cw);
  for (let sx = 0; sx < cw; sx++) xmap[sx] = Math.min(ww - 1, Math.floor((sx * ww) / cw));
  const rows = stripRows(cw);
  for (let sy0 = 0; sy0 < ch; sy0 += rows) {
    const rh = Math.min(rows, ch - sy0);
    const d = srcCtx.getImageData(x, y + sy0, cw, rh).data;
    for (let r = 0; r < rh; r++) {
      const rowBase = Math.min(wh - 1, Math.floor(((sy0 + r) * wh) / ch)) * ww;
      let i = r * cw * 4;
      for (let sx = 0; sx < cw; sx++, i += 4) {
        const c = rowBase + xmap[sx];
        const c3 = c * 3;
        sum[c3] += d[i]; sum[c3 + 1] += d[i + 1]; sum[c3 + 2] += d[i + 2];
        cnt[c]++;
      }
    }
  }
  const out = new Uint8ClampedArray(n * 4);
  for (let c = 0; c < n; c++) {
    const k = cnt[c] || 1, c3 = c * 3, o = c * 4;
    out[o] = sum[c3] / k; out[o + 1] = sum[c3 + 1] / k; out[o + 2] = sum[c3 + 2] / k; out[o + 3] = 255;
  }
  return out;
}

/**
 * 遮罩 (x,y,cw,ch) 區域 → ww×wh 的 0/1 陣列。
 * 用「任一像素 R>127 即為洞」的最大值池化，細筆畫縮小後也不會消失。
 */
function sampleRegionMask(maskCtx, x, y, cw, ch, ww, wh) {
  const m = new Uint8Array(ww * wh);
  const xlo = new Int32Array(cw), xhi = new Int32Array(cw);
  for (let sx = 0; sx < cw; sx++) {
    const lo = Math.min(ww - 1, Math.floor((sx * ww) / cw));
    xlo[sx] = lo;
    xhi[sx] = Math.min(ww - 1, Math.max(lo, Math.ceil(((sx + 1) * ww) / cw) - 1));
  }
  const rows = stripRows(cw);
  for (let sy0 = 0; sy0 < ch; sy0 += rows) {
    const rh = Math.min(rows, ch - sy0);
    const d = maskCtx.getImageData(x, y + sy0, cw, rh).data;
    for (let r = 0; r < rh; r++) {
      const sy = sy0 + r;
      const ylo = Math.min(wh - 1, Math.floor((sy * wh) / ch));
      const yhi = Math.min(wh - 1, Math.max(ylo, Math.ceil(((sy + 1) * wh) / ch) - 1));
      let i = r * cw * 4;
      for (let sx = 0; sx < cw; sx++, i += 4) {
        if (d[i] > 127) {
          for (let cy = ylo; cy <= yhi; cy++) {
            const row = cy * ww;
            for (let cx = xlo[sx]; cx <= xhi[sx]; cx++) m[row + cx] = 1;
          }
        }
      }
    }
  }
  return m;
}

// ───────────────────────── 遮罩分析 ─────────────────────────

const MAP_MAX = 1024;

/** 在縮小的遮罩圖（最大值池化）上找連通區塊，回傳原圖座標的外框陣列 */
function findMaskRegions(maskCtx, W, H) {
  const f = Math.max(1, Math.ceil(Math.max(W, H) / MAP_MAX));
  const mw = Math.ceil(W / f), mh = Math.ceil(H / f);
  const m = new Uint8Array(mw * mh);
  let any = false;
  const rows = stripRows(W);
  for (let y0 = 0; y0 < H; y0 += rows) {
    const rh = Math.min(rows, H - y0);
    const d = maskCtx.getImageData(0, y0, W, rh).data;
    for (let r = 0; r < rh; r++) {
      const row = (((y0 + r) / f) | 0) * mw;
      let i = r * W * 4;
      for (let x = 0; x < W; x++, i += 4) {
        if (d[i] > 127) { m[row + ((x / f) | 0)] = 1; any = true; }
      }
    }
  }
  if (!any) return [];

  const label = new Int32Array(mw * mh);
  const boxes = [];
  const stack = new Int32Array(mw * mh);
  let next = 0;
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || label[i]) continue;
    next++;
    let sp = 0; stack[sp++] = i; label[i] = next;
    let x0 = mw, y0 = mh, x1 = -1, y1 = -1;
    while (sp) {
      const p = stack[--sp];
      const px = p % mw, py = (p / mw) | 0;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy; if (ny < 0 || ny >= mh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx; if (nx < 0 || nx >= mw) continue;
          const q = ny * mw + nx;
          if (m[q] && !label[q]) { label[q] = next; stack[sp++] = q; }
        }
      }
    }
    boxes.push({
      x0: Math.max(0, (x0 - 1) * f), y0: Math.max(0, (y0 - 1) * f),
      x1: Math.min(W, (x1 + 2) * f), y1: Math.min(H, (y1 + 2) * f),
    });
  }
  return boxes;
}

/** 依遮罩外框計算要裁切的區域（加大量留邊、盡量方形、夾在圖內） */
function cropForBox(b, W, H) {
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const size = Math.max(bw, bh);
  const pad = Math.max(size * 0.6, 64);
  let side = Math.ceil(size + 2 * pad);
  side = Math.max(side, Math.min(512, W, H)); // 至少給 512 原生像素的周邊參考
  const cw = Math.min(side, W), ch = Math.min(side, H);
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const x = Math.round(Math.min(Math.max(cx - cw / 2, 0), W - cw));
  const y = Math.round(Math.min(Math.max(cy - ch / 2, 0), H - ch));
  return { x, y, w: Math.round(cw), h: Math.round(ch), box: { ...b } };
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 合併裁切區重疊的區塊，回傳不重疊的裁切區 */
function planCrops(boxes, W, H) {
  const crops = boxes.map((b) => cropForBox(b, W, H));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < crops.length; i++) {
      for (let j = i + 1; j < crops.length; j++) {
        if (overlaps(crops[i], crops[j])) {
          const a = crops[i].box, b = crops[j].box;
          const u = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
          crops.splice(j, 1);
          crops[i] = cropForBox(u, W, H);
          merged = true;
          break outer;
        }
      }
    }
  }
  return crops;
}

// ───────────────────────── 推論 ─────────────────────────

// 以「模型工作解析度」的像素為單位
const INFER_DILATE = 12; // 推論前把洞擴張（雜物邊緣、陰影）
const COMP_DILATE = 6;   // 貼回時的遮罩擴張
const COMP_BLUR = 2;     // 羽化半徑（3 次盒狀模糊，影響範圍約 6 ≤ COMP_DILATE，原本的洞內 alpha 維持 1）

/** 跑一次模型，回傳 RGBA Uint8ClampedArray（w×h，alpha=255）。張量一律在 finally 釋放。 */
async function runModel(s, model, rgba, hole, w, h) {
  const ort = ortModule;
  const n = w * h;
  let feeds = {};
  let results = null;
  try {
    let outName;
    if (model.kind === 'migan-pipeline') {
      const img = new Uint8Array(3 * n);
      const msk = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        img[i] = rgba[i * 4]; img[n + i] = rgba[i * 4 + 1]; img[2 * n + i] = rgba[i * 4 + 2];
        msk[i] = hole[i] ? 0 : 255; // MI-GAN：0 = 洞，255 = 保留
      }
      feeds.image = new ort.Tensor('uint8', img, [1, 3, h, w]);
      feeds.mask = new ort.Tensor('uint8', msk, [1, 1, h, w]);
      outName = 'result';
    } else { // LaMa 固定 512×512
      const img = new Float32Array(3 * n);
      const msk = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        img[i] = rgba[i * 4] / 255; img[n + i] = rgba[i * 4 + 1] / 255; img[2 * n + i] = rgba[i * 4 + 2] / 255;
        msk[i] = hole[i] ? 1 : 0;
      }
      feeds.image = new ort.Tensor('float32', img, [1, 3, h, w]);
      feeds.mask = new ort.Tensor('float32', msk, [1, 1, h, w]);
      outName = 'output';
    }
    const names = s.inputNames || [];
    if (names.length === 2 && !names.includes('image')) { // 保險：名稱不同時依順序對應
      feeds = { [names[0]]: feeds.image, [names[1]]: feeds.mask };
    }
    results = await s.run(feeds);
    const outT = results[outName] || results[(s.outputNames || [])[0]];
    if (!outT) throw new Error('model returned no output tensor');
    const data = (outT.location && outT.location !== 'cpu' && outT.getData) ? await outT.getData() : outT.data;
    const dims = outT.dims;
    const oh = dims[2], ow = dims[3];
    if (ow !== w || oh !== h || !data || data.length < 3 * n) throw new Error(`unexpected output dims ${dims}`);

    let scale = 1;
    if (!(data instanceof Uint8Array)) {
      let mx = 0;
      for (let i = 0; i < data.length; i += 97) if (data[i] > mx) mx = data[i];
      scale = mx <= 1.5 ? 255 : 1;
    }
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      out[i * 4] = data[i] * scale;
      out[i * 4 + 1] = data[n + i] * scale;
      out[i * 4 + 2] = data[2 * n + i] * scale;
      out[i * 4 + 3] = 255;
    }
    return out;
  } finally {
    for (const t of Object.values(feeds)) { try { t && t.dispose && t.dispose(); } catch { /* 忽略 */ } }
    if (results) {
      for (const t of Object.values(results)) { try { t && t.dispose && t.dispose(); } catch { /* 忽略 */ } }
    }
  }
}

/** 推論；WebGPU 在執行時失敗（含 device lost 等被拒絕的 Promise、逾時）→ 透明地改用 WASM 重跑 */
async function runWithFallback(model, rgba, hole, w, h, onProgress) {
  const s = await ensureSession(); // inpaintJob 已確保載入，這裡不重複回報進度
  const be = sessionBackend;
  try {
    const p = runModel(s, model, rgba, hole, w, h);
    return await (be === 'webgpu' ? withTimeout(p, 60000, 'webgpu run') : p);
  } catch (e) {
    if (be !== 'webgpu') throw e;
    console.warn('[local-ai] WebGPU 推論失敗，改用 WASM 重試', e);
    preferWasm = true;
    if (session === s) releaseSession();
    const s2 = await ensureSession(onProgress);
    return await runModel(s2, model, rgba, hole, w, h);
  }
}

/** 處理單一裁切區，直接畫回 out 畫布（只建立一張 ≤512 的小畫布） */
async function inpaintCrop(og, maskCtx, crop, model, onProgress) {
  const { x, y, w: cw, h: ch } = crop;
  let ww, wh;
  if (model.kind === 'lama-fixed512') { ww = wh = model.workSize; }
  else {
    const s = Math.min(1, model.workSize / Math.max(cw, ch));
    ww = Math.max(8, Math.round(cw * s)); wh = Math.max(8, Math.round(ch * s));
  }

  // 取圖（從目前的 out 取，前一個區塊修好的結果也能當參考）
  const rgba = sampleRegionRGBA(og, x, y, cw, ch, ww, wh);
  const hole0 = sampleRegionMask(maskCtx, x, y, cw, ch, ww, wh);
  const holeInfer = dilate(hole0, ww, wh, INFER_DILATE);

  const t0 = performance.now();
  const res = await runWithFallback(model, rgba, holeInfer, ww, wh, onProgress);
  log(`inference ${ww}x${wh} (crop ${cw}x${ch} @ ${x},${y}) ${Math.round(performance.now() - t0)}ms on ${backend}`);

  // 羽化 alpha 直接寫進結果的 alpha 通道（工作解析度；放大時自然平滑）
  const comp = dilate(hole0, ww, wh, COMP_DILATE);
  const af = new Float32Array(ww * wh);
  for (let i = 0; i < af.length; i++) af[i] = comp[i];
  boxBlur(af, ww, wh, COMP_BLUR);
  for (let i = 0; i < af.length; i++) {
    const a = hole0[i] ? 1 : af[i]; // 原本的洞一定完全覆蓋
    res[i * 4 + 3] = a * 255;
  }

  const patch = makeCanvas(ww, wh);
  try {
    getCtx(patch, false, 'patch').putImageData(new ImageData(res, ww, wh), 0, 0);
    og.save();
    og.globalCompositeOperation = 'source-over';
    og.globalAlpha = 1;
    og.imageSmoothingEnabled = true; og.imageSmoothingQuality = 'high';
    og.drawImage(patch, 0, 0, ww, wh, x, y, cw, ch);
    og.restore();
  } finally {
    freeCanvas(patch);
  }
}

async function inpaintJob(imageCanvas, maskCanvas, onProgress) {
  const report = (stage, loaded = 0, total = 1) => { if (onProgress) safeCall(onProgress, { stage, loaded, total }); };
  let out = null;
  const T0 = performance.now();
  try {
    if (!imageCanvas) throw engineError('CANVAS', FRIENDLY.CANVAS, 'imageCanvas is missing');
    const W = imageCanvas.naturalWidth || imageCanvas.width, H = imageCanvas.naturalHeight || imageCanvas.height;
    if (!W || !H) throw engineError('CANVAS', FRIENDLY.CANVAS, `image has zero size ${W}x${H}`);
    if (!maskCanvas || maskCanvas.width !== W || maskCanvas.height !== H) {
      throw engineError('MASK', FRIENDLY.MASK,
        `mask size ${maskCanvas ? maskCanvas.width + 'x' + maskCanvas.height : 'none'} != image ${W}x${H}`);
    }
    report('prepare');
    const maskCtx = getCtx(maskCanvas, false, 'mask');
    const boxes = findMaskRegions(maskCtx, W, H);
    const crops = boxes.length ? planCrops(boxes, W, H) : [];
    if (crops.length) {
      log(`${W}x${H}, ${boxes.length} mask region(s) → ${crops.length} crop(s)`, crops.map((c) => `${c.w}x${c.h}@${c.x},${c.y}`));
      // 模型可能還在下載/初始化：共用同一個載入 Promise
      await ensureSession(onProgress);
    }
    const model = LOCAL_MODELS[currentModelId];

    // 唯一一張全尺寸畫布（輸出），在模型就緒後才配置以降低峰值
    out = makeCanvas(W, H);
    const og = getCtx(out, true, 'output');
    og.drawImage(imageCanvas, 0, 0);

    for (let i = 0; i < crops.length; i++) {
      report('infer', i, crops.length);
      await inpaintCrop(og, maskCtx, crops[i], model, onProgress);
      await sleep0(); // 讓畫面有機會更新
    }
    report('done', crops.length || 1, crops.length || 1);
    log(`total ${Math.round(performance.now() - T0)}ms`);
    const result = out;
    out = null;
    return result;
  } catch (e) {
    const err = normalize(e, 'INFERENCE');
    lastError = err.detail;
    console.error('[local-ai] inpaint failed', err.code, err.detail);
    throw err;
  } finally {
    freeCanvas(out); // 只有失敗時 out 仍不為 null
  }
}

/**
 * imageCanvas、maskCanvas 尺寸相同；mask 白色(R>127)=要移除。
 * 回傳新的 canvas（尺寸＝原圖），遮罩外的像素保持原樣。
 * 多次呼叫會排隊依序執行；模型尚未載入完成時會等待同一個載入。
 */
export function inpaintLocal(imageCanvas, maskCanvas, onProgress) {
  const job = inferQueue.then(() => inpaintJob(imageCanvas, maskCanvas, onProgress));
  inferQueue = job.then(() => {}, () => {});
  return job;
}
