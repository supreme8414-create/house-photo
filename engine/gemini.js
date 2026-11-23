/*
 * 房屋修圖器 — 強力模式：Google Gemini 圖像編輯（Nano Banana 系列）
 *
 * ── 已查證的 API 事實（2026-11-23 查閱官方文件＋實測 CORS）────────────────────
 * 來源：
 *  - https://aistudio.google.com/docs/image-generation?generate-content=true
 *      （ai.google.dev/gemini-api/docs/generate-content/image-generation 301 轉址至此）
 *  - https://aistudio.google.com/docs/image-generation   （Interactions API 版本）
 *  - https://aistudio.google.com/docs/migrate-to-interactions
 *      原文："While generateContent remains fully supported, we recommend the Interactions API for all new development."
 *  - https://aistudio.google.com/docs/pricing
 *
 * 模型 ID：
 *   gemini-nano-banana-2.1       Nano Banana 2.1 — 文件建議的主力（本檔預設）
 *   gemini-3.1-flash-lite-image  Nano Banana 2 Lite（最便宜，只到 1K，多輪編輯較弱）
 *   gemini-3.1-flash-image       Nano Banana 2（上一代；本檔在 404 時自動退回此模型）
 *   gemini-3-pro-image           Nano Banana Pro（最貴，含 Thinking）
 *   gemini-2.5-flash-image       舊版，2027-03-15 停用
 *
 * 端點（本檔使用順序）：
 *   1. POST https://generativelanguage.googleapis.com/v1/models/{model}:generateContent   ← 官方 REST 範例用 /v1/
 *   2. POST .../v1beta/models/{model}:generateContent                                      ← 若 1 回 404 / 不認得欄位
 *   3. POST .../v1beta/interactions                                                       ← 最後備援
 *   generateContent body：
 *     {contents:[{role:'user',parts:[{text},{inline_data:{mime_type,data}}]}],
 *      generationConfig:{responseModalities:['IMAGE'], imageConfig:{aspectRatio:'4:3', imageSize:'2K'}}}
 *     imageSize 必須大寫 K：'1K' | '2K' | '4K'（Nano Banana 2.1 不支援 512）。
 *     回傳 candidates[0].content.parts[].inlineData{mimeType,data}（thought:true 的部分為思考草稿，略過）
 *   Interactions body：{model, input:[{type:'text',text},{type:'image',mime_type,data}],
 *     response_format:{type:'image',aspect_ratio,image_size}}；回傳 steps[] → content[] → {type:'image',data}
 *
 * 長寬比（Nano Banana 2.1）：1:1 1:4 1:8 2:3 3:2 3:4 4:1 4:3 4:5 5:4 8:1 9:16 16:9 21:9
 *   4:3 輸出像素：1K 1200x896、2K 2400x1792、4K 4800x3584；16:9 2K 2752x1536。
 *
 * 瀏覽器 CORS（2026-11-23 以 curl 模擬預檢實測）：
 *   OPTIONS 預檢允許標頭只有 "content-type,x-goog-api-key"，Origin 任意 → 瀏覽器直接呼叫 OK。
 *   ★ 若加上 Interactions 文件範例的 "Api-Revision" 標頭，預檢回 403 → 瀏覽器會被 CORS 擋下。
 *     所以本檔「不送」Api-Revision 標頭（舊版 gemini.js 送了，等於主路徑永遠失敗）。
 *
 * 價格（標準方案，每張輸出圖；圖像輸出「沒有免費額度」，Free Tier 欄位為 Not available）：
 *   gemini-nano-banana-2.1  1K $0.0336 / 2K $0.0504 / 4K $0.113（輸入 $1.50 / 1M tokens）
 *   gemini-3.1-flash-image  1K $0.067  / 2K $0.101  / 4K $0.151
 *   gemini-3-pro-image      1K/2K $0.134 / 4K $0.24
 *   另加輸入圖 token 與思考 token，2K 每張實際約 US$0.052–0.06。
 *   所有輸出圖都含 SynthID 隱形浮水印。
 *
 * 使用 localStorage 'geminiModel' 可覆蓋模型。
 * ──────────────────────────────────────────────────────────────────────────
 */

export const GEMINI_MODEL_DEFAULT = 'gemini-nano-banana-2.1';
/** 預設模型 2K 輸出每張價格（美元，不含輸入/思考 token；實際約 0.052–0.06） */
export const GEMINI_PRICE_PER_IMAGE_USD = 0.0504;

const API_ROOT = 'https://generativelanguage.googleapis.com';
const MODEL_FALLBACKS = ['gemini-3.1-flash-image'];
const TIMEOUT_MS = 150000;
const RATIOS = [
  ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['3:2', 3 / 2], ['2:3', 2 / 3], ['5:4', 5 / 4], ['4:5', 4 / 5],
  ['16:9', 16 / 9], ['9:16', 9 / 16], ['21:9', 21 / 9], ['4:1', 4], ['1:4', 1 / 4], ['8:1', 8], ['1:8', 1 / 8],
];

