// lib/ui.js — 共用介面元件：對話框、選單、輸入框、提示訊息、忙碌遮罩
// 所有使用者內容（例如案件名稱）一律用 textContent 放入，避免 HTML 注入。
//
// 圖層堆疊：對話框、忙碌遮罩、教學都放進同一個堆疊。
//   - 後開的一定在最上面（z-index 依序遞增）
//   - 只有最上面那層可以操作（下面的設 inert）、只有它會收到 Esc
//   - 關閉時只移除「自己」那層，不會留下卡住的舊對話框

const modalRoot = () => document.getElementById('modal-root');
const toastRoot = () => document.getElementById('toast-root');

/** @type {{el:HTMLElement, onEscape:(Function|null)}[]} */
const stack = [];
let zSeq = 0;

function setInert(el, on) {
  if (!el) return;
  if (on) { el.setAttribute('inert', ''); el.setAttribute('aria-hidden', 'true'); }
  else { el.removeAttribute('inert'); el.removeAttribute('aria-hidden'); }
}

function syncAppInert() {
  setInert(document.getElementById('app'), stack.length > 0);
}

/**
 * 把一個全畫面圖層放到最上面。
 * @param {HTMLElement} el
 * @param {{onEscape?:Function|null}} [opt]
 * @returns {() => void} 關閉（移除）這一層
 */
export function pushLayer(el, { onEscape = null } = {}) {
  const prevTop = stack[stack.length - 1];
  const entry = { el, onEscape };
  el.style.zIndex = String(1000 + (++zSeq));
  stack.push(entry);
  if (prevTop) setInert(prevTop.el, true);
  modalRoot().append(el);
  syncAppInert();
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    const i = stack.indexOf(entry);
    if (i !== -1) stack.splice(i, 1);
    el.remove();
    const top = stack[stack.length - 1];
    if (top) setInert(top.el, false);
    if (!stack.length) zSeq = 0;
    syncAppInert();
  };
}

/** 目前有幾層對話框／遮罩 */
export function layerCount() { return stack.length; }

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const top = stack[stack.length - 1];
  if (top && top.onEscape) { e.preventDefault(); top.onEscape(); }
}, true);

/**
 * 顯示對話框。
 * @param {object} opt
 * @param {string} opt.title
 * @param {string} [opt.message]   純文字訊息（支援 \n 換行）
 * @param {Node}   [opt.content]   自訂內容節點（必須是程式自己建立的可信內容）
 * @param {Array<{label:string,value:any,primary?:boolean,danger?:boolean,dangerText?:boolean,onClick?:Function}>} [opt.buttons]
 *        onClick 會在「點擊當下」同步執行（Web Share 需要使用者手勢，必須在這裡呼叫）
 * @param {{value?:string, placeholder?:string, maxLength?:number}} [opt.input] 需要輸入文字時
 * @param {boolean} [opt.dismissible=true] 點背景或按 Esc 是否可關閉（回傳 null）
 * @param {boolean} [opt.sheet=false] 選單樣式
 * @param {string}  [opt.className]  額外的 class（加在 .modal 上）
 * @returns {Promise<any>} 按下的按鈕 value；有 input 時回傳 {value, text}
 */
export function dialog(opt) {
  const {
    title, message, content, input, sheet = false, dismissible = true, className = '',
    buttons = [{ label: '確定', value: true, primary: true }],
  } = opt;

  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = 'modal' + (sheet ? ' sheet' : '') + (className ? ' ' + className : '');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    if (title) {
      const h = document.createElement('h3');
      h.textContent = title;
      box.append(h);
      box.setAttribute('aria-label', title);
    }
    if (message) {
      const p = document.createElement('p');
      p.className = 'modal-msg';
      p.textContent = message;
      box.append(p);
    }
    if (content) box.append(content);

    let field = null;
    if (input) {
      field = document.createElement('input');
      field.type = 'text';
      field.className = 'modal-input';
      field.value = input.value || '';
      field.placeholder = input.placeholder || '';
      field.maxLength = input.maxLength || 60;
      field.enterKeyHint = 'done';
      box.append(field);
    }

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    let done = false;
    let close = () => {};
    const finish = (value) => {
      if (done) return;
      done = true;
      close();
      try { prevFocus && prevFocus.isConnected && prevFocus.focus && prevFocus.focus({ preventScroll: true }); } catch { /* 忽略 */ }
      resolve(input ? { value, text: field.value.trim() } : value);
    };

    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '') + (b.dangerText ? ' danger-text' : '');
      btn.textContent = b.label;
      btn.addEventListener('click', () => {
        if (b.onClick) {
          try { b.onClick(); } catch (e) { console.error(e); }
        }
        finish(b.value);
      });
      actions.append(btn);
    }
    box.append(actions);
    backdrop.append(box);

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && dismissible) finish(null);
    });
    if (field) {
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          const primary = buttons.find((b) => b.primary) || buttons[0];
          finish(primary.value);
        }
      });
    }

    close = pushLayer(backdrop, { onEscape: dismissible ? () => finish(null) : null });
    // 讓焦點進入對話框（螢幕閱讀器與鍵盤操作）
    requestAnimationFrame(() => {
      if (done) return;
      if (field) { field.focus(); field.select(); }
      else {
        const first = actions.querySelector('.btn.primary') || actions.querySelector('.btn');
        first && first.focus({ preventScroll: true });
      }
    });
  });
}

/** 簡單提示（只有「確定」） */
export function alert(title, message) {
  return dialog({ title, message, buttons: [{ label: '確定', value: true, primary: true }] });
}

/** 確認框，回傳 true/false */
export async function confirm(title, message, { okLabel = '確定', cancelLabel = '取消', danger = false } = {}) {
  const v = await dialog({
    title, message,
    buttons: [
      { label: okLabel, value: true, primary: !danger, danger },
      { label: cancelLabel, value: false },
    ],
  });
  return v === true;
}

/** 輸入框，回傳文字或 null（取消） */
export async function prompt(title, { value = '', placeholder = '', okLabel = '確定', message } = {}) {
  const r = await dialog({
    title, message,
    input: { value, placeholder },
    buttons: [
      { label: okLabel, value: true, primary: true },
      { label: '取消', value: false },
    ],
  });
  if (!r || r.value !== true) return null;
  return r.text;
}

/** 動作選單（例如照片的「⋯」） */
export function actionSheet(title, actions) {
  return dialog({
    title, sheet: true,
    buttons: [
      ...actions.map((a) => ({ label: a.label, value: a.value, dangerText: a.danger })),
      { label: '取消', value: null },
    ],
  });
}

/** 短暫提示訊息 */
export function toast(message, ms = 2600) {
  const root = toastRoot();
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  root.append(el);
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 350);
  }, ms);
}

/**
 * 全畫面忙碌遮罩（匯入、匯出、儲存時用）
 * @returns {{update:(text:string)=>void, close:()=>void}}
 */
export function busy(text = '處理中…') {
  const backdrop = document.createElement('div');
  backdrop.className = 'busy-backdrop';
  backdrop.innerHTML = '<div class="busy-box" role="status" aria-live="polite"><div class="spinner" aria-hidden="true"></div><p></p></div>';
  const p = backdrop.querySelector('p');
  p.textContent = text;
  const close = pushLayer(backdrop);
  return {
    update(t) { p.textContent = t; },
    close,
  };
}
