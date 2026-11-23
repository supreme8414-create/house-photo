// lib/aiui.js — 「一鍵清除」相關介面：金鑰設定精靈、結果比較畫面、可取消的忙碌遮罩、費用估算
// 所有固定畫面都用 ui.pushLayer 放進圖層堆疊（與對話框共用）。

import * as ui from './ui.js';
import * as eng from './engines.js';
import { settings } from './settings.js';
import { showError } from './errors.js';

export const TWD_PER_USD = 32;
export const DEFAULT_PRICE_USD = 0.055;
export const AI_DISCLAIMER = 'AI 不會也不應移除壁癌、漏水、裂縫等瑕疵，請檢查結果';
const KEY_URL = 'https://aistudio.google.com/apikey';

// ---------------- 費用 ----------------
let priceCache = null;
/** 每張圖片的美金價格（引擎沒提供就用 0.04） */
export async function priceUSD() {
  if (priceCache) return priceCache;
  try {
    const g = await eng.getGeminiEngine();
    const p = g && g.GEMINI_PRICE_PER_IMAGE_USD;
    if (typeof p === 'number' && p > 0) { priceCache = p; return p; }
  } catch { /* 用預設 */ }
  return DEFAULT_PRICE_USD;
}

/** 台幣金額文字：小於 10 顯示一位小數 */
export function fmtTWD(n) {
  return n < 10 ? (Math.round(n * 10) / 10).toFixed(1) : String(Math.round(n));
}

export function recordUsage(n = 1) { settings.addUsage(n); }

/** 還要處理 n 張，是否超過每月上限？超過就詢問。可以繼續回傳 true */
export async function capOk(n = 1) {
  const cap = settings.monthlyCap;
  if (!cap) return true;
  const used = settings.usageThisMonth;
  if (used + n <= cap) return true;
  return ui.confirm('已超過每月上限',
    `你設定每月最多 ${cap} 張，本月已用 ${used} 張。\n要繼續嗎？`, { okLabel: '繼續' });
}

/** 設定頁的用量文字 */
export async function usageText() {
  const n = settings.usageThisMonth;
  const usd = await priceUSD();
  return `本月已用 ${n} 張，約 NT$${fmtTWD(n * usd * TWD_PER_USD)}（估算，以 Google 帳單為準）`;
}

// ---------------- 小工具 ----------------
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function isKeyIssue(e) {
  const c = e && e.code;
  return c === 'BAD_KEY' || c === 'NO_BILLING';
}

/**
 * 可取消的忙碌遮罩（AI 處理時用）
 * @returns {{signal:AbortSignal, cancelled:boolean, update:(text:string, ratio?:number|null)=>void, close:()=>void}}
 */
export function cancelableBusy(text, { cancelLabel = '取消' } = {}) {
  const ac = new AbortController();
  const backdrop = h('div', 'busy-backdrop');
  const box = h('div', 'busy-box wide');
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  const spin = h('div', 'spinner');
  spin.setAttribute('aria-hidden', 'true');
  const p = h('p', 'busy-text', text);
  const prog = h('div', 'progress indeterminate');
  const bar = h('div', 'progress-bar');
  prog.append(bar);
  const cancel = h('button', 'btn', cancelLabel);
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    if (ac.signal.aborted) return;
    ac.abort();
    cancel.disabled = true;
    p.textContent = '取消中…';
  });
  box.append(spin, p, prog, cancel);
  backdrop.append(box);
  const close = ui.pushLayer(backdrop);
  return {
    signal: ac.signal,
    get cancelled() { return ac.signal.aborted; },
    update(t, ratio = null) {
      if (ac.signal.aborted) return;
      if (t) p.textContent = t;
      prog.classList.toggle('indeterminate', ratio == null);
      bar.style.width = ratio == null ? '' : Math.round(Math.min(1, Math.max(0, ratio)) * 100) + '%';
    },
    close,
  };
}

/** 金鑰／帳單問題的專屬說明。已處理回傳 true */
export async function keyIssueDialog(e) {
  if (!isKeyIssue(e)) return false;
  const billing = e.code === 'NO_BILLING';
  const v = await showError(billing ? '還沒設定帳單' : '金鑰無法使用', e, {
    hint: billing
      ? '要先在 Google 設定帳單（綁定信用卡）才能產生圖片。\n到 Google AI Studio（aistudio.google.com/apikey）按「Set up billing」，或到 Google Cloud 的「帳單」頁面啟用帳單。設定好後再按一次。'
      : '請重新取得金鑰，或按下面的按鈕看設定教學。',
    buttons: [
      { label: '看設定教學', value: 'wizard', primary: true },
      { label: '關閉', value: null },
    ],
  });
  if (v === 'wizard') await keyWizard({ billing });
  return true;
}

