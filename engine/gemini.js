/*
 * 房屋修圖器 — 強力模式：Google Gemini 圖像編輯 (Nano Banana 系列)
 *
 * 資料來源（2026-11-22 查閱）：
 *  - https://aistudio.google.com/docs/image-generation  (ai.google.dev/gemini-api/docs/image-generation 301 轉址至此)
 *  - https://aistudio.google.com/docs/pricing
 *  - https://ai.google.dev/gemini-api/docs/migrate-to-interactions
 *
 * 模型 ID（官方文件列出）：
 *   gemini-nano-banana-2.1      Nano Banana 2.1（文件建議的主力；1K $0.0336 / 2K $0.0504 / 4K $0.113 每張）
 *   gemini-3.1-flash-lite-image Nano Banana 2 Lite（最快最便宜 1K $0.0336）
 *   gemini-3.1-flash-image      Nano Banana 2
 *   gemini-3-pro-image          Nano Banana Pro（$0.134 1K/2K）
 *   gemini-2.5-flash-image      舊版，預計 2027-03-15 停用
 *   圖像輸出「沒有免費額度」，必須綁定付費（Billing）的 API Key。
 *
 * 端點：
 *   新版（文件主推） POST https://generativelanguage.googleapis.com/v1beta/interactions
 *       標頭 x-goog-api-key、Content-Type: application/json
 *       body {model, input:[{type:'text',text},{type:'image',mime_type,data(base64)}],
 *             response_format:{type:'image',mime_type,aspect_ratio,image_size:'1K'|'2K'|'4K'}}
 *       回傳 steps[] -> type==='model_output' -> content[] -> {type:'image', data, mime_type}
 *   舊版（官方稱「仍完整支援」） POST .../v1beta/models/{model}:generateContent
 *       body {contents:[{parts:[{text},{inlineData:{mimeType,data}}]}],
 *             generationConfig:{responseModalities:['IMAGE'], imageConfig:{aspectRatio,imageSize}}}
 *       回傳 candidates[0].content.parts[].inlineData
 *   本檔先走新版，若不行（404/網路被 CORS 擋/參數不接受）自動退回舊版。兩種回傳格式都能解析。
 *
 * 注意：文件未明講瀏覽器 CORS；Google API 一般允許帶 x-goog-api-key 的瀏覽器呼叫，
 *       實機請務必測試（見 README / 回報）。可用 localStorage 'geminiModel' 覆蓋模型。
 */

export const GEMINI_DEFAULT_PROMPT =
  'Remove ONLY the objects that are covered by the bright magenta (#FF00FF) overlay in the second image. ' +
  'Fill the removed area with a realistic, seamless continuation of the surrounding floor, wall, furniture and lighting. ' +
  'Keep the perspective, lighting, colors, textures and everything else exactly identical. ' +
  'Do not add any new objects, text or people. Do not change anything outside the magenta area. Photorealistic result. ' +
  '請只移除第二張圖中洋紅色標記區域內的物品，並以周圍地板、牆面、家具自然延伸補滿，其餘維持完全不變。';

const DECLUTTER_PROMPT =
  'This is a real-estate listing photo. Remove small movable clutter only: shoes, clothes, bags, cables, bottles, papers, ' +
  'trash bins, loose household items. Keep all furniture, fixtures, walls, windows, outside views and any building defects ' +
  '(wall cracks, water stains, damage) EXACTLY as they are - never hide or repair defects. ' +
  'Keep the composition, camera angle, perspective, colors and lighting identical. Photorealistic. Return the edited image only. ' +
  '請只移除可移動的小型雜物（鞋子、衣物、袋子、電線、瓶罐、紙張、垃圾桶等），家具、固定設施、牆面、窗戶、窗外景觀與任何瑕疵（壁癌、裂縫、漏水）一律保持原樣。';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-nano-banana-2.1';
