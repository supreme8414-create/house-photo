// lib/image.js — 圖片解碼、縮小、縮圖、浮水印
//
// EXIF 方向：用 <img> 解碼，現代瀏覽器（Chrome 81+、Safari 13.1+、Firefox 77+）
// 預設 image-orientation: from-image，畫到 canvas 時已自動轉正，
// naturalWidth/naturalHeight 也是轉正後的尺寸。這比 createImageBitmap 的
// imageOrientation 選項在 iOS 上更可靠。

/** 匯入時長邊上限（保護手機記憶體） */
export const MAX_SIDE = 4096;

export function createCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** 釋放 canvas 記憶體（iOS 對 canvas 總記憶體有上限，用完要歸零） */
export function releaseCanvas(c) {
  if (c && c.width !== undefined) { c.width = 0; c.height = 0; }
}

function loadImg(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('無法讀取這張照片（格式可能不支援，請改用 JPG）'));
    };
    img.src = url;
  });
}

/**
 * Blob → canvas（已轉正方向；長邊超過 maxSide 時等比縮小）
 * @returns {Promise<{canvas:HTMLCanvasElement, width:number, height:number, scaled:boolean}>}
 */
export async function decodeToCanvas(blob, maxSide = Infinity) {
  const { img, url } = await loadImg(blob);
  try {
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    if (!w0 || !h0) throw new Error('無法讀取這張照片');
    const s = Math.min(1, maxSide / Math.max(w0, h0));
    const w = Math.round(w0 * s), h = Math.round(h0 * s);
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('手機記憶體不足，無法開啟這張照片');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return { canvas: c, width: w, height: h, scaled: s < 1 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** canvas → Blob */
export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('圖片轉檔失敗（可能是記憶體不足）'))), type, quality);
    } catch (e) { reject(e); }
  });
}

/** 縮圖（長邊 400px，JPEG） */
export async function makeThumb(source, size = 400) {
  const w = source.width, h = source.height;
  const s = Math.min(1, size / Math.max(w, h));
  const c = createCanvas(w * s, h * s);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, c.width, c.height);
  try { return await canvasToBlob(c, 'image/jpeg', 0.8); }
  finally { releaseCanvas(c); }
}

/**
 * 匯入一張照片：轉正、太大就縮到 4096、產生縮圖。
 * 沒縮小且是常見格式時直接保留原始檔（畫質不損失）。
 * @param {File} file
 * @returns {Promise<{original:Blob, thumb:Blob, width:number, height:number}>}
 */
export async function importPhotoFile(file) {
  const { canvas, width, height, scaled } = await decodeToCanvas(file, MAX_SIDE);
  try {
    const keepAsIs = !scaled && /^image\/(jpeg|png|webp)$/i.test(file.type || '');
    const original = keepAsIs
      ? file.slice(0, file.size, file.type) // File → 純 Blob
      : await canvasToBlob(canvas, 'image/jpeg', 0.92);
    const thumb = await makeThumb(canvas);
    return { original, thumb, width, height };
  } finally {
    releaseCanvas(canvas);
  }
}

/**
 * 加浮水印（右下角小字），回傳新的 canvas，不改動原本的
 */
export function addWatermark(source, text = '照片經整理示意') {
  const w = source.width, h = source.height;
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.drawImage(source, 0, 0);
  const fs = Math.max(14, Math.round(Math.min(w, h) * 0.028));
  const pad = Math.round(fs * 0.8);
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
  return c;
}
