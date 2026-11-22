// lib/image.js — 圖片解碼、縮小、縮圖、浮水印
//
// iOS Safari 記憶體注意事項：
//   - 所有 canvas 加起來有總記憶體上限（約幾百 MB），單一 canvas 上限約 16.7MP；
//     超過時 getContext() 會回傳 null。所以：工作尺寸限制在長邊 2560、用完立刻歸零。
//   - 縮圖不建立全尺寸 canvas：盡量用 createImageBitmap 直接解碼成小圖。
//
// EXIF 方向：
//   <img> 解碼在現代瀏覽器會自動轉正（naturalWidth/Height 也是轉正後尺寸），最可靠。
//   createImageBitmap 在各家瀏覽器對 EXIF 方向的處理不一致，所以只在
//   「確定不需要轉向」（JPEG 方向＝1、或 PNG）時才用它縮小解碼，其他情況退回 <img>。

/** 工作／匯入時長邊上限（591、樂屋網上架綽綽有餘） */
export const MAX_SIDE = 2560;
/** 記憶體不足時改用的較小尺寸 */
export const SMALL_SIDE = 1920;
/** 單一 canvas 像素上限（iOS 約 16.7MP，留點餘裕） */
const MAX_PIXELS = 16_000_000;

/** 帶有中文訊息、錯誤代碼與原始英文細節的錯誤 */
export function appError(message, code, detail) {
  const e = new Error(message);
  if (code) e.code = code;
  if (detail) e.detail = detail;
  return e;
}

export function createCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** 取得 2D context；拿不到（多半是記憶體不足）就丟出友善的錯誤 */
export function getCtx(canvas, opts) {
  let ctx = null;
  let cause = null;
  try { ctx = canvas.getContext('2d', opts); } catch (e) { cause = e; }
  if (!ctx) {
    throw appError(
      '手機記憶體不足，無法處理這張照片。請關閉其他 App，或把修圖器完全關掉再重新開啟。',
      'CANVAS_CONTEXT',
      `getContext('2d') returned null (canvas ${canvas.width}x${canvas.height})` + (cause ? ` — ${cause.name}: ${cause.message}` : ''),
    );
  }
  return ctx;
}

/** 釋放 canvas 記憶體（iOS 對 canvas 總記憶體有上限，用完要歸零） */
export function releaseCanvas(c) {
  if (c && c.width !== undefined) { c.width = 0; c.height = 0; }
}

/** 等比縮小到長邊 ≤ maxSide，且總像素不超過上限 */
export function fitSize(w, h, maxSide = MAX_SIDE) {
  const s = Math.min(1, maxSide / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), s };
}

function loadImg(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { img.onload = img.onerror = null; resolve({ img, url }); };
    img.onerror = () => {
      img.onload = img.onerror = null;
      URL.revokeObjectURL(url);
      reject(appError('無法讀取這張照片（格式可能不支援，請改用 JPG）', 'DECODE', `image decode failed (type=${blob && blob.type}, size=${blob && blob.size})`));
    };
    img.src = url;
  });
}

/** 用完 <img> 後釋放解碼記憶體 */
function dropImg(img, url) {
  try { URL.revokeObjectURL(url); } catch { /* 忽略 */ }
  try { img.removeAttribute('src'); } catch { /* 忽略 */ }
}

/**
 * 讀取 JPEG 的 EXIF 方向。
 * @returns {Promise<number>} 1–8；PNG 回傳 1；其他格式或讀不到回傳 0（未知）
 */
export async function imageOrientation(blob) {
  try {
    const dv = new DataView(await blob.slice(0, 131072).arrayBuffer());
    if (dv.byteLength >= 8 && dv.getUint32(0) === 0x89504E47) return 1; // PNG
    if (dv.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return 0;      // 不是 JPEG
    let off = 2;
    while (off + 4 <= dv.byteLength) {
      const marker = dv.getUint16(off);
      if ((marker & 0xFF00) !== 0xFF00) return 1;
      if (marker === 0xFFDA) break; // 影像資料開始，沒有 EXIF
      const len = dv.getUint16(off + 2);
      if (marker === 0xFFE1 && off + 10 <= dv.byteLength && dv.getUint32(off + 4) === 0x45786966) {
        const tiff = off + 10;
        const little = dv.getUint16(tiff) === 0x4949;
        const g16 = (p) => dv.getUint16(p, little);
        const g32 = (p) => dv.getUint32(p, little);
        const ifd = tiff + g32(tiff + 4);
        const n = g16(ifd);
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (e + 10 > dv.byteLength) break;
          if (g16(e) === 0x0112) return g16(e + 8) || 1;
        }
        return 1;
      }
      off += 2 + len;
    }
    return 1;
  } catch { return 0; }
}

/**
 * 用 createImageBitmap 直接解碼成指定大小（省記憶體，不經過全尺寸 canvas）。
 * 不支援、或方向不確定時回傳 null，由呼叫端改用 <img>。
 */