const TIMEOUT_MS = 90000;
const RATIOS = [['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['3:2', 3 / 2], ['2:3', 2 / 3], ['5:4', 5 / 4], ['4:5', 4 / 5], ['16:9', 16 / 9], ['9:16', 9 / 16], ['21:9', 21 / 9]];

function getModel() {
  try { const m = localStorage.getItem('geminiModel'); if (m && m.trim()) return m.trim(); } catch (e) {}
  return DEFAULT_MODEL;
}

function progress(cb, stage, loaded = 0, total = 0) {
  try { cb && cb({ stage, loaded, total }); } catch (e) {}
}

class GeminiError extends Error {}

function mk(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
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
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function toB64(canvas, type = 'image/jpeg', q = 0.92) {
  const url = canvas.toDataURL(type, q);
  return url.slice(url.indexOf(',') + 1);
}

// ---------- API call ----------
function friendlyHttp(status, body) {
  const txt = (body && body.error && body.error.message) || '';
  if (status === 400 && /API key|API_KEY/i.test(txt)) return 'API 金鑰無效，請到設定重新貼上正確的金鑰。';
  if (status === 400 && /billing|free tier|not available/i.test(txt)) return '此金鑰沒有付費額度，圖像編輯需要綁定付費帳戶。';
  if (status === 400) return '請求被拒絕（400）：' + (txt || '參數有誤') ;
  if (status === 401 || status === 403) return 'API 金鑰沒有權限（' + status + '）。請確認金鑰正確、已啟用 Gemini API，且帳戶已啟用計費。';
  if (status === 404) return '找不到模型（404），請確認模型名稱或稍後再試。';
  if (status === 429) return '額度已用完或請求太頻繁（429），請稍後再試或檢查計費額度。';
  if (status >= 500) return 'Google 伺服器暫時忙碌（' + status + '），請稍後再試。';
  return '發生錯誤（' + status + '）' + (txt ? '：' + txt : '');
}

async function post(url, payload, apiKey, extraHeaders) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: Object.assign({ 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, extraHeaders || {}),
      body: JSON.stringify(payload),
    });
  } catch (e) {
    clearTimeout(t);
    if (e && e.name === 'AbortError') throw new GeminiError('等待逾時（90 秒），請檢查網路後重試。');
    const err = new GeminiError('無法連線到 Google，請檢查網路連線。');
    err.network = true;
    throw err;
  }
  clearTimeout(t);
  let body = null;
  try { body = await res.json(); } catch (e) {}
  if (!res.ok) {
    const err = new GeminiError(friendlyHttp(res.status, body));
    err.status = res.status;
    throw err;
  }
  return body;
}

function extractImage(body) {
  const found = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o.type === 'image' && typeof o.data === 'string') found.push({ data: o.data, mime: o.mime_type || 'image/png' });
    else if (o.inlineData && o.inlineData.data) found.push({ data: o.inlineData.data, mime: o.inlineData.mimeType || 'image/png' });
    else if (o.inline_data && o.inline_data.data) found.push({ data: o.inline_data.data, mime: o.inline_data.mime_type || 'image/png' });
    for (const k in o) if (typeof o[k] === 'object') walk(o[k]);
  };
  walk(body);
  return found.length ? found[found.length - 1] : null;
}

async function callModel(apiKey, images, text, aspect, size) {
  const model = getModel();
  let body;
  const useInteractions = true;
  if (useInteractions) {
    const input = [{ type: 'text', text }];
    for (const b64 of images) input.push({ type: 'image', mime_type: 'image/jpeg', data: b64 });
    try {
      body = await post(`${BASE}/interactions`, {
        model,
        input,
        response_format: { type: 'image', mime_type: 'image/png', aspect_ratio: aspect, image_size: size },
      }, apiKey, { 'Api-Revision': '2026-05-20' });
    } catch (e) {
      // 退回舊版 generateContent：網路/CORS 問題、404、或參數不被接受
      if (!(e.network || e.status === 404 || e.status === 400)) throw e;
      if (e.status === 400 && /API key|billing/i.test(e.message)) throw e;
      body = null;
    }
  }
  if (!body) {
    const parts = [{ text }];
    for (const b64 of images) parts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
    body = await post(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect, imageSize: size } },
    }, apiKey);
  }
  const img = extractImage(body);
  if (!img) {
    const reason = (body && body.promptFeedback && body.promptFeedback.blockReason) ||
      (body && body.candidates && body.candidates[0] && body.candidates[0].finishReason) || '';
    throw new GeminiError('Gemini 沒有回傳圖片（可能被安全機制擋下' + (reason ? '：' + reason : '') + '）。請換一張圖、縮小塗抹範圍，或稍後再試。');
  }
  return img;
}