// ── 一鍵清除指令（PowerShell 測試腳本會擷取兩個標記之間的文字，請勿在內文使用反引號或 ${ ）──
export const GEMINI_DECLUTTER_PROMPT = /*PROMPT_START*/`
Edit this real-estate listing photo of a room. Tidy it up as if the occupant had packed away all of their personal
belongings just before the photographer arrived, and return the same photograph with only that change.

REMOVE all small, movable personal clutter and loose items:
- everything lying on top of surfaces: tables, desks, coffee tables, nightstands, counters, cabinet and wardrobe tops,
  shelves, beds, sofas, chairs, windowsills, bathroom vanities, washing machines, balcony floors;
- every small loose item standing on the floor.
Examples: figurines, toys, plush animals, books, papers, magazines, boxes, packaging, bags, clothes and towels lying around,
shoes, bottles, cups, kettles, dishes, food, cosmetics, toiletries, tissue boxes, remote controls, loose chargers, baskets,
potted plants on windowsills, small decorations on top of furniture, trash bins, laundry baskets, cleaning tools,
small storage containers and other household odds and ends.

KEEP exactly as they are, in the same position, size, shape, color and design:
- all furniture: bed frame, mattress, pillows and bedding, sofas, tables (including low tables), desks, chairs, stools,
  cabinets, wardrobes, shelving units, TV stands;
- built-in fixtures, kitchen and bathroom fixtures, sinks, toilets, showers, mirrors;
- appliances: air conditioners, air purifiers, dehumidifiers, fans, refrigerators, washing machines, TVs, water heaters;
- curtains, blinds, curtain rods, ceiling lights, lamps and light fixtures;
- windows, window frames, security grilles and everything visible through the window;
- doors, wall outlets, switches, power strips and their cables, pipes and vents.

RECONSTRUCT what the removed items were hiding: the surface underneath must look clean, complete and continuous,
for example a full empty tabletop with consistent material, wood grain and intact edges; a bare mattress or neatly
continuing bedsheet; a clear windowsill; open floor with the floorboards or tiles continuing naturally.
Match the surrounding texture, perspective, lighting and shadows. No blur, smudges, ghosting, halos, leftover shadows
or outlines of removed objects.

NEVER alter the building itself: walls, ceilings, floors, doors and window frames keep their exact condition, including
any stains, marks, cracks, peeling paint, mould, water damage or wear. Do not clean, repaint, repair or brighten them.
This photo is used in a real-estate advertisement and existing defects must remain visible.

Keep the exact same camera position, angle, lens distortion, perspective, framing and crop, and the same lighting,
exposure, colors and white balance. Everything that is not removed clutter must stay unchanged.
The result must be photorealistic and look like the original camera photo: no new objects, no people, no text,
no logos or watermarks, no style change, no CGI or rendered look.
If you are unsure whether something is furniture, a fixture or an appliance, keep it.
`/*PROMPT_END*/.replace(/\s+/g, ' ').trim();

/** 塗抹模式（inpaintGemini）預設指令：第二張圖洋紅色區域為要移除的物品 */
export const GEMINI_DEFAULT_PROMPT =
  'You are given two images of the same real-estate listing photo. Image 1 is the clean original. ' +
  'Image 2 is identical except that the objects to remove are painted over in bright magenta (#FF00FF). ' +
  'Return an edited version of Image 1 in which only the objects under the magenta paint are removed. ' +
  'Reconstruct the surface that was hidden behind them as clean, complete and continuous, matching the surrounding ' +
  'floor, wall, furniture surface or bedding in texture, pattern, perspective, lighting and shadows ' +
  '(e.g. continue floorboards, tiles, wood grain and edges naturally). Do not blur, smudge or leave ghosts, halos, ' +
  'shadows or outlines of the removed objects, and do not leave any magenta. ' +
  'Everything outside the magenta area must stay exactly identical: same camera angle, framing, colors, lighting and details. ' +
  'Never alter walls, ceilings or floors condition (keep any stains, cracks or water damage visible). ' +
  'Photorealistic; no new objects, people, text or watermarks.';

// ────────────────────────────────────────────────────────────── 小工具 ──
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function getModel() {
  try { const m = localStorage.getItem('geminiModel'); if (m && m.trim()) return m.trim(); } catch (e) {}
  return GEMINI_MODEL_DEFAULT;
}

function progress(cb, stage, loaded = 0, total = 0) {
  try { cb && cb({ stage, loaded, total }); } catch (e) {}
}

function log(opt, msg) {
  try { opt && opt.onLog && opt.onLog(msg); } catch (e) {}
}

function gErr(code, message, detail) {
  const e = new Error(message);
  e.name = 'GeminiError';
  e.code = code;
  if (detail) e.detail = detail;
  return e;
}

function abortErr() {
  const e = gErr('ABORTED', '已取消。');
  e.name = 'AbortError';
  return e;
}

function checkAbort(signal) {
  if (signal && signal.aborted) throw abortErr();
}