async function bitmapScaled(blob, w, h, quality = 'medium') {
  if (typeof createImageBitmap !== 'function') return null;
  if ((await imageOrientation(blob)) !== 1) return null;
  let bmp = null;
  try {
    bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: quality });
    if (bmp.width !== w || bmp.height !== h) { bmp.close(); return null; }
    return bmp;
  } catch {
    if (bmp) { try { bmp.close(); } catch { /* 忽略 */ } }
    return null;
  }
}

/** 把 blob（或已載入的 img）畫成 w×h 的 canvas */
async function renderScaled(blob, img, w, h, quality) {
  const c = createCanvas(w, h);
  try {
    const ctx = getCtx(c);
    const bmp = await bitmapScaled(blob, w, h, quality);
    if (bmp) {
      try { ctx.drawImage(bmp, 0, 0); } finally { bmp.close(); }
    } else {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
    }
    return c;
  } catch (e) {
    releaseCanvas(c);
    throw e;
  }
}

/**
 * Blob → canvas（已轉正方向；長邊超過 maxSide 時等比縮小）
 * @returns {Promise<{canvas:HTMLCanvasElement, width:number, height:number, scaled:boolean, srcWidth:number, srcHeight:number}>}
 */
export async function decodeToCanvas(blob, maxSide = MAX_SIDE) {
  if (!blob) throw appError('找不到照片資料', 'NO_DATA');
  const { img, url } = await loadImg(blob);
  try {
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    if (!w0 || !h0) throw appError('無法讀取這張照片', 'DECODE', 'naturalWidth/naturalHeight is 0');
    const { w, h, s } = fitSize(w0, h0, maxSide);
    const canvas = await renderScaled(blob, img, w, h, 'high');
    return { canvas, width: w, height: h, scaled: s < 1, srcWidth: w0, srcHeight: h0 };
  } finally {
    dropImg(img, url);
  }
}

/** canvas → Blob */
export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b)
        : reject(appError('圖片轉檔失敗（可能是手機記憶體不足），請關閉其他 App 後再試。', 'CANVAS_MEMORY',
          `toBlob returned null (canvas ${canvas.width}x${canvas.height})`))), type, quality);
    } catch (e) { reject(e); }
  });
}

/** 從（已縮小的）工作 canvas 產生縮圖（長邊 400px，JPEG） */
export async function makeThumb(source, size = 400) {
  const { w, h } = fitSize(source.width, source.height, size);
  const c = createCanvas(w, h);
  try {
    const ctx = getCtx(c);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    return await canvasToBlob(c, 'image/jpeg', 0.8);
  } finally { releaseCanvas(c); }
}

/**
 * 匯入一張照片：轉正、太大就縮到 2560、產生縮圖。
 * 沒縮小且是常見格式時直接保留原始檔（畫質不損失），縮圖直接從檔案小尺寸解碼。
 * @param {File|Blob} file
 * @returns {Promise<{original:Blob, thumb:Blob, width:number, height:number}>}
 */
export async function importPhotoFile(file) {
  const { img, url } = await loadImg(file);
  try {
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    if (!w0 || !h0) throw appError('無法讀取這張照片', 'DECODE', 'naturalWidth/naturalHeight is 0');
    const { w, h, s } = fitSize(w0, h0, MAX_SIDE);
    const keepAsIs = s >= 1 && /^image\/(jpeg|png|webp)$/i.test(file.type || '');

    if (keepAsIs) {
      // 不建立全尺寸 canvas，縮圖直接解碼成小圖
      const t = fitSize(w0, h0, 400);
      const tc = await renderScaled(file, img, t.w, t.h, 'medium');
      try {
        const thumb = await canvasToBlob(tc, 'image/jpeg', 0.8);
        return { original: file.slice(0, file.size, file.type), thumb, width: w0, height: h0 };
      } finally { releaseCanvas(tc); }
    }

    const c = await renderScaled(file, img, w, h, 'high');
    try {
      const original = await canvasToBlob(c, 'image/jpeg', 0.92);
      const thumb = await makeThumb(c);
      return { original, thumb, width: w, height: h };
    } finally { releaseCanvas(c); }
  } finally {
    dropImg(img, url);
  }
}

/** 直接在 canvas 上加浮水印（右下角小字），不另外建立 canvas（省記憶體） */
export function drawWatermark(canvas, text = '照片經整理示意') {
  const w = canvas.width, h = canvas.height;
  const ctx = getCtx(canvas);
  const fs = Math.max(14, Math.round(Math.min(w, h) * 0.028));
  const pad = Math.round(fs * 0.8);
  ctx.save();
  ctx.font = `600 ${fs}px -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.lineJoin = 'round';
  // 深色描邊＋白字：白牆、深色地板都看得清楚
  ctx.lineWidth = Math.max(2, fs * 0.16);
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.strokeText(text, w - pad, h - pad);
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.fillText(text, w - pad, h - pad);
  ctx.restore();
  return canvas;
}

/** 加浮水印，回傳新的 canvas，不改動原本的 */
export function addWatermark(source, text = '照片經整理示意') {
  const c = createCanvas(source.width, source.height);
  try {
    getCtx(c).drawImage(source, 0, 0);
    return drawWatermark(c, text);
  } catch (e) {
    releaseCanvas(c);
    throw e;
  }
}