function loadImg(b64, mime) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new GeminiError('無法解讀 Gemini 回傳的圖片。'));
    im.src = `data:${mime};base64,${b64}`;
  });
}

// ---------- mask helpers ----------
function maskBBox(mask) {
  const s = Math.min(1, 512 / Math.max(mask.width, mask.height));
  const c = mk(mask.width * s, mask.height * s);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(mask, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (d[(y * c.width + x) * 4] > 60) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  return {
    x: Math.max(0, Math.floor(x0 / s) - 2), y: Math.max(0, Math.floor(y0 / s) - 2),
    x2: Math.min(mask.width, Math.ceil((x1 + 1) / s) + 2), y2: Math.min(mask.height, Math.ceil((y1 + 1) / s) + 2),
  };
}

// 白色(R>127)→不透明白、其他→透明，輸出裁切區域
function alphaMask(mask, r) {
  const c = mk(r.w, r.h);
  const g = c.getContext('2d', { willReadFrequently: true });
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
  const g = out.getContext('2d');
  g.drawImage(alpha, 0, 0);
  for (let a = 0; a < 16; a++) {
    const dx = Math.cos(a * Math.PI / 8) * grow, dy = Math.sin(a * Math.PI / 8) * grow;
    g.drawImage(alpha, dx, dy);
  }
  // 羽化：縮小再放大形成柔邊
  const f = Math.max(2, feather);
  const sw = Math.max(1, Math.round(w / f)), sh = Math.max(1, Math.round(h / f));
  const small = mk(sw, sh);
  const sg = small.getContext('2d');
  sg.imageSmoothingQuality = 'high';
  sg.drawImage(out, 0, 0, sw, sh);
  const res = mk(w, h);
  const rg = res.getContext('2d');
  rg.imageSmoothingQuality = 'high';
  rg.drawImage(small, 0, 0, w, h);
  return res;
}

function paintMagenta(crop, alphaCrop) {
  const c = mk(crop.width, crop.height);
  const g = c.getContext('2d');
  g.drawImage(crop, 0, 0);
  const tint = mk(crop.width, crop.height);
  const tg = tint.getContext('2d');
  tg.drawImage(alphaCrop, 0, 0);
  tg.globalCompositeOperation = 'source-in';
  tg.fillStyle = '#ff00ff';
  tg.fillRect(0, 0, tint.width, tint.height);
  g.drawImage(tint, 0, 0);
  return c;
}

// ---------- public API ----------
export async function inpaintGemini(imageCanvas, maskCanvas, { apiKey, prompt, onProgress } = {}) {
  if (!apiKey) throw new GeminiError('尚未設定 Gemini API 金鑰。');
  const W = imageCanvas.width, H = imageCanvas.height;
  progress(onProgress, '分析塗抹範圍');
  const bb = maskBBox(maskCanvas);
  if (!bb) throw new GeminiError('請先用手指塗抹要移除的雜物。');

  // 裁切區域：加上周圍脈絡
  const bw = bb.x2 - bb.x, bh = bb.y2 - bb.y;
  const pad = Math.max(bw, bh) * 0.6 + Math.max(W, H) * 0.03;
  let r = {
    x: Math.max(0, Math.floor(bb.x - pad)), y: Math.max(0, Math.floor(bb.y - pad)),
    x2: Math.min(W, Math.ceil(bb.x2 + pad)), y2: Math.min(H, Math.ceil(bb.y2 + pad)),
  };
  if ((r.x2 - r.x) * (r.y2 - r.y) > 0.6 * W * H) r = { x: 0, y: 0, x2: W, y2: H };
  r.w = r.x2 - r.x; r.h = r.y2 - r.y;

  const crop = mk(r.w, r.h);
  crop.getContext('2d').drawImage(imageCanvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  const alphaFull = alphaMask(maskCanvas, r);

  const MAXSIDE = 1536;
  const sendClean = scaled(crop, MAXSIDE);
  const sendAlpha = scaled(alphaFull, MAXSIDE);
  const sendMark = paintMagenta(sendClean, sendAlpha);

  const aspect = nearestRatio(sendClean.width, sendClean.height);
  const size = Math.max(sendClean.width, sendClean.height) > 1100 ? '2K' : '1K';
  progress(onProgress, '傳送給 Gemini 處理中（約 10–40 秒）');
  const text = (prompt || GEMINI_DEFAULT_PROMPT) +
    ' Image 1 is the clean original. Image 2 is the same photo with the area to remove painted in magenta. Output the edited version of Image 1 with the same framing and aspect ratio.';
  const img = await callModel(apiKey, [toB64(sendClean), toB64(sendMark)], text, aspect, size);

  progress(onProgress, '合成結果');
  const im = await loadImg(img.data, img.mime);
  // 還原至裁切尺寸（長寬比已盡量匹配，輕微差異以拉伸補償）
  const res = mk(r.w, r.h);
  const rg = res.getContext('2d');
  rg.imageSmoothingQuality = 'high';
  rg.drawImage(im, 0, 0, r.w, r.h);

  const grow = Math.max(2, Math.round(Math.max(r.w, r.h) / 300));
  const soft = dilateFeather(alphaFull, grow, Math.max(4, Math.round(Math.max(r.w, r.h) / 150)));
  rg.globalCompositeOperation = 'destination-in';
  rg.drawImage(soft, 0, 0);

  const out = mk(W, H);
  const og = out.getContext('2d');
  og.drawImage(imageCanvas, 0, 0);
  og.drawImage(res, r.x, r.y);
  progress(onProgress, '完成', 1, 1);
  return out;
}

export async function declutterGemini(imageCanvas, { apiKey, prompt, onProgress } = {}) {
  if (!apiKey) throw new GeminiError('尚未設定 Gemini API 金鑰。');
  const W = imageCanvas.width, H = imageCanvas.height;
  progress(onProgress, '準備圖片');
  const send = scaled(imageCanvas, 2048);
  const aspect = nearestRatio(W, H);
  const size = Math.max(send.width, send.height) > 1100 ? '2K' : '1K';
  progress(onProgress, '傳送給 Gemini 處理中（約 10–40 秒）');
  const img = await callModel(apiKey, [toB64(send)], prompt || DECLUTTER_PROMPT, aspect, size);
  progress(onProgress, '放大回原尺寸');
  const im = await loadImg(img.data, img.mime);
  const out = mk(W, H);
  const g = out.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(im, 0, 0, W, H);
  progress(onProgress, '完成', 1, 1);
  return out;
}

export async function testGeminiKey(apiKey) {
  if (!apiKey || !apiKey.trim()) return { ok: false, message: '請先貼上 API 金鑰。' };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(`${BASE}/models?pageSize=1`, { headers: { 'x-goog-api-key': apiKey.trim() }, signal: ctl.signal });
    clearTimeout(t);
    if (res.ok) return { ok: true, message: '金鑰有效。注意：圖像編輯需綁定付費帳戶（無免費額度）。' };
    let body = null;
    try { body = await res.json(); } catch (e) {}
    return { ok: false, message: friendlyHttp(res.status, body) };
  } catch (e) {
    clearTimeout(t);
    if (e && e.name === 'AbortError') return { ok: false, message: '連線逾時，請檢查網路。' };
    return { ok: false, message: '無法連線到 Google，請檢查網路連線。' };
  }
}