/** Gemini 失敗的統一顯示 */
export async function geminiFailure(title, e) {
  if (e && e.name === 'AbortError') return;
  if (await keyIssueDialog(e)) return;
  await showError(title, e);
}

// ---------------- 金鑰設定精靈 ----------------
const WIZARD_HTML = `
  <div class="wiz-top">
    <h2>設定 Gemini 金鑰</h2>
    <button type="button" class="icon-btn wiz-close" aria-label="關閉">✕</button>
  </div>
  <div class="wiz-body">
    <p class="wiz-intro">只要設定一次，約 3 分鐘。跟著下面 4 步做就好。</p>
    <div class="wiz-step"><span class="wiz-num">1</span><div>
      <b>打開 Google AI Studio</b>
      <p>按下面的按鈕，會開新分頁（網址 aistudio.google.com/apikey）。</p>
      <button type="button" class="btn primary wiz-open">打開 Google AI Studio</button>
    </div></div>
    <div class="wiz-step"><span class="wiz-num">2</span><div>
      <b>用 Google 帳號登入</b>
      <p>登入後按「Create API key」（建立金鑰）。</p>
    </div></div>
    <div class="wiz-step"><span class="wiz-num">3</span><div>
      <b>第一次要「設定帳單」</b>
      <p>要綁定信用卡才能產生圖片（按畫面上的「Set up billing」）。用多少算多少，每張約 NT$1.5～2，不會有月費。</p>
    </div></div>
    <div class="wiz-step"><span class="wiz-num">4</span><div>
      <b>複製金鑰，回來貼上</b>
      <p>金鑰是「AIza」開頭的一長串。長按金鑰 →「拷貝」，再回到這裡貼上。</p>
      <div class="key-row">
        <input class="wiz-key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="貼上金鑰" aria-label="Gemini API 金鑰">
        <button type="button" class="btn small wiz-paste">貼上</button>
      </div>
      <div class="row-actions"><button type="button" class="btn wiz-test">測試金鑰</button></div>
      <p class="key-result wiz-result" role="status" aria-live="polite"></p>
      <div class="wiz-billing" hidden>
        <b>看起來還沒設定帳單</b>
        <p>請回到 Google AI Studio（aistudio.google.com/apikey），在你的金鑰旁按「Set up billing」綁定付款方式；或到 Google Cloud 的「帳單（Billing）」頁面，確認這個專案已啟用帳單。設定好後，回來再按一次「測試金鑰」。</p>
      </div>
    </div></div>
  </div>
  <div class="wiz-foot">
    <button type="button" class="btn primary block wiz-done" disabled>完成</button>
  </div>`;

/**
 * 金鑰設定精靈（全畫面）。金鑰測試成功並按「完成」回傳 true，中途關閉回傳 false。
 */
