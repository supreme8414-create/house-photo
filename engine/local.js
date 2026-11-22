// engine/local.js — 本機（手機瀏覽器端）AI 移除雜物引擎
// 介面見 CONTRACT.md：loadLocalModel / inpaintLocal / getLocalEngineInfo
//
// 預設模型：MI-GAN「pipeline」ONNX（Picsart AI Research, MIT License）
//   https://huggingface.co/andraniksargsyan/migan  → migan_pipeline_v2.onnx（28,079,181 bytes）
//   輸入  image: uint8 [1,3,H,W]（RGB, 0..255, NCHW, H/W 可變）
//         mask : uint8 [1,1,H,W]（255 = 保留、0 = 要補的洞）
//   輸出  result: uint8 [1,3,H,W]（整張圖，洞已補好；內部自行裁切 / 縮到 512 / 羽化貼回）
// 備用模型（選用）：Carve/LaMa-ONNX lama_fp32.onnx（約 208MB，固定 512×512，float32）
//   image float32 [1,3,512,512] 0..1；mask float32 [1,1,512,512] 1 = 洞；output float32 [1,3,512,512]（Clip 後，約 0..255）

const ORT_VERSION = '1.22.0';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const ORT_URL = ORT_BASE + 'ort.webgpu.min.mjs'; // 內含 WebGPU + WASM 兩種後端
const CACHE_NAME = 'house-ai-models-v1';

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
let session = null;
let backend = 'wasm';
let loadPromise = null;
let ready = false;

/** 選用：切換模型（'migan' | 'lama'）。切換後需重新 loadLocalModel。 */
export function selectLocalModel(id) {
  if (!LOCAL_MODELS[id]) throw new Error('未知的模型：' + id);
  if (id === currentModelId) return;
  currentModelId = id;
  releaseSession();
}

export function getLocalEngineInfo() {
  const m = LOCAL_MODELS[currentModelId];
  return { name: m.name, backend, ready, model: m.file, ortVersion: ORT_VERSION };
}

// ───────────────────────── 錯誤訊息 ─────────────────────────

class FriendlyError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'LocalEngineError';
    this.friendly = true;
    if (cause) this.cause = cause;
  }
}

function isMemoryError(e) {
  const s = String((e && (e.message || e)) || '');
  return e instanceof RangeError || /memory|OOM|allocat|Aborted|out of bounds/i.test(s);
}

function toFriendly(e, fallbackMsg) {
  if (e && e.friendly) return e;
  if (isMemoryError(e)) return new FriendlyError('手機記憶體不足，請關閉其他 App 後重試（或把要移除的範圍塗小一點）。', e);
  return new FriendlyError(fallbackMsg, e);
}

function log(...a) { console.log('[local-ai]', ...a); }

// ───────────────────────── 模型載入 ─────────────────────────

async function loadOrt() {
  if (ortModule) return ortModule;
  try {
    ortModule = await import(ORT_URL);
  } catch (e) {
    throw new FriendlyError('AI 引擎載入失敗，請確認網路連線後重試。', e);
  }
  const ort = ortModule;
  ort.env.wasm.wasmPaths = ORT_BASE;
  const hc = navigator.hardwareConcurrency || 1;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, hc)) : 1;
  ort.env.wasm.proxy = false;
  return ort;
}

function cacheAvailable() {
  try { return typeof caches !== 'undefined' && !!caches.open; } catch { return false; }
}

