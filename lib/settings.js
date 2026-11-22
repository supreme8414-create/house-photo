// lib/settings.js — 使用者設定（存在 localStorage）
// localStorage 在無痕模式或被封鎖時可能丟出錯誤，所以全部包 try/catch，
// 讀不到就用預設值，寫不進去就只在這次開啟期間有效（存在記憶體）。

const PREFIX = 'hd.';
const memory = new Map(); // localStorage 不能用時的備援

function read(key, fallback) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    if (v !== null) return v;
  } catch { /* 忽略 */ }
  return memory.has(key) ? memory.get(key) : fallback;
}

function write(key, value) {
  memory.set(key, String(value));
  try { localStorage.setItem(PREFIX + key, String(value)); return true; }
  catch { return false; }
}

function remove(key) {
  memory.delete(key);
  try { localStorage.removeItem(PREFIX + key); } catch { /* 忽略 */ }
}

export const settings = {
  /** Gemini API 金鑰 */
  get apiKey() { return read('geminiKey', ''); },
  set apiKey(v) {
    const s = String(v || '').trim();
    if (s) write('geminiKey', s); else remove('geminiKey');
  },

  /** 匯出時加浮水印（預設開啟） */
  get watermark() { return read('watermark', '1') === '1'; },
  set watermark(v) { write('watermark', v ? '1' : '0'); },

  /** 預設修圖方式：'local' | 'gemini' */
  get defaultEngine() { return read('defaultEngine', 'local') === 'gemini' ? 'gemini' : 'local'; },
  set defaultEngine(v) { write('defaultEngine', v === 'gemini' ? 'gemini' : 'local'); },

  /** 是否已看過第一次開啟的合規提醒 */
  get noticeSeen() { return read('noticeSeen', '0') === '1'; },
  set noticeSeen(v) { write('noticeSeen', v ? '1' : '0'); },

  /** 是否已看過修圖教學 */
  get tutorialSeen() { return read('tutorialSeen', '0') === '1'; },
  set tutorialSeen(v) { write('tutorialSeen', v ? '1' : '0'); },

  /** 本機 AI 模型是否曾成功載入過（用來判斷要不要顯示「首次下載」字樣） */
  get modelLoadedOnce() { return read('modelLoadedOnce', '0') === '1'; },
  set modelLoadedOnce(v) { write('modelLoadedOnce', v ? '1' : '0'); },

  /** 筆刷大小（螢幕像素） */
  get brushSize() {
    const n = parseInt(read('brushSize', '44'), 10);
    return Number.isFinite(n) ? Math.min(120, Math.max(12, n)) : 44;
  },
  set brushSize(v) { write('brushSize', Math.round(v)); },
};