export function keyWizard({ billing = false } = {}) {
  return new Promise((resolve) => {
    const root = h('div', 'wizard');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '設定 Gemini 金鑰');
    root.innerHTML = WIZARD_HTML; // 固定內容，非使用者輸入
    const q = (s) => root.querySelector(s);
    const input = q('.wiz-key');
    const result = q('.wiz-result');
    const billingBox = q('.wiz-billing');
    const done = q('.wiz-done');
    const test = q('.wiz-test');
    input.value = settings.apiKey || '';
    if (billing) billingBox.hidden = false;
    let closed = false;
    let closeLayer = () => {};
    const finish = (v) => {
      if (closed) return;
      closed = true;
      closeLayer();
      resolve(v);
    };

    const setResult = (text, cls) => { result.textContent = text; result.className = 'key-result wiz-result ' + (cls || ''); };
    input.addEventListener("input", () => { done.disabled = true; setResult('', ''); });
    q('.wiz-open').addEventListener('click', () => { window.open(KEY_URL, '_blank', 'noopener,noreferrer'); });
    q('.wiz-close').addEventListener('click', () => finish(false));
    q('.wiz-paste').addEventListener('click', async () => {
      try {
        const t = (await navigator.clipboard.readText() || '').trim();
        if (t) { input.value = t; input.dispatchEvent(new Event('input')); return; }
      } catch { /* 不支援或被拒絕 */ }
      input.type = 'text';
      input.focus();
      ui.toast('請長按輸入框，選「貼上」', 3000);
    });
    done.addEventListener('click', () => finish(true));
    test.addEventListener('click', async () => {
      const k = input.value.trim();
      if (!k) { setResult('請先貼上金鑰', 'fail'); return; }
      test.disabled = true;
      setResult('測試中…', '');
      let code = '';
      let msg = '';
      let good = false;
      try {
        const g = await eng.getGeminiEngine();
        const r = await g.testGeminiKey(k);
        good = !!(r && r.ok);
        code = (r && r.code) || '';
        msg = (r && r.message) || '';
      } catch (e) {
        code = (e && e.code) || '';
        msg = eng.errorMessage(e);
      } finally {
        test.disabled = false;
      }
      const hasCJK = /[一-鿿]/.test(msg);
      if (good) {
        settings.apiKey = k;
        done.disabled = false;
        billingBox.hidden = true;
        setResult('✓ ' + (hasCJK ? msg : '金鑰可以使用，按下面「完成」'), 'ok');
        input.type = 'password';
      } else {
        const needBilling = code === 'NO_BILLING' || /帳單|billing/i.test(msg);
        if (needBilling) { settings.apiKey = k; billingBox.hidden = false; }
        setResult('✗ ' + (hasCJK ? msg : (needBilling ? '還沒設定帳單' : '金鑰無法使用，請檢查是否完整貼上')), 'fail');
      }
    });

    closeLayer = ui.pushLayer(root, { onEscape: () => finish(false) });
  });
}

// ---------------- 結果比較畫面 ----------------
/**
 * 全畫面比較「整理前／整理後」。
 * @param {object} o
 * @param {Blob} o.beforeBlob       整理前的影像
 * @param {{blob:Blob, thumb:Blob, info?:any}} o.first  第一個結果（JPEG Blob）
 * @param {() => Promise<null|{blob:Blob, thumb:Blob, info?:any}>} o.rerun  再試一次（自行處理錯誤，失敗回傳 null）
 * @param {number} [o.maxKeep=3]
 * @returns {Promise<null|{blob:Blob, info:any}>} 採用的結果；放棄回傳 null
 */
