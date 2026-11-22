// lib/export.js — 匯出照片：分享（存到相簿 / LINE）或下載
//
// 流程：先把檔案準備好（加浮水印），再跳出對話框讓使用者「再按一次」分享。
// 原因：navigator.share 必須在使用者點擊的當下呼叫，準備檔案花的時間太久會失效。

import * as db from './db.js';
import { decodeToCanvas, drawWatermark, canvasToBlob, releaseCanvas } from './image.js';
import * as ui from './ui.js';

const WATERMARK_TEXT = '照片經整理示意';

function safeName(s) {
  return String(s || '照片').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || '照片';
}
function extOf(type) {
  if (/png/i.test(type)) return 'png';
  if (/webp/i.test(type)) return 'webp';
  if (/heic|heif/i.test(type)) return 'heic';
  return 'jpg';
}

/**
 * 準備一張要匯出的檔案
 * - 修過的照片：用修圖結果；浮水印開啟時加在右下角
 * - 沒修過的照片：直接匯出原圖（不加浮水印）
 */
export async function buildExportFile(photo, { listingName, index, watermark }) {
  const base = `${safeName(listingName)}_${String(index).padStart(2, '0')}`;
  if (photo.edited) {
    const edited = await db.getEdited(photo.id);
    if (edited) {
      let blob = edited;
      if (watermark) {
        // 浮水印直接畫在解碼出來的 canvas 上（只用一個 canvas，省記憶體）
        const { canvas } = await decodeToCanvas(edited, Infinity);
        try {
          drawWatermark(canvas, WATERMARK_TEXT);
          blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
        } finally { releaseCanvas(canvas); }
      }
      return new File([blob], `${base}_整理.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
    }
  }
  const original = await db.getOriginal(photo.id);
  if (!original) throw new Error('找不到原圖資料');
  const type = original.type || 'image/jpeg';
  return new File([original], `${base}.${extOf(type)}`, { type, lastModified: Date.now() });
}

function canShareFiles(files) {
  try {
    return !!(navigator.canShare && navigator.share && navigator.canShare({ files }));
  } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 逐張下載（不支援分享時的備案） */
export async function downloadFiles(files) {
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    await sleep(450); // 太快連續下載會被瀏覽器擋
  }
}

/**
 * 交付檔案給使用者：可以分享就顯示「分享／存到相簿」，否則下載
 */
export async function deliverFiles(files) {
  if (!files.length) return;
  const n = files.length;
  if (canShareFiles(files)) {
    let sharePromise = null;
    const choice = await ui.dialog({
      title: `已準備好 ${n} 張照片`,
      message: '按「分享／存到相簿」後：\n・選「儲存影像」可以存進手機相簿\n・選 LINE 可以直接傳給客戶或同事',
      buttons: [
        {
          label: '分享／存到相簿', value: 'share', primary: true,
          // 必須在點擊當下同步呼叫 navigator.share
          onClick: () => { sharePromise = navigator.share({ files }); },
        },
        { label: '下載檔案', value: 'download' },
        { label: '取消', value: null },
      ],
    });
    if (choice === 'share' && sharePromise) {
      try {
        await sharePromise;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // 使用者自己取消
        console.warn('分享失敗', e);
        const again = await ui.confirm('分享失敗',
          '這支手機一次無法分享這麼多張或這麼大的檔案。要改成下載嗎？', { okLabel: '改成下載' });
        if (again) { await downloadFiles(files); ui.toast('已開始下載'); }
      }
    } else if (choice === 'download') {
      await downloadFiles(files);
      ui.toast('已開始下載，請到「下載」或「檔案」裡找');
    }
    return;
  }
  const ok = await ui.confirm(`匯出 ${n} 張照片`,
    '這個瀏覽器不支援直接分享，將改用下載檔案的方式。', { okLabel: '下載' });
  if (ok) {
    await downloadFiles(files);
    ui.toast('已開始下載，請到「下載」或「檔案」裡找');
  }
}