function mk(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ctx2d(c, opts) {
  const g = c.getContext('2d', opts);
  if (!g) throw gErr('MEMORY', '手機記憶體不足，無法處理這張圖片。請關閉其他分頁或 App 後再試。');
  return g;
}

/** 釋放暫存 canvas 記憶體（iOS Safari 對 canvas 總量有限制） */
function release(...cs) {
  for (const c of cs) { if (c && typeof c.getContext === 'function') { c.width = 0; c.height = 0; } }
}

function nearestRatio(w, h) {
  const r = w / h;
  let best = RATIOS[0], d = Infinity;
  for (const x of RATIOS) { const e = Math.abs(Math.log(x[1] / r)); if (e < d) { d = e; best = x; } }
  return best[0];
}

function scaled(src, maxSide) {
  const s = Math.min(1, maxSide / Math.max(src.width, src.height));
  const c = mk(src.width * s, src.height * s);
  const g = ctx2d(c);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function toB64(canvas, type = 'image/jpeg', q = 0.92) {
  const url = canvas.toDataURL(type, q);
  return url.slice(url.indexOf(',') + 1);
}

function sizeFor(quality) {
  const q = String(quality || '').toLowerCase();
  if (q === '1k' || q === 'fast' || q === 'low') return '1K';
  if (q === '4k' || q === 'max') return '4K';
  return '2K';
}

// ───────────────────────────────────────────────────────────── API 呼叫 ──
function classifyHttp(status, body, rawText) {
  const em = (body && body.error && body.error.message) || String(rawText || '').slice(0, 300);
  const st = (body && body.error && body.error.status) || '';
  const details = body && body.error && body.error.details ? JSON.stringify(body.error.details) : '';
  const detail = ('HTTP ' + status + (st ? ' ' + st : '') + ': ' + em).slice(0, 800);
  const all = em + ' ' + details;
  let e;
  if (/API_KEY_INVALID|API key not valid|API key expired|API_KEY_EXPIRED/i.test(all)) {
    e = gErr('BAD_KEY', 'API 金鑰無效或已過期，請到「設定」重新貼上正確的金鑰。', detail);
  } else if (/billing|free[_ ]?tier|limit:\s*0\b|paid (tier|plan)|requires? (a )?paid|not available (in|on) (the )?free/i.test(all)) {
    e = gErr('NO_BILLING', '這把金鑰沒有開通付費（Billing）。Gemini 圖像編輯沒有免費額度，請到 Google AI Studio 為專案綁定帳單後再試。', detail);
  } else if (status === 401 || status === 403) {
    const ref = /referer|referrer/i.test(all) ? '（金鑰有限制網站來源，請在 Google Cloud 金鑰設定加入本網站網址）' : '';
    e = gErr('BAD_KEY', 'API 金鑰沒有權限（' + status + '）' + ref + '。請確認金鑰正確、已啟用 Gemini API。', detail);
  } else if (status === 429) {
    e = gErr('QUOTA', '額度已用完或請求太頻繁（429），請稍等一分鐘再試，或到 Google AI Studio 檢查用量上限。', detail);
  } else if (status === 404) {
    e = gErr('BAD_REQUEST', '找不到這個模型（404），請確認模型名稱。', detail);
  } else if (status >= 500) {
    e = gErr('NETWORK', 'Google 伺服器暫時忙碌（' + status + '），請稍後再試。', detail);
  } else if (/location is not supported|region/i.test(em)) {
    e = gErr('BAD_REQUEST', '目前所在地區無法使用 Gemini API。', detail);
  } else {
    e = gErr('BAD_REQUEST', '請求被拒絕（' + status + '）：' + (em || '參數有誤'), detail);
  }
  e.status = status;
  return e;
}

async function post(url, payload, apiKey, opt = {}) {
  checkAbort(opt.signal);
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, opt.timeoutMs || TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  if (opt.signal) opt.signal.addEventListener('abort', onAbort, { once: true });
  const bodyStr = JSON.stringify(payload);
  const t0 = now();
  log(opt, 'POST ' + url.replace(API_ROOT, '') + '（送出 ' + Math.round(bodyStr.length / 1024) + ' KB）');
  let res, text;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: bodyStr,
    });
    text = await res.text();
  } catch (e) {
    if (opt.signal && opt.signal.aborted) throw abortErr();
    if (timedOut) throw gErr('TIMEOUT', '等待逾時（' + Math.round((opt.timeoutMs || TIMEOUT_MS) / 1000) + ' 秒），請檢查網路後重試。', 'timeout');
    log(opt, '  連線失敗：' + (e && e.message));
    const err = gErr('NETWORK', '無法連線到 Google，請檢查網路連線。', String((e && e.message) || e));
    err.network = true;
    throw err;
  } finally {
    clearTimeout(timer);
    if (opt.signal) opt.signal.removeEventListener('abort', onAbort);
  }
  log(opt, '  ← HTTP ' + res.status + '，' + Math.round(now() - t0) + ' ms，' + Math.round(text.length / 1024) + ' KB');
  let body = null;
  try { body = JSON.parse(text); } catch (e) {}
  if (!res.ok) {
    const err = classifyHttp(res.status, body, text);
    log(opt, '  ' + err.detail);
    throw err;
  }
  if (!body) throw gErr('NO_IMAGE', 'Gemini 回應無法解析。', String(text).slice(0, 300));
  return body;
}

/** generateContent 請求格式（tools/gemini-cli-test.ps1 用完全相同的結構） */
function buildGenerateContentBody(text, imagesB64, aspect, size) {
  const parts = [{ text }];
  for (const d of imagesB64) parts.push({ inline_data: { mime_type: 'image/jpeg', data: d } });
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect, imageSize: size } },
  };
}

function buildInteractionsBody(model, text, imagesB64, aspect, size) {
  const input = [{ type: 'text', text }];
  for (const d of imagesB64) input.push({ type: 'image', mime_type: 'image/jpeg', data: d });
  // 注意：不送 Api-Revision 標頭（CORS 預檢不允許）
  return { model, input, response_format: { type: 'image', aspect_ratio: aspect, image_size: size } };
}

function extractImage(body) {
  const found = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o.thought === true) return; // 思考草稿圖，不是最終結果
    if (o.type === 'image' && typeof o.data === 'string') found.push({ data: o.data, mime: o.mime_type || o.mimeType || 'image/png' });
    else if (o.inlineData && o.inlineData.data) found.push({ data: o.inlineData.data, mime: o.inlineData.mimeType || 'image/png' });
    else if (o.inline_data && o.inline_data.data) found.push({ data: o.inline_data.data, mime: o.inline_data.mime_type || 'image/png' });
    for (const k in o) if (o[k] && typeof o[k] === 'object') walk(o[k]);
  };
  walk(body);
  return found.length ? found[found.length - 1] : null;
}