export function showCompare({ beforeBlob, first, rerun, maxKeep = 3 }) {
  return new Promise((resolve) => {
    const root = h('div', 'cmp');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '比較結果');

    const top = h('div', 'cmp-top');
    top.append(h('b', '', '看看整理的效果'), h('span', 'cmp-count'));
    const stage = h('div', 'cmp-stage');
    const after = h('img', 'cmp-img');
    const before = h('img', 'cmp-img cmp-before');
    after.alt = '整理後';
    before.alt = '整理前';
    const divider = h('div', 'cmp-divider');
    divider.hidden = true;
    const tag = h('div', 'cmp-tag', '整理後');
    stage.append(after, before, divider, tag);

    const sliderRow = h('div', 'cmp-slider-row');
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.value = '0'; slider.step = '1';
    slider.setAttribute('aria-label', '左右滑動比較整理前後');
    sliderRow.append(h('span', '', '整理後'), slider, h('span', '', '原圖'));

    const thumbs = h('div', 'cmp-thumbs');
    const note = h('p', 'cmp-note');
    const actions = h('div', 'cmp-actions');
    const holdBtn = h('button', 'btn cmp-hold', '按住看原圖');
    const retryBtn = h('button', 'btn', '再試一次');
    const adoptBtn = h('button', 'btn primary', '採用');
    const dropBtn = h('button', 'btn ghost', '放棄');
    for (const b of [holdBtn, retryBtn, adoptBtn, dropBtn]) b.type = 'button';
    const row1 = h('div', 'cmp-row'); row1.append(holdBtn, retryBtn);
    const row2 = h('div', 'cmp-row'); row2.append(dropBtn, adoptBtn);
    actions.append(row1, row2);
    root.append(top, stage, sliderRow, thumbs, note, actions);

    const beforeUrl = URL.createObjectURL(beforeBlob);
    before.src = beforeUrl;
    /** @type {{blob:Blob, thumb:Blob, info:any, url:string, turl:string}[]} */
    const results = [];
    let sel = -1;
    let holding = false;
    let busy = false;
    let closed = false;
    let closeLayer = () => {};

    const pos = () => (holding ? 100 : Number(slider.value));
    function applyPos() {
      const p = pos();
      before.style.clipPath = `inset(0 ${100 - p}% 0 0)`;
      before.style.visibility = p <= 0 ? 'hidden' : 'visible';
      divider.hidden = p <= 0 || p >= 100;
      divider.style.left = p + '%';
      tag.textContent = p >= 100 ? '原圖' : (p <= 0 ? '整理後' : '左：原圖　右：整理後');
    }
    slider.addEventListener('input', applyPos);

    function renderNote() {
      const r = results[sel];
      const parts = [AI_DISCLAIMER + '。'];
      const cr = r && r.info && typeof r.info.changedRatio === 'number' ? r.info.changedRatio : null;
      if (cr != null && cr >= 0.4) parts.push('這次 AI 改動的範圍比較大，請特別仔細檢查。');
      note.textContent = parts.join('\n');
    }

    function renderThumbs() {
      thumbs.replaceChildren();
      results.forEach((r, i) => {
        const b = h('button', 'cmp-thumb' + (i === sel ? ' on' : ''));
        b.type = 'button';
        b.setAttribute('aria-label', `第 ${i + 1} 個結果`);
        const im = document.createElement('img');
        im.alt = '';
        im.src = r.turl;
        b.append(im);
        b.addEventListener('click', () => { if (!busy) select(i); });
        thumbs.append(b);
      });
      root.querySelector('.cmp-count').textContent = results.length > 1 ? `第 ${sel + 1}／${results.length} 個結果` : '';
    }

    function select(i) {
      sel = i;
      after.src = results[i].url;
      renderThumbs();
      renderNote();
    }

    function add(r) {
      results.push({ blob: r.blob, thumb: r.thumb, info: r.info || null, url: URL.createObjectURL(r.blob), turl: URL.createObjectURL(r.thumb) });
      // 最多保留 maxKeep 個：丟掉最舊且不是正在看的
      while (results.length > maxKeep) {
        const drop = results.findIndex((_, i) => i !== results.length - 1);
        const [d] = results.splice(drop, 1);
        URL.revokeObjectURL(d.url); URL.revokeObjectURL(d.turl);
      }
      select(results.length - 1);
    }

    function cleanup() {
      closed = true;
      after.removeAttribute('src');
      before.removeAttribute('src');
      for (const r of results) { URL.revokeObjectURL(r.url); URL.revokeObjectURL(r.turl); }
      URL.revokeObjectURL(beforeUrl);
      closeLayer();
    }

    // 按住看原圖
    const holdStart = (e) => {
      e.preventDefault();
      try { if (e.pointerId !== undefined) holdBtn.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      holding = true; holdBtn.classList.add('pressed'); applyPos();
    };
    const holdEnd = () => { holding = false; holdBtn.classList.remove('pressed'); applyPos(); };
    holdBtn.addEventListener('pointerdown', holdStart);
    holdBtn.addEventListener('pointerup', holdEnd);
    holdBtn.addEventListener('pointercancel', holdEnd);
    holdBtn.addEventListener('lostpointercapture', holdEnd);
    holdBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    holdBtn.addEventListener('keydown', (e) => { if (e.key === ' ' && !e.repeat) holdStart(e); });
    holdBtn.addEventListener('keyup', (e) => { if (e.key === ' ') holdEnd(); });

    retryBtn.addEventListener('click', async () => {
      if (busy || closed) return;
      busy = true;
      try {
        const r = await rerun();
        if (r && !closed) add(r);
      } catch (e) {
        console.error(e);
      } finally {
        busy = false;
      }
    });

    adoptBtn.addEventListener('click', () => {
      if (busy || closed || sel < 0) return;
      const r = results[sel];
      const out = { blob: r.blob, info: r.info };
      cleanup();
      resolve(out);
    });

    const discard = async () => {
      if (busy || closed) return;
      const okDrop = await ui.confirm('放棄這些結果？', '已經用掉的費用不會退回。', { okLabel: '放棄', cancelLabel: '繼續看' });
      if (!okDrop || closed) return;
      cleanup();
      resolve(null);
    };
    dropBtn.addEventListener('click', discard);

    add(first);
    applyPos();
    closeLayer = ui.pushLayer(root, { onEscape: discard });
  });
}