/** 讀取 Response（串流回報進度），回傳 Uint8Array */
async function readWithProgress(resp, onProgress, expected) {
  const total = Number(resp.headers.get('content-length')) || expected || 0;
  if (!resp.body || !resp.body.getReader) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    onProgress && onProgress({ loaded: buf.byteLength, total: buf.byteLength, stage: 'download' });
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
    if (onProgress && now - lastReport > 100) { lastReport = now; onProgress({ loaded, total, stage: 'download' }); }
  }
  onProgress && onProgress({ loaded, total: total || loaded, stage: 'download' });
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
        onProgress && onProgress({ loaded: 0, total: model.size, stage: 'cache' });
        const bytes = new Uint8Array(await hit.arrayBuffer());
        if (looksLikeOnnx(bytes, model)) {
          onProgress && onProgress({ loaded: bytes.byteLength, total: bytes.byteLength, stage: 'cache' });
          log('model from Cache Storage', bytes.byteLength);
          return bytes;
        }
        await cache.delete(cacheKey);
      }
    } catch (e) { console.warn('[local-ai] Cache Storage 無法使用', e); cache = null; }
  }

  const sources = [new URL('../models/' + model.file, import.meta.url).href, model.hfUrl];
  let bytes = null, lastErr = null;
  for (const url of sources) {
    try {
      const resp = await fetch(url, { cache: 'no-cache' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const ct = resp.headers.get('content-type') || '';
      if (/text\/html/i.test(ct)) throw new Error('not a model file (' + ct + ')');
      const b = await readWithProgress(resp, onProgress, model.size);
      if (!looksLikeOnnx(b, model)) throw new Error('invalid model bytes (' + b.byteLength + ')');
      bytes = b;
      log('model downloaded from', url, b.byteLength);
      break;
    } catch (e) {
      lastErr = e;
      console.warn('[local-ai] 模型來源失敗', url, e);
      if (isMemoryError(e)) throw toFriendly(e);
    }
  }
  if (!bytes) throw new FriendlyError('模型下載失敗，請確認網路連線後重試。', lastErr);

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
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch { return false; }
}

async function createSession(ort, bytes, ep) {
  return ort.InferenceSession.create(bytes, {
    executionProviders: [ep],
    graphOptimizationLevel: 'all',
  });
}

function releaseSession() {
  const s = session;
  session = null; ready = false; loadPromise = null;
  if (s && s.release) s.release().catch(() => {});
}

async function doLoad(onProgress, forceWasm) {
  const model = LOCAL_MODELS[currentModelId];
  const ort = await loadOrt();
  const bytes = await fetchModelBytes(model, onProgress);
  onProgress && onProgress({ loaded: bytes.byteLength, total: bytes.byteLength, stage: 'init' });
  const t0 = performance.now();
  let s = null;
  if (!forceWasm && await hasWebGPU()) {
    try {
      s = await createSession(ort, bytes, 'webgpu');
      backend = 'webgpu';
    } catch (e) {
      console.warn('[local-ai] WebGPU 初始化失敗，改用 WASM', e);
      s = null;
    }
  }
  if (!s) {
    try {
      s = await createSession(ort, bytes, 'wasm');
      backend = 'wasm';
    } catch (e) {
      throw toFriendly(e, 'AI 模型初始化失敗，請重新整理頁面再試。');
    }
  }
  log(`session ready: ${model.file} on ${backend} in ${Math.round(performance.now() - t0)}ms`,
    'inputs', s.inputNames, 'outputs', s.outputNames, 'threads', ort.env.wasm.numThreads);
  session = s;
  ready = true;
  onProgress && onProgress({ loaded: 1, total: 1, stage: 'ready' });
  return session;
}

/** 預先載入模型；可重複呼叫（同一個 Promise）。onProgress({loaded,total,stage}) */
const progressListeners = new Set();
function broadcast(p) {
  for (const fn of progressListeners) { try { fn(p); } catch (e) { console.warn(e); } }
}

export function loadLocalModel(onProgress) {
  if (ready && loadPromise) {
    onProgress && onProgress({ loaded: 1, total: 1, stage: 'ready' });
    return loadPromise;
  }
  if (onProgress) progressListeners.add(onProgress);
  if (!loadPromise) {
    loadPromise = doLoad(broadcast, false)
      .catch((e) => {
        loadPromise = null;
        throw toFriendly(e, 'AI 模型載入失敗，請稍後再試。');
      })
      .finally(() => progressListeners.clear());
  }
  return loadPromise;
}

async function fallbackToWasm(onProgress) {
  log('falling back to WASM backend');
  releaseSession();
  loadPromise = doLoad(onProgress, true).catch((e) => { loadPromise = null; throw toFriendly(e, 'AI 模型載入失敗，請稍後再試。'); });
  return loadPromise;
}

// ───────────────────────── 影像工具 ─────────────────────────

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ctx2d(c, readback) {
  return c.getContext('2d', readback ? { willReadFrequently: true } : undefined);
}

/** 把 src 的 (sx,sy,sw,sh) 區域縮放到 dw×dh；大幅縮小時逐次減半，避免細筆畫消失、鋸齒 */
function scaleRegion(src, sx, sy, sw, sh, dw, dh) {
  dw = Math.max(1, Math.round(dw)); dh = Math.max(1, Math.round(dh));
  let cur = src, cx = sx, cy = sy, cw = sw, ch = sh;
  while (cw / 2 >= dw && ch / 2 >= dh) {
    const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
    const c = makeCanvas(nw, nh);
    const g = ctx2d(c);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
    if (cur !== src) { cur.width = cur.height = 0; }
    cur = c; cx = 0; cy = 0; cw = nw; ch = nh;
  }
  const out = makeCanvas(dw, dh);
  const g = ctx2d(out, true);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(cur, cx, cy, cw, ch, 0, 0, dw, dh);
  if (cur !== src) { cur.width = cur.height = 0; }
  return out;
}

/** 二值遮罩方形膨脹（可分離 max filter），m: Uint8Array 0/1 */
function dilate(m, w, h, r) {
  if (r <= 0) return m;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let last = -1e9; // 最近一個 1 的位置（向左掃）
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

/** 盒狀模糊（3 次近似高斯），輸入 Float32Array 0..1 */
function boxBlur(src, w, h, r, passes = 3) {
  if (r <= 0) return src;
  let a = src, b = new Float32Array(w * h);
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

// ───────────────────────── 遮罩分析 ─────────────────────────

const MAP_MAX = 1024;

/** 在縮小的遮罩圖上找連通區塊，回傳原圖座標的外框陣列 */
function findMaskRegions(maskCanvas, W, H) {
  const f = Math.max(1, Math.max(W, H) / MAP_MAX);
  const mw = Math.max(1, Math.round(W / f)), mh = Math.max(1, Math.round(H / f));
  const small = scaleRegion(maskCanvas, 0, 0, W, H, mw, mh);
  const d = ctx2d(small, true).getImageData(0, 0, mw, mh).data;
  small.width = small.height = 0;
  const thr = f > 1 ? 8 : 127; // 縮小後細筆畫會變淡，用低門檻
  const m = new Uint8Array(mw * mh);
  let any = false;
  for (let i = 0; i < m.length; i++) if (d[i * 4] > thr) { m[i] = 1; any = true; }
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
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
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
      x0: Math.max(0, Math.floor((x0 - 1) * f)), y0: Math.max(0, Math.floor((y0 - 1) * f)),
      x1: Math.min(W, Math.ceil((x1 + 2) * f)), y1: Math.min(H, Math.ceil((y1 + 2) * f)),
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
  let crops = boxes.map((b) => cropForBox(b, W, H));
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
const COMP_BLUR = 2;     // 羽化半徑（3 次盒狀模糊，影響範圍約 3×2=6 ≤ COMP_DILATE，原本的洞內 alpha 維持 1）

async function runModel(model, rgba, hole, w, h) {
  const ort = ortModule;
  const n = w * h;
  let feeds, outName;
  if (model.kind === 'migan-pipeline') {
    const img = new Uint8Array(3 * n);
    const msk = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      img[i] = rgba[i * 4]; img[n + i] = rgba[i * 4 + 1]; img[2 * n + i] = rgba[i * 4 + 2];
      msk[i] = hole[i] ? 0 : 255; // MI-GAN：0 = 洞，255 = 保留
    }
    feeds = {
      image: new ort.Tensor('uint8', img, [1, 3, h, w]),
      mask: new ort.Tensor('uint8', msk, [1, 1, h, w]),
    };
    outName = 'result';
  } else { // LaMa 固定 512×512
    const img = new Float32Array(3 * n);
    const msk = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      img[i] = rgba[i * 4] / 255; img[n + i] = rgba[i * 4 + 1] / 255; img[2 * n + i] = rgba[i * 4 + 2] / 255;
      msk[i] = hole[i] ? 1 : 0;
    }
    feeds = {
      image: new ort.Tensor('float32', img, [1, 3, h, w]),
      mask: new ort.Tensor('float32', msk, [1, 1, h, w]),
    };
    outName = 'output';
  }
  const names = session.inputNames || [];
  if (names.length === 2 && !names.includes('image')) { // 保險：名稱不同時依順序對應
    feeds = { [names[0]]: feeds.image, [names[1]]: feeds.mask };
  }
  const results = await session.run(feeds);
  for (const t of Object.values(feeds)) t.dispose && t.dispose();
  const outT = results[outName] || results[session.outputNames[0]];
  const data = outT.getData ? await outT.getData() : outT.data;
  const dims = outT.dims;
  for (const t of Object.values(results)) t.dispose && t.dispose();

  // 轉回 RGBA
  const oh = dims[2], ow = dims[3];
  if (ow !== w || oh !== h) throw new Error(`unexpected output dims ${dims}`);
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
}

async function runWithFallback(model, rgba, hole, w, h, onProgress) {
  try {
    return await runModel(model, rgba, hole, w, h);
  } catch (e) {
    if (backend === 'webgpu' && !isMemoryError(e)) {
      console.warn('[local-ai] WebGPU 推論失敗，改用 WASM 重試', e);
      await fallbackToWasm((p) => onProgress && onProgress({ ...p, stage: 'load' }));
      return await runModel(model, rgba, hole, w, h);
    }
    throw e;
  }
}

/** 處理單一裁切區，直接畫回 out 畫布 */
async function inpaintCrop(out, maskCanvas, crop, model, onProgress) {
  const { x, y, w: cw, h: ch } = crop;
  const fixed = model.kind === 'lama-fixed512';
  let ww, wh;
  if (fixed) { ww = wh = model.workSize; }
  else {
    const s = Math.min(1, model.workSize / Math.max(cw, ch));
    ww = Math.max(8, Math.round(cw * s)); wh = Math.max(8, Math.round(ch * s));
  }
  const sc = Math.max(cw / ww, ch / wh); // 1 個工作像素 ≈ sc 個原圖像素

  // 取圖（從目前的 out 取，前一個區塊修好的結果也能當參考）
  const imgC = scaleRegion(out, x, y, cw, ch, ww, wh);
  const rgba = ctx2d(imgC, true).getImageData(0, 0, ww, wh).data;
  imgC.width = imgC.height = 0;

  const mC = scaleRegion(maskCanvas, x, y, cw, ch, ww, wh);
  const md = ctx2d(mC, true).getImageData(0, 0, ww, wh).data;
  mC.width = mC.height = 0;
  const thr = sc > 1.01 ? 20 : 127;
  const hole0 = new Uint8Array(ww * wh);
  for (let i = 0; i < hole0.length; i++) hole0[i] = md[i * 4] > thr ? 1 : 0;

  const holeInfer = dilate(hole0, ww, wh, INFER_DILATE);
  const t0 = performance.now();
  const res = await runWithFallback(model, rgba, holeInfer, ww, wh, onProgress);
  log(`inference ${ww}x${wh} (crop ${cw}x${ch} @ ${x},${y}) ${Math.round(performance.now() - t0)}ms on ${backend}`);

  // 結果 → 畫布 → 放大到裁切區大小
  const resC = makeCanvas(ww, wh);
  ctx2d(resC).putImageData(new ImageData(res, ww, wh), 0, 0);

  // 羽化 alpha（工作解析度計算，放大時再自然平滑）
  const comp = dilate(hole0, ww, wh, COMP_DILATE);
  const af = new Float32Array(ww * wh);
  for (let i = 0; i < af.length; i++) af[i] = comp[i];
  boxBlur(af, ww, wh, COMP_BLUR);
  const ad = new Uint8ClampedArray(ww * wh * 4);
  for (let i = 0; i < af.length; i++) {
    const a = hole0[i] ? 1 : af[i]; // 原本的洞一定完全覆蓋
    ad[i * 4] = ad[i * 4 + 1] = ad[i * 4 + 2] = 255; ad[i * 4 + 3] = a * 255;
  }
  const alphaC = makeCanvas(ww, wh);
  ctx2d(alphaC).putImageData(new ImageData(ad, ww, wh), 0, 0);

  const patch = makeCanvas(cw, ch);
  const pg = ctx2d(patch);
  pg.imageSmoothingEnabled = true; pg.imageSmoothingQuality = 'high';
  pg.drawImage(resC, 0, 0, ww, wh, 0, 0, cw, ch);
  pg.globalCompositeOperation = 'destination-in';
  pg.drawImage(alphaC, 0, 0, ww, wh, 0, 0, cw, ch);
  resC.width = resC.height = 0; alphaC.width = alphaC.height = 0;

  const og = ctx2d(out);
  og.globalCompositeOperation = 'source-over';
  og.drawImage(patch, x, y);
  patch.width = patch.height = 0;
}

/**
 * imageCanvas、maskCanvas 尺寸相同；mask 白色(R>127)=要移除。
 * 回傳新的 canvas（尺寸＝原圖），遮罩外的像素保持原樣。
 */
export async function inpaintLocal(imageCanvas, maskCanvas, onProgress) {
  const W = imageCanvas.width, H = imageCanvas.height;
  if (!maskCanvas || maskCanvas.width !== W || maskCanvas.height !== H) {
    throw new FriendlyError('遮罩尺寸與照片不符，請重新塗抹。');
  }
  const report = (stage, loaded = 0, total = 1) => onProgress && onProgress({ stage, loaded, total });

  const out = makeCanvas(W, H);
  ctx2d(out).drawImage(imageCanvas, 0, 0);

  const T0 = performance.now();
  try {
    report('prepare');
    const boxes = findMaskRegions(maskCanvas, W, H);
    if (!boxes.length) { report('done', 1, 1); return out; }
    const crops = planCrops(boxes, W, H);
    log(`${W}x${H}, ${boxes.length} mask region(s) → ${crops.length} crop(s)`, crops.map((c) => `${c.w}x${c.h}@${c.x},${c.y}`));

    await loadLocalModel(onProgress);
    const model = LOCAL_MODELS[currentModelId];

    for (let i = 0; i < crops.length; i++) {
      report('infer', i, crops.length);
      await inpaintCrop(out, maskCanvas, crops[i], model, onProgress);
      await new Promise((r) => setTimeout(r, 0)); // 讓畫面有機會更新
    }
    report('done', crops.length, crops.length);
    log(`total ${Math.round(performance.now() - T0)}ms`);
    return out;
  } catch (e) {
    out.width = out.height = 0;
    console.error('[local-ai] inpaint failed', e);
    throw toFriendly(e, 'AI 修圖失敗，請重試；若一直失敗，請改用強力模式。');
  }
}