function noImageError(body) {
  const cand = body && body.candidates && body.candidates[0];
  const block = body && body.promptFeedback && body.promptFeedback.blockReason;
  const finish = (cand && cand.finishReason) || (body && body.status) || '';
  let txt = '';
  try {
    const parts = (cand && cand.content && cand.content.parts) || [];
    txt = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join(' ').slice(0, 300);
  } catch (e) {}
  const detail = ('blockReason=' + (block || '-') + ' finishReason=' + (finish || '-') + (txt ? ' text=' + txt : '')).slice(0, 600);
  if (block || /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/i.test(finish)) {
    return gErr('SAFETY', 'Gemini 的安全機制擋下了這張圖（' + (block || finish) + '）。請換一張照片或稍後再試。', detail);
  }
  return gErr('NO_IMAGE', 'Gemini 沒有回傳圖片' + (finish ? '（' + finish + '）' : '') + '，請再按一次試試。', detail);
}

function isEndpointMismatch(e) {
  if (!e || e.code !== 'BAD_REQUEST') return false;
  if (e.status === 404) return true;
  return e.status === 400 && /Unknown name|Invalid JSON payload|Cannot find field|not supported|invalid value at|unknown field|response_?modalities|image_?config/i.test(e.detail || '');
}

async function callModel(apiKey, imagesB64, text, aspect, size, opt = {}) {
  const first = opt.model || getModel();
  const models = [first, ...MODEL_FALLBACKS.filter((m) => m !== first)];
  let lastErr = null;
  for (const model of models) {
    const attempts = [
      { name: 'v1 generateContent', url: `${API_ROOT}/v1/models/${encodeURIComponent(model)}:generateContent`, body: () => buildGenerateContentBody(text, imagesB64, aspect, size) },
      { name: 'v1beta generateContent', url: `${API_ROOT}/v1beta/models/${encodeURIComponent(model)}:generateContent`, body: () => buildGenerateContentBody(text, imagesB64, aspect, size) },
      { name: 'v1beta interactions', url: `${API_ROOT}/v1beta/interactions`, body: () => buildInteractionsBody(model, text, imagesB64, aspect, size) },
    ];
    let modelMissing = true;
    for (const a of attempts) {
      checkAbort(opt.signal);
      let body;
      try {
        body = await post(a.url, a.body(), apiKey, opt);
      } catch (e) {
        if (!isEndpointMismatch(e)) throw e;
        if (e.status !== 404) modelMissing = false;
        lastErr = e;
        log(opt, '  ' + a.name + ' 不適用，改試下一種端點');
        continue;
      }
      const img = extractImage(body);
      if (!img) throw noImageError(body);
      return { data: img.data, mime: img.mime, model: body.modelVersion || body.model || model, endpoint: a.name, usage: body.usageMetadata || body.usage || null };
    }
    if (!modelMissing) break;
    log(opt, '  模型 ' + model + ' 無法使用，改試備援模型');
  }
  throw lastErr || gErr('BAD_REQUEST', '無法呼叫 Gemini。');
}

async function decodeImage(b64, mime) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const blob = new Blob([u8], { type: mime || 'image/png' });
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); } catch (e) {}
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
    im.onerror = () => { URL.revokeObjectURL(url); reject(gErr('NO_IMAGE', '無法解讀 Gemini 回傳的圖片。')); };
    im.src = url;
  });
}

const imgW = (im) => im.naturalWidth || im.width;
const imgH = (im) => im.naturalHeight || im.height;
const closeImg = (im) => { try { im && im.close && im.close(); } catch (e) {} };

// ─────────────────────────────────────────────── 變更區域偵測（只貼回有變的地方） ──
// tf = {s, dx, dy}：對齊後結果(x) = 原始結果( c + (x-c)*s + dx*W )；dx,dy 為寬/高比例
function applyTf(g, tf, w, h) {
  if (!tf || (tf.s === 1 && tf.dx === 0 && tf.dy === 0)) return;
  const cx = w / 2, cy = h / 2, s = tf.s;
  g.setTransform(1 / s, 0, 0, 1 / s, cx - (cx + tf.dx * w) / s, cy - (cy + tf.dy * h) / s);
}

function pixelsOf(src, w, h, tf) {
  const c = mk(w, h);
  const g = ctx2d(c, { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  applyTf(g, tf, w, h);
  g.drawImage(src, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  release(c);
  return d;
}

function blurF(a, w, h, r) {
  if (r < 1) return a;
  const tmp = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += a[row + xx]; n++; } }
      tmp[row + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; n++; } }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

function grayF(d, n) {
  const g = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  return g;
}

/** 搜尋全域平移/縮放，修正模型輕微挪動構圖 */
function searchTransform(O, R, w, h) {
  const cx = w / 2, cy = h / 2, m = 8, step = 2, cap = 40;
  const err = (s, dx, dy) => {
    let sum = 0, n = 0;
    for (let y = m; y < h - m; y += step) {
      const sy = Math.round(cy + (y - cy) * s + dy);
      if (sy < 0 || sy >= h) continue;
      const ro = y * w, rr = sy * w;
      for (let x = m; x < w - m; x += step) {
        const sx = Math.round(cx + (x - cx) * s + dx);
        if (sx < 0 || sx >= w) continue;
        const d = Math.abs(O[ro + x] - R[rr + sx]);
        sum += d < cap ? d : cap; n++;
      }
    }
    return n > 100 ? sum / n : 1e9;
  };
  const e0 = err(1, 0, 0);
  let best = { s: 1, dx: 0, dy: 0, e: e0 };
  for (const s of [0.95, 0.97, 0.98, 0.99, 1, 1.01, 1.02, 1.03, 1.05]) {
    for (let dy = -8; dy <= 8; dy += 2) for (let dx = -8; dx <= 8; dx += 2) {
      const e = err(s, dx, dy);
      if (e < best.e) best = { s, dx, dy, e };
    }
  }
  const c = best;
  for (const s of [c.s - 0.005, c.s, c.s + 0.005]) {
    for (let dy = c.dy - 1; dy <= c.dy + 1; dy++) for (let dx = c.dx - 1; dx <= c.dx + 1; dx++) {
      const e = err(s, dx, dy);
      if (e < best.e) best = { s, dx, dy, e };
    }
  }
  // 改善不明顯就維持原位（避免雜訊造成假位移）
  if (e0 - best.e < Math.max(0.4, 0.06 * e0)) return { s: 1, dx: 0, dy: 0, e0, e: e0 };
  return { s: best.s, dx: best.dx / w, dy: best.dy / h, e0, e: best.e };
}

const LIN = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  return t;
})();
const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

