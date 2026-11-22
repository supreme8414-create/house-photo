// lib/errors.js — 使用者看得懂、也能回報的錯誤對話框
//
// showError()：顯示中文訊息；下方有「顯示技術資訊」可展開，裡面有原始英文細節、
// 裝置資訊、照片尺寸、AI 引擎資訊，並提供「複製錯誤資訊」按鈕，方便貼給開發者。
// installGlobalHandlers()：沒被接住的錯誤也用同一個對話框顯示（有頻率限制）。

import * as ui from './ui.js';
import { errorMessage, errorDetail, isMemoryError } from './engines.js';

const cfg = {
  appVersion: '',
  /** @type {() => Record<string, any>} 額外的狀態資訊（畫面、照片尺寸、引擎…） */
  context: () => ({}),
};

export function configureErrors(c) { Object.assign(cfg, c || {}); }

export const MEMORY_HINT = '建議：關閉其他 App，或把修圖器完全關掉（從多工畫面往上滑）再重新開啟。';

/** 組合技術資訊文字 */
export function techInfo(err, extra = {}) {
  const lines = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '') lines.push(`${k}：${v}`); };
  add('時間', new Date().toLocaleString('zh-TW', { hour12: false }));
  add('App 版本', cfg.appVersion);
  add('錯誤代碼', (err && err.code) || (err && err.name) || '');
  add('中文訊息', errorMessage(err));
  const detail = errorDetail(err);
  if (detail) lines.push('原始錯誤：\n' + detail);
  const stack = (err && (err.originalStack || err.stack)) || '';
  if (stack) lines.push('堆疊：\n' + String(stack).split('\n').slice(0, 8).join('\n'));
  let ctx = {};
  try { ctx = cfg.context() || {}; } catch { /* 忽略 */ }
  for (const [k, v] of Object.entries({ ...ctx, ...extra })) add(k, v);
  add('裝置', navigator.userAgent);
  try {
    add('螢幕', `${screen.width}×${screen.height} @${window.devicePixelRatio || 1}x，視窗 ${window.innerWidth}×${window.innerHeight}`);
  } catch { /* 忽略 */ }
  if (navigator.deviceMemory) add('裝置記憶體', navigator.deviceMemory + ' GB');
  try {
    const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    add('開啟方式', standalone || navigator.standalone ? '主畫面 App' : '瀏覽器');
  } catch { /* 忽略 */ }
  return lines.join('\n');
}

async function copyText(text, textarea) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 改用備案 */ }
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (document.execCommand && document.execCommand('copy')) return true;
  } catch { /* 忽略 */ }
  return false;
}

/** 「顯示技術資訊」展開區塊 */
function techBlock(err, extra) {
  const info = techInfo(err, extra);
  const det = document.createElement('details');
  det.className = 'tech';
  const sum = document.createElement('summary');
  sum.textContent = '顯示技術資訊';
  const note = document.createElement('p');
  note.className = 'tech-note';
  note.textContent = '如果問題一直發生，請按「複製錯誤資訊」，再貼到 LINE 傳給開發者。';
  const ta = document.createElement('textarea');
  ta.className = 'tech-text';
  ta.readOnly = true;
  ta.rows = 8;
  ta.value = info;
  const row = document.createElement('div');
  row.className = 'tech-row';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn small';
  btn.textContent = '複製錯誤資訊';
  const status = document.createElement('span');
  status.className = 'tech-status';
  status.setAttribute('role', 'status');
  btn.addEventListener('click', async () => {
    const ok = await copyText(info, ta);
    status.textContent = ok ? '✓ 已複製' : '請長按上方文字 →「全選」→「拷貝」';
    if (ok) ui.toast('已複製錯誤資訊，可以貼到 LINE 了');
  });
  row.append(btn, status);
  det.append(sum, note, ta, row);
  return det;
}

/**
 * 顯示錯誤對話框
 * @param {string} title 標題（中文）
 * @param {any} err
 * @param {{hint?:string, buttons?:Array, extra?:Record<string,any>}} [opt]
 *   hint：補充建議（不給時，記憶體錯誤會自動加上建議）
 * @returns {Promise<any>} 按下的按鈕 value
 */
export function showError(title, err, { hint, buttons, extra } = {}) {
  try { console.error(title, err); } catch { /* 忽略 */ }
  const wrap = document.createElement('div');
  const msg = document.createElement('p');
  msg.className = 'modal-msg';
  let text = errorMessage(err);
  const h = hint !== undefined ? hint : (isMemoryError(err) ? MEMORY_HINT : '');
  if (h) text += '\n\n' + h;
  msg.textContent = text;
  wrap.append(msg, techBlock(err, extra));
  return ui.dialog({
    title: title || '發生問題',
    content: wrap,
    className: 'error-dialog',
    buttons: buttons || [{ label: '確定', value: true, primary: true }],
  });
}

// ---------------- 全域錯誤 ----------------
let lastGlobalAt = 0;
let globalOpen = false;

function ignorable(err, message) {
  const m = String((err && err.message) || message || '');
  if (/ResizeObserver loop/i.test(m)) return true;
  if (err && err.name === 'AbortError') return true;
  if (!err && /^Script error\.?$/i.test(m)) return true; // 跨網域腳本，沒有資訊可看
  return false;
}

function reportGlobal(err) {
  const now = Date.now();
  if (globalOpen || now - lastGlobalAt < 8000) { console.error('（未顯示）', err); return; }
  lastGlobalAt = now;
  globalOpen = true;
  showError('發生問題', err, {
    hint: (isMemoryError(err) ? MEMORY_HINT + '\n' : '') + '通常可以繼續使用；如果畫面怪怪的，請回上一頁或重新開啟修圖器。',
  }).finally(() => { globalOpen = false; lastGlobalAt = Date.now(); });
}

export function installGlobalHandlers() {
  window.addEventListener('error', (e) => {
    // 圖片、腳本等資源載入失敗也會觸發（target 不是 window），不打擾使用者
    if (e.target && e.target !== window) return;
    const err = e.error || null;
    if (ignorable(err, e.message)) return;
    reportGlobal(err || new Error(e.message || 'Unknown error'));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (ignorable(r && typeof r === 'object' ? r : null, r && typeof r !== 'object' ? String(r) : '')) return;
    try { e.preventDefault(); } catch { /* 忽略 */ }
    reportGlobal(r instanceof Error || (r && typeof r === 'object' && r.message) ? r : new Error(String(r)));
  });
}
