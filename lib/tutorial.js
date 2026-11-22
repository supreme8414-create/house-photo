// lib/tutorial.js — 第一次進修圖畫面時的 3 步驟教學（可略過，按「?」可再看）
// 插圖全部用 CSS＋emoji 組成，不需要圖片檔。內容都是固定文字（非使用者輸入）。

import { pushLayer } from './ui.js';

const STEPS = [
  {
    title: '① 塗抹雜物',
    text: '用一根手指，把要移除的東西塗成紅色。\n塗錯了可以切到「橡皮擦」擦掉；兩根手指可以放大。',
    art: `
      <div class="tut-photo">
        <span class="tut-obj">📦</span>
        <span class="tut-paint"></span>
        <span class="tut-finger">👆</span>
      </div>`,
  },
  {
    title: '② 按「✨ 移除」',
    text: '塗好後按下方的「✨ 移除」，AI 會把紅色的地方變乾淨。\n不滿意可以按「復原」。',
    art: `
      <div class="tut-row">
        <div class="tut-photo small"><span class="tut-obj">📦</span><span class="tut-paint"></span></div>
        <span class="tut-arrow">→</span>
        <div class="tut-photo small clean"><span class="tut-shine">✨</span></div>
      </div>
      <div class="tut-btn">✨ 移除 <span class="tut-tap">👆</span></div>`,
  },
  {
    title: '③ 儲存',
    text: '按右上角「儲存」。原圖會一直保留，不會被蓋掉。\n存好後可以直接跳到下一張。',
    art: `
      <div class="tut-row">
        <div class="tut-btn save">儲存 <span class="tut-tap">👆</span></div>
        <span class="tut-arrow">→</span>
        <div class="tut-next">下一張 ›</div>
      </div>
      <div class="tut-check">✓ 原圖保留</div>`,
  },
];

/** 顯示教學，關閉時 resolve */
export function showTutorial() {
  return new Promise((resolve) => {
    let i = 0;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop tut-backdrop';
    const box = document.createElement('div');
    box.className = 'modal tutorial';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', '修圖教學');
    box.innerHTML = `
      <div class="tut-art" aria-hidden="true"></div>
      <h3 class="tut-title"></h3>
      <p class="modal-msg tut-text"></p>
      <div class="tut-dots" aria-hidden="true"></div>
      <div class="tut-actions">
        <button type="button" class="btn ghost tut-skip">略過</button>
        <button type="button" class="btn primary tut-next-btn">下一步</button>
      </div>`;
    backdrop.append(box);

    const art = box.querySelector('.tut-art');
    const title = box.querySelector('.tut-title');
    const text = box.querySelector('.tut-text');
    const dots = box.querySelector('.tut-dots');
    const skip = box.querySelector('.tut-skip');
    const next = box.querySelector('.tut-next-btn');

    let close = () => {};
    const finish = () => { close(); resolve(); };

    const render = () => {
      const s = STEPS[i];
      art.innerHTML = s.art; // 固定內容
      title.textContent = s.title;
      text.textContent = s.text;
      dots.innerHTML = STEPS.map((_, k) => `<span class="${k === i ? 'on' : ''}"></span>`).join('');
      const last = i === STEPS.length - 1;
      next.textContent = last ? '開始修圖' : '下一步';
      skip.hidden = last;
    };

    skip.addEventListener('click', finish);
    next.addEventListener('click', () => {
      if (i < STEPS.length - 1) { i++; render(); } else finish();
    });

    render();
    close = pushLayer(backdrop, { onEscape: finish });
    requestAnimationFrame(() => next.focus({ preventScroll: true }));
  });
}