function toLab(d, n, off) {
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  const o0 = off ? off[0] : 0, o1 = off ? off[1] : 0, o2 = off ? off[2] : 0;
  const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = LIN[cl(d[j] - o0)], g = LIN[cl(d[j + 1] - o1)], b = LIN[cl(d[j + 2] - o2)];
    const fx = labF((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
    const fy = labF(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const fz = labF((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    L[i] = 116 * fy - 16; A[i] = 500 * (fx - fy); B[i] = 200 * (fy - fz);
  }
  return [L, A, B];
}

function channelMedianOffsets(o, r, n) {
  const off = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const hist = new Uint32Array(511);
    for (let i = 0, j = ch; i < n; i++, j += 4) hist[r[j] - o[j] + 255]++;
    let acc = 0, half = n / 2;
    for (let k = 0; k < 511; k++) { acc += hist[k]; if (acc >= half) { off[ch] = k - 255; break; } }
  }
  return off;
}

function morph(m, w, h, r, isMax) {
  if (r < 1) return m;
  const tmp = new Uint8Array(m.length), out = new Uint8Array(m.length);
  const v0 = isMax ? 0 : 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = v0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k; if (xx < 0 || xx >= w) continue;
        if (isMax ? m[row + xx] : !m[row + xx]) { v = 1 - v0; break; }
      }
      tmp[row + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = v0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k; if (yy < 0 || yy >= h) continue;
        if (isMax ? tmp[yy * w + x] : !tmp[yy * w + x]) { v = 1 - v0; break; }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}
const dilate = (m, w, h, r) => morph(m, w, h, r, true);
const erode = (m, w, h, r) => morph(m, w, h, r, false);

/** 低門檻區域只保留與高門檻種子相連的部分（hysteresis），並移除太小的雜點 */
function hysteresis(dE, w, h, tHi, tLo, minArea) {
  const n = w * h, out = new Uint8Array(n), seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (seen[i] || dE[i] < tHi) continue;
    let sp = 0, comp = [];
    stack[sp++] = i; seen[i] = 1;
    while (sp) {
      const p = stack[--sp]; comp.push(p);
      const x = p % w, y = (p / w) | 0;
      if (x > 0) { const q = p - 1; if (!seen[q] && dE[q] >= tLo) { seen[q] = 1; stack[sp++] = q; } }
      if (x < w - 1) { const q = p + 1; if (!seen[q] && dE[q] >= tLo) { seen[q] = 1; stack[sp++] = q; } }
      if (y > 0) { const q = p - w; if (!seen[q] && dE[q] >= tLo) { seen[q] = 1; stack[sp++] = q; } }
      if (y < h - 1) { const q = p + w; if (!seen[q] && dE[q] >= tLo) { seen[q] = 1; stack[sp++] = q; } }
    }
    if (comp.length >= minArea) for (const p of comp) out[p] = 1;
  }
  return out;
}

/** 填滿被變更區域整圈包住的洞（例如白色盒子內部顏色接近牆面） */
function fillHoles(m, w, h) {
  const n = w * h, outside = new Uint8Array(n), stack = new Int32Array(n);
  let sp = 0;
  const push = (p) => { if (!m[p] && !outside[p]) { outside[p] = 1; stack[sp++] = p; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp) {
    const p = stack[--sp], x = p % w, y = (p / w) | 0;
    if (x > 0) push(p - 1); if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w); if (y < h - 1) push(p + w);
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = m[i] || !outside[i] ? 1 : 0;
  return out;
}

/**
 * 比對原圖與 Gemini 結果，找出被改動的區域。
 * 回傳 {aligned, tf, offsets, changedRatio, lowRatio, alphaCanvas(白+alpha 羽化遮罩, 小尺寸), maskView(黑白預覽)}
 */
function analyzeChange(orig, img, tune = {}) {
  const W = orig.width, H = orig.height;
  // 1) 對齊（約 256 長邊）
  const A = Math.min(1, 256 / Math.max(W, H));
  const aw = Math.max(16, Math.round(W * A)), ah = Math.max(16, Math.round(H * A));
  const oG = blurF(grayF(pixelsOf(orig, aw, ah, null), aw * ah), aw, ah, 1);
  const rG = blurF(grayF(pixelsOf(img, aw, ah, null), aw * ah), aw, ah, 1);
  const tf = searchTransform(oG, rG, aw, ah);

  // 2) 色差（約 512 長邊）
  const S = Math.min(1, (tune.analysisSize || 512) / Math.max(W, H));
  const w = Math.max(16, Math.round(W * S)), h = Math.max(16, Math.round(H * S)), n = w * h;
  const od = pixelsOf(orig, w, h, null);
  const rd = pixelsOf(img, w, h, tf);
  const offsets = channelMedianOffsets(od, rd, n); // 模型整體偏色 → 比對前先扣掉
  const [oL, oA, oB] = toLab(od, n, null);
  const [rL, rA, rB] = toLab(rd, n, offsets);
  const bl = (a) => blurF(a, w, h, 1);
  const L1 = bl(oL), A1 = bl(oA), B1 = bl(oB), L2 = bl(rL), A2 = bl(rA), B2 = bl(rB);
  const dE = new Float32Array(n);
  const tHi = tune.tHi || 18, tLo = tune.tLo || 7;
  let low = 0;
  for (let i = 0; i < n; i++) {
    const dl = 0.8 * (L1[i] - L2[i]), da = A1[i] - A2[i], db = B1[i] - B2[i];
    const e = Math.sqrt(dl * dl + da * da + db * db);
    dE[i] = e;
    if (e < tLo) low++;
  }
  const lowRatio = low / n;
  const L = Math.max(w, h);
  let m = hysteresis(dE, w, h, tHi, tLo, Math.max(6, Math.round(n * 0.0001)));
  m = erode(dilate(m, w, h, 1), w, h, 1);
  const rc = Math.max(2, Math.round(L * (tune.close || 0.01)));
  m = erode(dilate(m, w, h, rc), w, h, rc); // close
  m = fillHoles(m, w, h);
  m = dilate(m, w, h, Math.max(2, Math.round(L * (tune.dilate || 0.012))));
  let cnt = 0;
  for (let i = 0; i < n; i++) cnt += m[i];
  const changedRatio = cnt / n;

  // 3) 羽化遮罩
  const fr = Math.max(1, Math.round(L * (tune.feather || 0.006)));
  let soft = new Float32Array(n);
  for (let i = 0; i < n; i++) soft[i] = m[i];
  soft = blurF(blurF(soft, w, h, fr), w, h, fr);
  const alphaCanvas = mk(w, h), viewCanvas = mk(w, h);
  const ag = ctx2d(alphaCanvas), vg = ctx2d(viewCanvas);
  const ai = ag.createImageData(w, h), vi = vg.createImageData(w, h);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = Math.round(Math.min(1, soft[i]) * 255);
    ai.data[j] = ai.data[j + 1] = ai.data[j + 2] = 255; ai.data[j + 3] = a;
    vi.data[j] = vi.data[j + 1] = vi.data[j + 2] = a; vi.data[j + 3] = 255;
  }
  ag.putImageData(ai, 0, 0);
  vg.putImageData(vi, 0, 0);

  const maxAlignErr = tune.maxAlignErr || 12;
  const aligned = tf.e <= maxAlignErr && lowRatio >= (tune.minLowRatio || 0.3);
  return { aligned, tf, offsets, changedRatio, lowRatio, alignErr: tf.e, alphaCanvas, maskView: viewCanvas };
}

/** 結果圖整體偏色校正（只在貼回時用，避免接縫） */
function colorCorrected(img, offsets) {
  if (!offsets || Math.max(Math.abs(offsets[0]), Math.abs(offsets[1]), Math.abs(offsets[2])) < 2) return null;
  const w = imgW(img), h = imgH(img);
  const c = mk(w, h);
  const g = ctx2d(c, { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const id = g.getImageData(0, 0, w, h), d = id.data;
  const [o0, o1, o2] = offsets;
  for (let j = 0; j < d.length; j += 4) { d[j] -= o0; d[j + 1] -= o1; d[j + 2] -= o2; } // Uint8Clamped 自動夾住
  g.putImageData(id, 0, 0);
  return c;
}

function stretchTo(src, W, H) {
  const out = mk(W, H);
  const g = ctx2d(out);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, W, H);
  return out;
}

function composeChanged(orig, resultSrc, alphaCanvas, tf) {
  const W = orig.width, H = orig.height;
  const tmp = mk(W, H);
  const tg = ctx2d(tmp);
  tg.imageSmoothingEnabled = true;
  tg.imageSmoothingQuality = 'high';
  tg.drawImage(alphaCanvas, 0, 0, W, H); // 小遮罩放大＝自然柔邊
  tg.globalCompositeOperation = 'source-in';
  applyTf(tg, tf, W, H);
  tg.drawImage(resultSrc, 0, 0, W, H);
  const out = mk(W, H);
  const og = ctx2d(out);
  og.drawImage(orig, 0, 0);
  og.drawImage(tmp, 0, 0);
  release(tmp);
  return out;
}

// ─────────────────────────────────────────────────────────── 公開 API ──

/**
 * 一鍵清除：AI 自行判斷並移除雜物。
 * @param {HTMLCanvasElement} imageCanvas 原圖（任意尺寸）
 * @param {{apiKey:string, prompt?:string, onProgress?:Function, signal?:AbortSignal,
 *          quality?:'1K'|'2K'|'4K', onLog?:(msg:string)=>void, model?:string,
 *          composite?:boolean, debug?:boolean, tune?:object}} opts
 * @returns {Promise<HTMLCanvasElement>} 與原圖同尺寸；result.__geminiInfo = {model, changedRatio, composited, ms, ...}
 */
export async function declutterGemini(imageCanvas, opts = {}) {
  const { apiKey, prompt, onProgress, signal, quality, composite = true, debug = false, tune } = opts;
  const t0 = now();
  if (!apiKey) throw gErr('BAD_KEY', '尚未設定 Gemini API 金鑰。');
  checkAbort(signal);
  const W = imageCanvas.width, H = imageCanvas.height;
  const size = sizeFor(quality);
  progress(onProgress, '準備圖片');
  const aspect = nearestRatio(W, H);
  const send = scaled(imageCanvas, size === '4K' ? 3072 : 2048);
  const b64 = toB64(send, 'image/jpeg', 0.92);
  log(opts, '送出圖片 ' + send.width + 'x' + send.height + '，要求 ' + size + ' ' + aspect);
  release(send);

  progress(onProgress, '傳送給 Gemini 處理中（約 20–60 秒）');
  const r = await callModel(apiKey, [b64], prompt || GEMINI_DECLUTTER_PROMPT, aspect, size, opts);
  checkAbort(signal);

  progress(onProgress, '分析變更區域');
  const img = await decodeImage(r.data, r.mime);
  log(opts, '收到圖片 ' + imgW(img) + 'x' + imgH(img) + ' ' + r.mime + '（' + r.model + '，' + r.endpoint + '）');
  const info = {
    model: r.model, endpoint: r.endpoint, changedRatio: null, composited: false, ms: 0,
    outputSize: imgW(img) + 'x' + imgH(img), requested: size + ' ' + aspect, usage: r.usage, reason: '',
  };
  let out = null, corrected = null, an = null;
  try {
    checkAbort(signal);
    if (composite) {
      an = analyzeChange(imageCanvas, img, tune || {});
      info.changedRatio = Math.round(an.changedRatio * 1000) / 1000;
      info.alignErr = Math.round(an.alignErr * 10) / 10;
      info.lowRatio = Math.round(an.lowRatio * 1000) / 1000;
      info.transform = an.tf;
      info.colorOffset = an.offsets;
      info.mask = an.maskView;
      log(opts, '變更比例 ' + (an.changedRatio * 100).toFixed(1) + '%，對齊誤差 ' + an.alignErr.toFixed(1) +
        '，未變像素 ' + (an.lowRatio * 100).toFixed(0) + '%，位移 ' + JSON.stringify({ s: an.tf.s, dx: +an.tf.dx.toFixed(4), dy: +an.tf.dy.toFixed(4) }) +
        '，偏色 ' + an.offsets.join(','));
      if (!an.aligned) info.reason = '構圖被模型改動，無法只貼回變更區域';
      else if (an.changedRatio > (tune && tune.maxChanged || 0.7)) info.reason = '變更區域超過 70%';
      else {
        progress(onProgress, '合成（未變動區域保留原解析度）');
        corrected = colorCorrected(img, an.offsets);
        out = composeChanged(imageCanvas, corrected || img, an.alphaCanvas, an.tf);
        info.composited = true;
      }
      if (info.reason) log(opts, '不做局部合成：' + info.reason);
    }
    if (!out) {
      progress(onProgress, '放大回原尺寸');
      out = stretchTo(img, W, H);
    }
    if (debug) info.raw = stretchTo(img, imgW(img), imgH(img));
  } finally {
    release(corrected);
    if (an) release(an.alphaCanvas);
    closeImg(img);
  }
  info.ms = Math.round(now() - t0);
  out.__geminiInfo = info;
  progress(onProgress, '完成', 1, 1);
  return out;
}

// ---------- 塗抹模式（遮罩） ----------
function maskBBox(mask) {
  const s = Math.min(1, 512 / Math.max(mask.width, mask.height));
  const c = mk(mask.width * s, mask.height * s);
  const g = ctx2d(c, { willReadFrequently: true });
  g.drawImage(mask, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (d[(y * c.width + x) * 4] > 60) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  release(c);
  if (x1 < 0) return null;
  return {
    x: Math.max(0, Math.floor(x0 / s) - 2), y: Math.max(0, Math.floor(y0 / s) - 2),
    x2: Math.min(mask.width, Math.ceil((x1 + 1) / s) + 2), y2: Math.min(mask.height, Math.ceil((y1 + 1) / s) + 2),
  };
}

// 白色(R>127)→不透明白、其他→透明，輸出裁切區域
function alphaMask(mask, r) {
  const c = mk(r.w, r.h);
  const g = ctx2d(c, { willReadFrequently: true });
  g.drawImage(mask, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  const im = g.getImageData(0, 0, r.w, r.h);
  const d = im.data;
  for (let i = 0; i < d.length; i += 4) { const on = d[i] > 127; d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = on ? 255 : 0; }
  g.putImageData(im, 0, 0);
  return c;
}

// 擴張 + 羽化（不依賴 ctx.filter，iOS 相容）
function dilateFeather(alpha, grow, feather) {
  const w = alpha.width, h = alpha.height;
  const out = mk(w, h);
  const g = ctx2d(out);
  g.drawImage(alpha, 0, 0);
  for (let a = 0; a < 16; a++) {
    const dx = Math.cos(a * Math.PI / 8) * grow, dy = Math.sin(a * Math.PI / 8) * grow;
    g.drawImage(alpha, dx, dy);
  }
  const f = Math.max(2, feather);
  const sw = Math.max(1, Math.round(w / f)), sh = Math.max(1, Math.round(h / f));
  const small = mk(sw, sh);
  const sg = ctx2d(small);
  sg.imageSmoothingQuality = 'high';
  sg.drawImage(out, 0, 0, sw, sh);
  release(out);
  const res = mk(w, h);
  const rg = ctx2d(res);
  rg.imageSmoothingQuality = 'high';
  rg.drawImage(small, 0, 0, w, h);
  release(small);
  return res;
}

function paintMagenta(crop, alphaCrop) {
  const c = mk(crop.width, crop.height);
  const g = ctx2d(c);
  g.drawImage(crop, 0, 0);
  const tint = mk(crop.width, crop.height);
  const tg = ctx2d(tint);
  tg.drawImage(alphaCrop, 0, 0);
  tg.globalCompositeOperation = 'source-in';
  tg.fillStyle = '#ff00ff';
  tg.fillRect(0, 0, tint.width, tint.height);
  g.drawImage(tint, 0, 0);
  release(tint);
  return c;
}

/**
 * 塗抹模式：只移除遮罩（白色）區域，結果只貼回遮罩區域（擴張＋羽化），其他保持原解析度。
 * opts 同 declutterGemini（apiKey, prompt, onProgress, signal, quality, onLog, model）
 */
export async function inpaintGemini(imageCanvas, maskCanvas, opts = {}) {
  const { apiKey, prompt, onProgress, signal, quality } = opts;
  const t0 = now();
  if (!apiKey) throw gErr('BAD_KEY', '尚未設定 Gemini API 金鑰。');
  checkAbort(signal);
  const W = imageCanvas.width, H = imageCanvas.height;
  progress(onProgress, '分析塗抹範圍');
  const bb = maskBBox(maskCanvas);
  if (!bb) throw gErr('BAD_REQUEST', '請先用手指塗抹要移除的雜物。');

  const bw = bb.x2 - bb.x, bh = bb.y2 - bb.y;
  const pad = Math.max(bw, bh) * 0.6 + Math.max(W, H) * 0.03;
  let r = {
    x: Math.max(0, Math.floor(bb.x - pad)), y: Math.max(0, Math.floor(bb.y - pad)),
    x2: Math.min(W, Math.ceil(bb.x2 + pad)), y2: Math.min(H, Math.ceil(bb.y2 + pad)),
  };
  if ((r.x2 - r.x) * (r.y2 - r.y) > 0.6 * W * H) r = { x: 0, y: 0, x2: W, y2: H };
  r.w = r.x2 - r.x; r.h = r.y2 - r.y;

  const crop = mk(r.w, r.h);
  ctx2d(crop).drawImage(imageCanvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  const alphaFull = alphaMask(maskCanvas, r);

  const size = sizeFor(quality);
  const MAXSIDE = 2048;
  const sendClean = scaled(crop, MAXSIDE);
  release(crop);
  const sendAlpha = scaled(alphaFull, MAXSIDE);
  const sendMark = paintMagenta(sendClean, sendAlpha);
  release(sendAlpha);
  const aspect = nearestRatio(sendClean.width, sendClean.height);
  const b64a = toB64(sendClean), b64b = toB64(sendMark);
  release(sendClean, sendMark);

  progress(onProgress, '傳送給 Gemini 處理中（約 20–60 秒）');
  const text = (prompt || GEMINI_DEFAULT_PROMPT) +
    ' Output the edited version of Image 1 with exactly the same framing and aspect ratio.';
  const res0 = await callModel(apiKey, [b64a, b64b], text, aspect, size, opts);
  checkAbort(signal);

  progress(onProgress, '合成結果');
  const im = await decodeImage(res0.data, res0.mime);
  const res = mk(r.w, r.h);
  const rg = ctx2d(res);
  rg.imageSmoothingEnabled = true;
  rg.imageSmoothingQuality = 'high';
  rg.drawImage(im, 0, 0, r.w, r.h);
  closeImg(im);

  const grow = Math.max(2, Math.round(Math.max(r.w, r.h) / 300));
  const soft = dilateFeather(alphaFull, grow, Math.max(4, Math.round(Math.max(r.w, r.h) / 150)));
  release(alphaFull);
  rg.globalCompositeOperation = 'destination-in';
  rg.drawImage(soft, 0, 0);
  release(soft);

  const out = mk(W, H);
  const og = ctx2d(out);
  og.drawImage(imageCanvas, 0, 0);
  og.drawImage(res, r.x, r.y);
  release(res);
  out.__geminiInfo = { model: res0.model, endpoint: res0.endpoint, changedRatio: (r.w * r.h) / (W * H), composited: true, ms: Math.round(now() - t0) };
  progress(onProgress, '完成', 1, 1);
  return out;
}

/** 測試金鑰（只能驗證金鑰有效；是否開通付費要實際產圖才知道） */
export async function testGeminiKey(apiKey) {
  if (!apiKey || !apiKey.trim()) return { ok: false, code: 'BAD_KEY', message: '請先貼上 API 金鑰。' };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(`${API_ROOT}/v1beta/models?pageSize=1`, { headers: { 'x-goog-api-key': apiKey.trim() }, signal: ctl.signal });
    clearTimeout(t);
    if (res.ok) return { ok: true, message: '金鑰有效。注意：圖像編輯沒有免費額度，需在 Google AI Studio 綁定付費帳戶（2K 每張約 US$0.05）。' };
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) {}
    const e = classifyHttp(res.status, body, text);
    return { ok: false, code: e.code, message: e.message, detail: e.detail };
  } catch (e) {
    clearTimeout(t);
    if (e && e.name === 'AbortError') return { ok: false, code: 'TIMEOUT', message: '連線逾時，請檢查網路。' };
    return { ok: false, code: 'NETWORK', message: '無法連線到 Google，請檢查網路連線。' };
  }
}
